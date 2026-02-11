export { ProvingServiceClient, type ProvingServiceConfig } from "./client.js";
export {
  ProvingServiceProofProvider,
  type ProvingServiceProofProviderConfig,
} from "./proving-service-proof-provider.js";
export type { BlockId, ProveTransactionResult, MessageToL1 } from "./types.js";
export {
  ProvingServiceError,
  BlockNotFoundError,
  InvalidTransactionHashError,
  ValidationFailedError,
  UnsupportedTransactionVersionError,
  InternalProvingError,
  mapProvingServiceError,
} from "./errors.js";
