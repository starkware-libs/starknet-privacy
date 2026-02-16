export * from "./interfaces.js";
export { AddressMap } from "./utils/index.js";
export { createPrivateTransfers } from "./factory.js";
export { ProvingService } from "./internal/proving-service.js";
export type {
  BlockId,
  MessageToL1,
  ProvingServiceConfig,
  ProveTransactionResult,
} from "./internal/proving-service.js";
export {
  ProvingServiceProofProvider,
  normalizeProvingServiceUrl,
} from "./internal/proving-service-provider.js";
export type { ProvingServiceProofProviderOptions } from "./internal/proving-service-provider.js";
export { SignerRaw } from "./internal/signer-raw.js";
export type { AccountSignerRaw, SignerRawInterface } from "./interfaces.js";
export {
  BlockNotFoundError,
  InvalidTransactionHashError,
  mapProvingServiceError,
  ProvingServiceError,
  ProvingServiceInternalError,
  UnsupportedTransactionVersionError,
  ValidationFailedError,
} from "./internal/proving-service-errors.js";
export type { RateLimitOptions } from "./utils/rate-limiter.js";
export type { DiscoveryOptions } from "./internal/contract-discovery.js";
