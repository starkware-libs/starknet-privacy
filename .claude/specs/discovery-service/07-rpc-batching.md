# 7. RPC Batching and Parallelism

RPC calls can and should be batched. Some reads require sequential probing, but meaningful parallelism remains available:

- Parallelize across channels for the same recipient.
- Parallelize across subchannels within multiple channels.
- Batch nullifier existence checks for many derived nullifiers at once.
- Use bounded concurrency to avoid overload of the RPC backend.

Batching will not eliminate probing, but it reduces round trips and improves throughput.
