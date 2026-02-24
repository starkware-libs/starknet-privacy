# Runtime assembler: combines pre-built binaries into the final image.
# Binaries are provided via build context (downloaded CI artifacts).
# Uses distroless for minimal size (~20 MB base); binaries statically link OpenSSL.
FROM gcr.io/distroless/cc-debian12

WORKDIR /app

COPY starknet_os_runner ./target/release/starknet_os_runner
COPY starknet-sierra-compile ./target/release/shared_executables/starknet-sierra-compile
COPY simple_bootloader_compiled.json ./crates/starknet_os_runner/resources/simple_bootloader_compiled.json
COPY stwo_run_and_prove ./target/tools/stwo_run_and_prove

USER nonroot

EXPOSE 3000

ENTRYPOINT ["./target/release/starknet_os_runner"]
