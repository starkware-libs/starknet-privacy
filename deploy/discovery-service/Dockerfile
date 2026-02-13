# Stage 1: Build
FROM rust:1-alpine AS builder

RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static pkgconf

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/

ENV OPENSSL_STATIC=1
RUN cargo build --release -p discovery-service

# Stage 2: Runtime
FROM alpine:3

RUN apk add --no-cache ca-certificates

COPY --from=builder /app/target/release/discovery-service /usr/local/bin/discovery-service

ENV API_HOST=0.0.0.0:8080

EXPOSE 8080

ENTRYPOINT ["discovery-service"]
