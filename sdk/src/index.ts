export * from "./interfaces.js";
export { AddressMap } from "./utils/index.js";
export { createPrivateTransfers } from "./factory.js";
export { ProvingService } from "./internal/proving-service.js";
export type {
  MessageToL1,
  ProvingServiceConfig,
  ProveTransactionResult,
} from "./internal/proving-service.js";
export type { BlockIdentifier } from "starknet";
export {
  DEFAULT_BLOCKS_BACK_VERIFIABLE,
  ProvingServiceProofProvider,
} from "./internal/proving-service-provider.js";
export type {
  ProvingBlockId,
  ProvingServiceProofProviderOptions,
} from "./internal/proving-service-provider.js";
export type { RateLimitOptions } from "./utils/rate-limiter.js";
export type { DiscoveryOptions } from "./internal/contract-discovery.js";
