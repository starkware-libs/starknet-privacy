//! Tower middleware for transparent OHTTP decapsulation/encapsulation.
//!
//! When a request arrives with `Content-Type: message/ohttp-req`, the layer:
//! 1. Decapsulates the OHTTP envelope using the server's HPKE key
//! 2. Parses the inner Binary HTTP (RFC 9292) request
//! 3. Rebuilds an `http::Request` with the inner JSON body
//! 4. Forwards to the inner service (handler)
//! 5. Encapsulates the response as `message/ohttp-res`
//!
//! Requests with `Content-Type: application/json` (or missing) pass through
//! unchanged.

use std::future::Future;
use std::io::Cursor;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use axum::body::{Body, Bytes};
use axum::http::{header, Request, Response, StatusCode};
use http_body_util::BodyExt;
use tower::{Layer, Service};
use tracing::debug;

use crate::ohttp::gateway::OhttpGateway;

/// Errors during OHTTP request/response processing.
enum OhttpProcessingError {
    /// 422 — OHTTP decapsulation failed (bad HPKE envelope).
    DecapsulationFailed,
    /// 422 — invalid Binary HTTP format or request rebuild failure.
    InvalidFormat(&'static str),
    /// 400 — failed to read request body.
    BadRequestBody,
    /// 500 — internal error during response encapsulation.
    InternalError(&'static str),
}

impl From<OhttpProcessingError> for Response<Body> {
    fn from(error: OhttpProcessingError) -> Self {
        let (status, code, message) = match error {
            OhttpProcessingError::DecapsulationFailed => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "OHTTP_DECAPSULATION_FAILED",
                "Failed to decapsulate OHTTP request",
            ),
            OhttpProcessingError::InvalidFormat(detail) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "OHTTP_INVALID_FORMAT",
                detail,
            ),
            OhttpProcessingError::BadRequestBody => (
                StatusCode::BAD_REQUEST,
                "OHTTP_INVALID_FORMAT",
                "Failed to read request body",
            ),
            OhttpProcessingError::InternalError(detail) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", detail)
            }
        };
        let body = serde_json::json!({
            "error": { "code": code, "message": message }
        });
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }
}

/// Tower layer that conditionally applies OHTTP decapsulation/encapsulation.
#[derive(Clone)]
pub struct OhttpLayer {
    gateway: Arc<OhttpGateway>,
}

impl OhttpLayer {
    pub fn new(gateway: Arc<OhttpGateway>) -> Self {
        Self { gateway }
    }
}

impl<S> Layer<S> for OhttpLayer {
    type Service = OhttpService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        OhttpService {
            inner,
            gateway: self.gateway.clone(),
        }
    }
}

/// The Tower service wrapping the inner handler with OHTTP support.
#[derive(Clone)]
pub struct OhttpService<S> {
    inner: S,
    gateway: Arc<OhttpGateway>,
}

impl<S> Service<Request<Body>> for OhttpService<S>
where
    S: Service<Request<Body>, Response = Response<Body>> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response<Body>;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(context)
    }

    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let content_type = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        if content_type.starts_with("message/ohttp-req") {
            let gateway = self.gateway.clone();
            let mut inner = self.inner.clone();
            Box::pin(async move { handle_ohttp(request, &gateway, &mut inner).await })
        } else {
            // Pass through for application/json or any other content type.
            let future = self.inner.call(request);
            Box::pin(future)
        }
    }
}

/// Decapsulate an OHTTP request, forward the inner request, encapsulate the response.
async fn handle_ohttp<S>(
    request: Request<Body>,
    gateway: &OhttpGateway,
    inner: &mut S,
) -> Result<Response<Body>, S::Error>
where
    S: Service<Request<Body>, Response = Response<Body>>,
    S::Future: Send + 'static,
{
    // Read the full encapsulated request body.
    let encapsulated_bytes = match read_body(request).await {
        Ok(bytes) => bytes,
        Err(response) => return Ok(response),
    };

    // Decapsulate using the OHTTP server.
    let (bhttp_bytes, server_response) = match gateway.server().decapsulate(&encapsulated_bytes) {
        Ok(result) => result,
        Err(error) => {
            debug!("OHTTP decapsulation failed: {error}");
            return Ok(OhttpProcessingError::DecapsulationFailed.into());
        }
    };

    // Parse the inner Binary HTTP request.
    let bhttp_message = match bhttp::Message::read_bhttp(&mut Cursor::new(&bhttp_bytes)) {
        Ok(message) => message,
        Err(error) => {
            debug!("Invalid Binary HTTP message: {error}");
            return Ok(OhttpProcessingError::InvalidFormat("Invalid Binary HTTP message").into());
        }
    };

    // Extract the inner JSON body and rebuild as a normal HTTP request.
    let inner_request = match rebuild_request(&bhttp_message) {
        Ok(request) => request,
        Err(response) => return Ok(response),
    };

    // Forward to the actual handler.
    let inner_response = inner.call(inner_request).await?;

    // Encapsulate the response.
    let encapsulated_response = encapsulate_response(inner_response, server_response).await;
    Ok(encapsulated_response)
}

/// Read the full body from an HTTP request.
async fn read_body(request: Request<Body>) -> Result<Bytes, Response<Body>> {
    request
        .into_body()
        .collect()
        .await
        .map(|collected| collected.to_bytes())
        .map_err(|_| OhttpProcessingError::BadRequestBody.into())
}

/// Rebuild a standard `http::Request<Body>` from a parsed Binary HTTP message.
#[allow(clippy::result_large_err)]
fn rebuild_request(bhttp_message: &bhttp::Message) -> Result<Request<Body>, Response<Body>> {
    let body = bhttp_message.content().to_vec();

    let mut builder = Request::builder()
        .method("POST")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, body.len());

    // Extract path from Binary HTTP control data if available.
    if let Some(path) = bhttp_message.control().path() {
        let path_str = String::from_utf8_lossy(path);
        builder = builder.uri(path_str.as_ref());
    }

    builder.body(Body::from(body)).map_err(|error| {
        debug!("Failed to rebuild inner request: {error}");
        OhttpProcessingError::InvalidFormat("Failed to rebuild inner request").into()
    })
}

/// Encapsulate the handler's response as an OHTTP response.
async fn encapsulate_response(
    response: Response<Body>,
    server_response: ohttp::ServerResponse,
) -> Response<Body> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    // Read the response body.
    let response_body = match response.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            return OhttpProcessingError::InternalError("Failed to read response body").into()
        }
    };

    // Encode as Binary HTTP response.
    let bhttp_status = bhttp::StatusCode::try_from(u64::from(status.as_u16()))
        .unwrap_or(bhttp::StatusCode::try_from(500u64).unwrap());
    let mut bhttp_response = bhttp::Message::response(bhttp_status);
    bhttp_response.put_header("content-type", content_type.as_bytes());
    bhttp_response.write_content(&response_body);

    let mut bhttp_bytes = Vec::new();
    if let Err(error) = bhttp_response.write_bhttp(bhttp::Mode::KnownLength, &mut bhttp_bytes) {
        debug!("Failed to encode Binary HTTP response: {error}");
        return OhttpProcessingError::InternalError("Failed to encode response").into();
    }

    // Encrypt with the OHTTP server response context.
    match server_response.encapsulate(&bhttp_bytes) {
        Ok(encrypted) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "message/ohttp-res")
            .body(Body::from(encrypted))
            .unwrap(),
        Err(error) => {
            debug!("Failed to encapsulate OHTTP response: {error}");
            OhttpProcessingError::InternalError("Failed to encrypt response").into()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::io::Cursor;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{header, Request, Response, StatusCode};
    use http_body_util::BodyExt;
    use tower::{Service, ServiceExt};

    use tower::Layer;

    use crate::ohttp::gateway::OhttpGateway;
    use crate::ohttp::layer::OhttpLayer;

    fn test_gateway() -> Arc<OhttpGateway> {
        let mut ikm = [0u8; 32];
        ikm[0] = 1;
        Arc::new(OhttpGateway::from_hex_key(&hex::encode(ikm)).unwrap())
    }

    /// A trivial echo service: returns the request body as the response body.
    #[derive(Clone)]
    struct EchoService;

    impl Service<Request<Body>> for EchoService {
        type Response = Response<Body>;
        type Error = Infallible;
        type Future = std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
        >;

        fn poll_ready(
            &mut self,
            _context: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn call(&mut self, request: Request<Body>) -> Self::Future {
            Box::pin(async move {
                let body_bytes = request.into_body().collect().await.unwrap().to_bytes();
                Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body_bytes))
                    .unwrap())
            })
        }
    }

    /// Encapsulate a JSON body as an OHTTP request (client-side operation).
    fn encapsulate_request(
        gateway: &OhttpGateway,
        path: &str,
        json_body: &[u8],
    ) -> (Vec<u8>, ohttp::ClientResponse) {
        // Build Binary HTTP request.
        let mut bhttp_request = bhttp::Message::request(
            b"POST".to_vec(),
            b"https".to_vec(),
            b"".to_vec(),
            path.as_bytes().to_vec(),
        );
        bhttp_request.put_header("content-type", b"application/json");
        bhttp_request.write_content(json_body);

        let mut bhttp_bytes = Vec::new();
        bhttp_request
            .write_bhttp(bhttp::Mode::KnownLength, &mut bhttp_bytes)
            .unwrap();

        // OHTTP encapsulate.
        let config_bytes = gateway.encoded_config();
        let client_request = ohttp::ClientRequest::from_encoded_config_list(config_bytes).unwrap();
        let (encapsulated, client_response) = client_request.encapsulate(&bhttp_bytes).unwrap();
        (encapsulated, client_response)
    }

    /// Decapsulate an OHTTP response (client-side operation).
    fn decapsulate_response(
        client_response: ohttp::ClientResponse,
        encrypted_response: &[u8],
    ) -> (u16, Vec<u8>) {
        let bhttp_bytes = client_response.decapsulate(encrypted_response).unwrap();
        let bhttp_message = bhttp::Message::read_bhttp(&mut Cursor::new(&bhttp_bytes)).unwrap();
        let status = bhttp_message
            .control()
            .status()
            .map(|s| s.code())
            .unwrap_or(0);
        let body = bhttp_message.content().to_vec();
        (status, body)
    }

    #[tokio::test]
    async fn json_request_passes_through_unchanged() {
        let gateway = test_gateway();
        let layer = OhttpLayer::new(gateway);
        let mut service = layer.layer(EchoService);

        let request = Request::builder()
            .method("POST")
            .uri("/v1/sync/incoming_state")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"hello":"world"}"#))
            .unwrap();

        let response = service.ready().await.unwrap().call(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // Response should be plain JSON, not OHTTP-encapsulated.
        let content_type = response.headers().get(header::CONTENT_TYPE).unwrap();
        assert_eq!(content_type, "application/json");

        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.as_ref(), br#"{"hello":"world"}"#);
    }

    #[tokio::test]
    async fn ohttp_request_decapsulates_and_encapsulates() {
        let gateway = test_gateway();
        let layer = OhttpLayer::new(gateway.clone());
        let mut service = layer.layer(EchoService);

        let json_body = br#"{"viewing_key":"0xabc"}"#;
        let (encapsulated, client_response) =
            encapsulate_request(&gateway, "/v1/sync/incoming_state", json_body);

        let request = Request::builder()
            .method("POST")
            .uri("/v1/sync/incoming_state")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(encapsulated))
            .unwrap();

        let response = service.ready().await.unwrap().call(request).await.unwrap();

        // Outer response should be 200 with message/ohttp-res.
        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response.headers().get(header::CONTENT_TYPE).unwrap();
        assert_eq!(content_type, "message/ohttp-res");

        // Decrypt the response.
        let encrypted_body = response.into_body().collect().await.unwrap().to_bytes();
        let (status, decrypted_body) = decapsulate_response(client_response, &encrypted_body);

        assert_eq!(status, 200);
        // Echo service returns the inner body — which is the JSON from the Binary HTTP request.
        assert_eq!(decrypted_body, json_body);
    }

    #[tokio::test]
    async fn malformed_ohttp_returns_422() {
        let gateway = test_gateway();
        let layer = OhttpLayer::new(gateway);
        let mut service = layer.layer(EchoService);

        let request = Request::builder()
            .method("POST")
            .uri("/v1/sync/incoming_state")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(b"not valid ohttp".to_vec()))
            .unwrap();

        let response = service.ready().await.unwrap().call(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"]["code"], "OHTTP_DECAPSULATION_FAILED");
    }

    #[tokio::test]
    async fn missing_content_type_passes_through() {
        let gateway = test_gateway();
        let layer = OhttpLayer::new(gateway);
        let mut service = layer.layer(EchoService);

        // No Content-Type header at all — should pass through.
        let request = Request::builder()
            .method("POST")
            .uri("/v1/sync/incoming_state")
            .body(Body::from(r#"{"test":true}"#))
            .unwrap();

        let response = service.ready().await.unwrap().call(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let content_type = response.headers().get(header::CONTENT_TYPE).unwrap();
        assert_eq!(content_type, "application/json");
    }

    #[tokio::test]
    async fn ohttp_preserves_inner_path() {
        let gateway = test_gateway();
        let layer = OhttpLayer::new(gateway.clone());

        /// Service that returns the request URI path as the body.
        #[derive(Clone)]
        struct PathEchoService;

        impl Service<Request<Body>> for PathEchoService {
            type Response = Response<Body>;
            type Error = Infallible;
            type Future = std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<Self::Response, Self::Error>> + Send>,
            >;

            fn poll_ready(
                &mut self,
                _ctx: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Result<(), Self::Error>> {
                std::task::Poll::Ready(Ok(()))
            }

            fn call(&mut self, request: Request<Body>) -> Self::Future {
                let path = request.uri().path().to_string();
                Box::pin(async move {
                    Ok(Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(path))
                        .unwrap())
                })
            }
        }

        let mut service = layer.layer(PathEchoService);
        let (encapsulated, client_response) =
            encapsulate_request(&gateway, "/v1/sync/outgoing_state", b"{}");

        let request = Request::builder()
            .method("POST")
            .uri("/v1/sync/outgoing_state")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(encapsulated))
            .unwrap();

        let response = service.ready().await.unwrap().call(request).await.unwrap();
        let encrypted_body = response.into_body().collect().await.unwrap().to_bytes();
        let (status, decrypted_body) = decapsulate_response(client_response, &encrypted_body);

        assert_eq!(status, 200);
        assert_eq!(
            String::from_utf8(decrypted_body).unwrap(),
            "/v1/sync/outgoing_state"
        );
    }
}
