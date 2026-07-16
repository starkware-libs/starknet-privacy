import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CallData, hash, num, shortString, type Call } from "starknet";
import {
  Devnet,
  type DevnetEnvironment,
} from "@starkware-libs/starknet-privacy-sdk/testing";
import {
  Eip712HashSigner,
  secp256k1SignFn,
} from "@starkware-libs/starknet-privacy-client/signers";
import {
  deployEth712Account,
  type Eth712Account,
} from "../../src/eth712-account-setup.js";
import { E2E_TIMEOUTS } from "../../src/timeouts.js";

/**
 * Deploys a real `StarknetEth712Account` and checks that the client's `Eip712HashSigner` produces a
 * `CallSet` signature the account accepts on-chain via `is_custom_signature_valid` (case I). This is
 * the setup branch's own verification: the imported account + the client's EVM signer agree on the
 * EIP-712 `CallSet` hash.
 */
describe("StarknetEth712Account custom-signature validation on devnet", () => {
  let devnet: Devnet;
  let env: DevnetEnvironment;
  let account: Eth712Account;

  // Same EVM key as starkware_accounts' test fixtures — its eth address is what the account is
  // initialized with, so signatures with it validate.
  const EVM_KEY =
    0xa6d86467b6ec9e161649b27edfd8519e75a2e1cf5f4c309c628706e6999780e8n;
  const VALIDATED = BigInt(shortString.encodeShortString("VALID"));

  beforeAll(async () => {
    devnet = new Devnet();
    env = await devnet.initialize();
    account = await deployEth712Account(env.admin, env.provider, EVM_KEY);
  }, E2E_TIMEOUTS.hook);

  afterAll(async () => {
    await devnet?.cleanup();
  });

  it(
    "accepts a client Eip712 CallSet signature (case I)",
    async () => {
      const approveCalldata = ["0x1234", "0x1f4", "0x0"];
      const signer = new Eip712HashSigner({
        accountAddress: account.address,
        snChainName: "SN_SEPOLIA", // devnet chain id — keccak'd into the EIP-712 domain name
        evmChainId: 1n,
        sign: secp256k1SignFn(EVM_KEY),
      });

      const signature = (await signer.signTransaction(
        [
          {
            contractAddress: "0x111",
            entrypoint: "approve",
            calldata: approveCalldata,
          },
        ],
        {} as never,
      )) as string[];

      // The on-chain Call uses the raw selector; it must be the same call the signer hashed.
      const onChainCalls: Call[] = [
        {
          contractAddress: "0x111",
          entrypoint: hash.getSelectorFromName("approve"),
          calldata: approveCalldata,
        },
      ];
      const result = await env.provider.callContract({
        contractAddress: account.address,
        entrypoint: "is_custom_signature_valid",
        calldata: new CallData(account.abi).compile(
          "is_custom_signature_valid",
          {
            calls: onChainCalls.map((call) => ({
              to: call.contractAddress,
              selector: call.entrypoint,
              calldata: call.calldata,
            })),
            additional_data: [],
            signature,
          },
        ),
      });

      expect(num.toBigInt(result[0])).toBe(VALIDATED);
    },
    E2E_TIMEOUTS.test,
  );
});
