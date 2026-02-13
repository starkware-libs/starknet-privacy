# Stage 1: Generate dependency recipe
FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef
WORKDIR /app

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo chef prepare --recipe-path recipe.json

# Stage 2: Build dependencies (cached) then source
FROM chef AS builder
RUN apt-get update && \
    apt-get install -y --no-install-recommends libssl-dev pkg-config && \
    rm -rf /var/lib/apt/lists/*
ENV OPENSSL_STATIC=1

COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json -p discovery-service

COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release -p discovery-service

# Stage 3: Runtime
FROM gcr.io/distroless/cc-debian12

COPY --from=builder /app/target/release/discovery-service /usr/local/bin/discovery-service

USER nonroot

ENV API_HOST=0.0.0.0:8080

EXPOSE 8080

ENTRYPOINT ["discovery-service"]
