// src/shadow-account.ts
import {
  shadowAccountOfPoolCall,
  shadowAccountInteractionOf,
} from "@starkware-libs/starknet-privacy-sdk";

/**
 * The shadow account derivation, owned by the SDK so this service and the mock proving provider the
 * devnet suites run against cannot derive different addresses for the same interaction.
 */
export {
  shadowAccountOfPoolCall as getShadowAccountAddress,
  shadowAccountInteractionOf as getShadowAccountInteraction,
};
