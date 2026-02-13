# Stage 1: Generate dependency recipe
FROM rust:1-alpine AS chef
RUN cargo install cargo-chef
WORKDIR /app

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo chef prepare --recipe-path recipe.json

# Stage 2: Build dependencies (cached) then source
FROM chef AS builder
RUN apk add --no-cache musl-dev openssl-dev openssl-libs-static pkgconf
ENV OPENSSL_STATIC=1

COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json -p discovery-service

COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release -p discovery-service

# Stage 3: Runtime
FROM alpine:3

RUN apk add --no-cache ca-certificates && \
    addgroup -S app && adduser -S app -G app

COPY --from=builder /app/target/release/discovery-service /usr/local/bin/discovery-service

USER app

ENV API_HOST=0.0.0.0:8080

EXPOSE 8080

ENTRYPOINT ["discovery-service"]
