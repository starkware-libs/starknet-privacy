//! OHTTP handlers and request processing.
//!
//! The OHTTP gateway is a single `POST /` endpoint (RFC 9458). It:
//! 1. Reads the encrypted body (enforcing `max_request_body_bytes`)
//! 2. Decapsulates the OHTTP envelope using the server's HPKE key
//! 3. Parses the inner Binary HTTP (RFC 9292) request
//! 4. Rebuilds an `http::Request` with the inner JSON body and path
//! 5. Routes through the API router
//! 6. Encapsulates the response as `message/ohttp-res`
//!
//! The `GET /ohttp-keys` endpoint serves the server's public key configuration.

use std::io::Cursor;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, Request, Response, StatusCode};
use axum::response::IntoResponse;
use axum::Router;
use http_body_util::{BodyExt, LengthLimitError, Limited};
use tower::ServiceExt;
use tracing::debug;

use crate::ohttp::gateway::OhttpGateway;

/// Shared state for the OHTTP gateway handler.
#[derive(Clone)]
pub struct OhttpGatewayState {
    pub gateway: Arc<OhttpGateway>,
    pub body_limit: usize,
    pub key_cache_max_age_secs: u64,
    pub api_router: Router,
}

/// Handler for `GET /ohttp-keys`.
///
/// Returns the server's OHTTP key configuration in the
/// `application/ohttp-keys` binary format (RFC 9458 §3).
pub async fn ohttp_keys_handler(State(state): State<OhttpGatewayState>) -> impl IntoResponse {
    let cache_control = format!("public, max-age={}", state.key_cache_max_age_secs);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/ohttp-keys".to_string()),
            (header::CACHE_CONTROL, cache_control),
        ],
        state.gateway.encoded_config().to_vec(),
    )
}

/// Handler for `POST /` — the single OHTTP gateway endpoint.
///
/// Decapsulates the OHTTP request, routes the inner request through
/// the API router, and encapsulates the response.
pub async fn ohttp_gateway_handler(
    State(state): State<OhttpGatewayState>,
    request: Request<Body>,
) -> Response<Body> {
    // Read the full encapsulated request body.
    let encapsulated_bytes = match read_body(request, state.body_limit).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    // Decapsulate using the OHTTP server.
    let (bhttp_bytes, server_response) =
        match state.gateway.server().decapsulate(&encapsulated_bytes) {
            Ok(result) => result,
            Err(error) => {
                debug!("OHTTP decapsulation failed: {error}");
                return OhttpProcessingError::DecapsulationFailed.into();
            }
        };

    // Parse the inner Binary HTTP request.
    let bhttp_message = match bhttp::Message::read_bhttp(&mut Cursor::new(&bhttp_bytes)) {
        Ok(message) => message,
        Err(error) => {
            debug!("Invalid Binary HTTP message: {error}");
            return OhttpProcessingError::InvalidFormat("Invalid Binary HTTP message").into();
        }
    };

    // Extract the inner JSON body and rebuild as a normal HTTP request.
    let inner_request = match rebuild_request(&bhttp_message) {
        Ok(request) => request,
        Err(response) => return response,
    };

    // Route through the API router.
    // Router's Service impl has Error = Infallible — it always produces a response.
    let inner_response = state
        .api_router
        .clone()
        .oneshot(inner_request)
        .await
        .unwrap_or_else(|infallible| match infallible {});

    // Encapsulate the response.
    encapsulate_response(inner_response, server_response).await
}

/// Errors during OHTTP request/response processing.
enum OhttpProcessingError {
    /// 422 — OHTTP decapsulation failed (bad HPKE envelope).
    DecapsulationFailed,
    /// 422 — invalid Binary HTTP format or request rebuild failure.
    InvalidFormat(&'static str),
    /// 413 — request body exceeds the size limit.
    BodyTooLarge,
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
            OhttpProcessingError::BodyTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "OHTTP_BODY_TOO_LARGE",
                "Request body exceeds the size limit",
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

/// Read the full body from an HTTP request, enforcing a size limit.
async fn read_body(request: Request<Body>, body_limit: usize) -> Result<Bytes, Response<Body>> {
    Limited::new(request.into_body(), body_limit)
        .collect()
        .await
        .map(|collected| collected.to_bytes())
        .map_err(|error| {
            if error.downcast_ref::<LengthLimitError>().is_some() {
                OhttpProcessingError::BodyTooLarge.into()
            } else {
                OhttpProcessingError::BadRequestBody.into()
            }
        })
}

/// Rebuild a standard `http::Request<Body>` from a parsed Binary HTTP message.
#[allow(clippy::result_large_err)]
fn rebuild_request(bhttp_message: &bhttp::Message) -> Result<Request<Body>, Response<Body>> {
    let body = bhttp_message.content().to_vec();

    let method = bhttp_message
        .control()
        .method()
        .map(|m| String::from_utf8_lossy(m).into_owned())
        .unwrap_or_else(|| "POST".to_string());

    let mut builder = Request::builder()
        .method(method.as_str())
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
    use std::io::Cursor;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use axum::routing::{get, post};
    use axum::Router;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use crate::ohttp::gateway::OhttpGateway;
    use crate::ohttp::handlers::{ohttp_gateway_handler, OhttpGatewayState};

    const TEST_BODY_LIMIT: usize = 102_400;

    fn test_gateway() -> Arc<OhttpGateway> {
        let mut ikm = [0u8; 32];
        ikm[0] = 1;
        Arc::new(OhttpGateway::from_hex_key(&hex::encode(ikm)).unwrap())
    }

    /// Echo handler: returns the request body as-is.
    async fn echo_handler(body: axum::body::Bytes) -> impl axum::response::IntoResponse {
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            body,
        )
    }

    /// Path echo handler: returns the request URI path as the body.
    async fn path_echo_handler(request: Request<Body>) -> impl axum::response::IntoResponse {
        let path = request.uri().path().to_string();
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            path,
        )
    }

    async fn get_health_handler() -> impl axum::response::IntoResponse {
        (StatusCode::OK, "OK")
    }

    fn test_app(gateway: Arc<OhttpGateway>, body_limit: usize) -> Router {
        let api_router = Router::new()
            .route("/health", get(get_health_handler))
            .route("/v1/sync/incoming_state", post(echo_handler))
            .route("/v1/sync/outgoing_state", post(path_echo_handler));
        let gateway_state = OhttpGatewayState {
            gateway,
            body_limit,
            key_cache_max_age_secs: 3600,
            api_router,
        };
        Router::new()
            .route("/", post(ohttp_gateway_handler))
            .with_state(gateway_state)
    }

    /// Encapsulate a JSON body as an OHTTP request (client-side operation).
    fn encapsulate_request(
        gateway: &OhttpGateway,
        path: &str,
        json_body: &[u8],
    ) -> (Vec<u8>, ohttp::ClientResponse) {
        encapsulate_request_with_method(gateway, "POST", path, json_body)
    }

    fn encapsulate_request_with_method(
        gateway: &OhttpGateway,
        method: &str,
        path: &str,
        json_body: &[u8],
    ) -> (Vec<u8>, ohttp::ClientResponse) {
        let mut bhttp_request = bhttp::Message::request(
            method.as_bytes().to_vec(),
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
    async fn ohttp_request_decapsulates_and_encapsulates() {
        let gateway = test_gateway();
        let app = test_app(gateway.clone(), TEST_BODY_LIMIT);

        let json_body = br#"{"viewing_key":"0xabc"}"#;
        let (encapsulated, client_response) =
            encapsulate_request(&gateway, "/v1/sync/incoming_state", json_body);

        let request = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(encapsulated))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response.headers().get(header::CONTENT_TYPE).unwrap();
        assert_eq!(content_type, "message/ohttp-res");

        let encrypted_body = response.into_body().collect().await.unwrap().to_bytes();
        let (status, decrypted_body) = decapsulate_response(client_response, &encrypted_body);

        assert_eq!(status, 200);
        assert_eq!(decrypted_body, json_body);
    }

    #[tokio::test]
    async fn malformed_ohttp_returns_422() {
        let gateway = test_gateway();
        let app = test_app(gateway, TEST_BODY_LIMIT);

        let request = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(b"not valid ohttp".to_vec()))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"]["code"], "OHTTP_DECAPSULATION_FAILED");
    }

    #[tokio::test]
    async fn ohttp_routes_by_inner_path() {
        let gateway = test_gateway();
        let app = test_app(gateway.clone(), TEST_BODY_LIMIT);

        // The inner Binary HTTP targets /v1/sync/outgoing_state (path echo handler).
        let (encapsulated, client_response) =
            encapsulate_request(&gateway, "/v1/sync/outgoing_state", b"{}");

        let request = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(encapsulated))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        let encrypted_body = response.into_body().collect().await.unwrap().to_bytes();
        let (status, decrypted_body) = decapsulate_response(client_response, &encrypted_body);

        assert_eq!(status, 200);
        assert_eq!(
            String::from_utf8(decrypted_body).unwrap(),
            "/v1/sync/outgoing_state"
        );
    }

    #[tokio::test]
    async fn ohttp_preserves_get_method() {
        let gateway = test_gateway();
        let app = test_app(gateway.clone(), TEST_BODY_LIMIT);

        let (encapsulated, client_response) =
            encapsulate_request_with_method(&gateway, "GET", "/health", b"");

        let request = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(encapsulated))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        let encrypted_body = response.into_body().collect().await.unwrap().to_bytes();
        let (status, decrypted_body) = decapsulate_response(client_response, &encrypted_body);

        assert_eq!(status, 200);
        assert_eq!(String::from_utf8(decrypted_body).unwrap(), "OK");
    }

    #[tokio::test]
    async fn oversized_ohttp_body_returns_413() {
        let gateway = test_gateway();
        let body_limit = 64;
        let app = test_app(gateway, body_limit);

        let oversized_body = vec![0u8; body_limit + 1];
        let request = Request::builder()
            .method("POST")
            .uri("/")
            .header(header::CONTENT_TYPE, "message/ohttp-req")
            .body(Body::from(oversized_body))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"]["code"], "OHTTP_BODY_TOO_LARGE");
    }
}
