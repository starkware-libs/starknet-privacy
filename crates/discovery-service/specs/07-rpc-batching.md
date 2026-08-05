# 7. RPC Batching and Parallelism

RPC calls can and should be batched. Some reads require sequential probing, but meaningful parallelism remains available:

- Parallelize across channels for the same recipient.
- Parallelize across subchannels within multiple channels.
- Batch nullifier existence checks for many derived nullifiers at once.
- Use bounded concurrency to avoid overload of the RPC backend. `rpc.max_concurrent_requests` is enforced inside the JSON-RPC transport, so every call reaching the node — single-method or batched — is counted regardless of which code path issued it. A permit covers exactly one HTTP round trip, so paginated `starknet_getEvents` scans and chunked batch reads release their permit between round trips instead of holding one for the whole operation.

Batching will not eliminate probing, but it reduces round trips and improves throughput.
