export * from "./interfaces.js";
export { AddressMap } from "./utils/index.js";
export { createPrivateTransfers } from "./factory.js";
export type { RateLimitOptions } from "./utils/rate-limiter.js";
export type { DiscoveryOptions } from "./internal/contract-discovery.js";

// Proving Service integration (remote proof generation)
export {
  ProvingServiceClient,
  ProvingServiceProofProvider,
  ProvingServiceError,
  BlockNotFoundError,
  InvalidTransactionHashError,
  ValidationFailedError,
  UnsupportedTransactionVersionError,
  InternalProvingError,
  mapProvingServiceError,
} from "./internal/proving-service/index.js";
export type {
  ProvingServiceConfig,
  ProvingServiceProofProviderConfig,
  BlockId as ProvingBlockId,
  ProveTransactionResult,
  MessageToL1 as ProvingMessageToL1,
} from "./internal/proving-service/index.js";
