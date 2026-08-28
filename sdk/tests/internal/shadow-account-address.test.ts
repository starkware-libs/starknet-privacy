import type { ProviderInterface } from "starknet";
import { describe, expect, it, vi } from "vitest";

import {
  PRIMER_CLASS_HASH,
  shadowAccountAddress,
  shadowAccountAddressFromClassHash,
  shadowAccountAddressOnChain,
  shadowAccountCommitment,
  shadowAccountPartialCommitment,
} from "../../src/internal/shadow-account-address.js";
import { compute_identity_key } from "../../src/utils/hashes.js";
import { hash as poseidonHash } from "../../src/utils/index.js";

/**
 * The committed cross-language vector. Cairo asserts the same inputs and the same three expected
 * felts in `test_shadow_account_derivation_matches_the_committed_vector`, so a change to either
 * implementation fails on one side. Without it these tests would only prove the SDK agrees with
 * itself.
 */
const IDENTITY_KEY = 0x111n;
const DAPP_NAME = 0x222n;
const NONCE = 0x3n;
const ANONYMIZER = 0x444n;
const PARTIAL_COMMITMENT = 0xdbb320724c2f71919310007cc2ee821e9b234b98535d24dae197124c2ef4fbn;
const COMMITMENT = 0x418bf56bebf218ffa365531394e68b3336a9557b5b8be8ad6a21f44e79833bn;
const ADDRESS = 0x5e1a753154c6cbb012b819c0362921b7040df54b90bb9241f54e7d946cf9708n;

/**
 * Live Starknet Sepolia vector for anonymizer 0x010a2285...9fe8d9b147, which predates the primer
 * pattern: it has no `get_primer_class_hash` entrypoint at all (RPC error 21, "Requested entry
 * point does not exist") and deploys shadow accounts with its `get_shadow_account_class_hash()`
 * class directly. `deployedOnSepolia` is the address `get_shadow_account(commitment)` actually
 * returns on-chain (`ShadowAccountDeployed` event, tx 0x48ccd889292f406734d97a27c53db53910fb0f9ef
 * 3c056668bd64e20ccb111b, block 14130089) — the primer formula predicts a different, wrong address
 * for the same commitment, because this anonymizer never deploys a Primer at all.
 */
const SEPOLIA = {
  commitment: 0x72c7cef4c82933a9107758dc7385e8378c306c866269cdc814a446fb71a874cn,
  anonymizer: 0x010a2285310c107c731d997afc147afb7495daff6397c2d242133d9fe8d9b147n,
  shadowAccountClassHash: 0x70e76435b6ddb74b11665d3bc3264aaf354f59329976f3ffcb03b2ab992b78fn,
  deployedOnSepolia: 0x5070c79c08b1146ec188f9e5f21c58cf83358f786b23d64d7c66b4c1ba477c9n,
};

describe("shadow account derivation", () => {
  it("matches the committed Cairo vector", () => {
    expect(poseidonHash(IDENTITY_KEY, DAPP_NAME)).toBe(PARTIAL_COMMITMENT);
    expect(shadowAccountCommitment(PARTIAL_COMMITMENT, NONCE)).toBe(COMMITMENT);
    expect(shadowAccountAddress(COMMITMENT, ANONYMIZER)).toBe(ADDRESS);
  });

  it("reaches the same commitment from the user's own inputs", () => {
    const user = 0x999n;
    const viewingKey = 0x888n;
    const partial = shadowAccountPartialCommitment(user, viewingKey, ANONYMIZER, DAPP_NAME);
    // The anonymizer goes into the identity key, not only into the address, so a partial commitment
    // belongs to the anonymizer it was derived for.
    expect(partial).toBe(
      poseidonHash(compute_identity_key(user, viewingKey, ANONYMIZER), DAPP_NAME)
    );
    expect(partial).not.toBe(shadowAccountPartialCommitment(user, viewingKey, 0x445n, DAPP_NAME));
  });

  it("gives every nonce its own address", () => {
    const partial = shadowAccountPartialCommitment(0x999n, 0x888n, ANONYMIZER, DAPP_NAME);
    const addresses = [0n, 1n, 2n].map((nonce) =>
      shadowAccountAddress(shadowAccountCommitment(partial, nonce), ANONYMIZER)
    );
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("salts by the commitment and deploys from the anonymizer", () => {
    // Both matter: the salt separates one shadow account from the next, and the deployer keeps two
    // anonymizers from colliding on one address.
    expect(shadowAccountAddress(COMMITMENT, ANONYMIZER)).not.toBe(
      shadowAccountAddress(COMMITMENT + 1n, ANONYMIZER)
    );
    expect(shadowAccountAddress(COMMITMENT, ANONYMIZER)).not.toBe(
      shadowAccountAddress(COMMITMENT, ANONYMIZER + 1n)
    );
  });

  it("pins the Primer class hash the anonymizer cements", () => {
    expect(PRIMER_CLASS_HASH).toBe(
      0x00123e6bc1c14ae9934e933d3f64916a6116dd6b036a922b2b1f0815e0d1d300n
    );
  });
});

describe("shadowAccountAddressFromClassHash", () => {
  it("agrees with shadowAccountAddress when passed PRIMER_CLASS_HASH", () => {
    expect(shadowAccountAddressFromClassHash(COMMITMENT, PRIMER_CLASS_HASH, ANONYMIZER)).toBe(
      shadowAccountAddress(COMMITMENT, ANONYMIZER)
    );
  });

  it(
    "reproduces the address a pre-primer anonymizer actually deployed on Sepolia, given its " +
      "shadow account class hash",
    () => {
      const { commitment, anonymizer, shadowAccountClassHash, deployedOnSepolia } = SEPOLIA;

      expect(
        shadowAccountAddressFromClassHash(commitment, shadowAccountClassHash, anonymizer)
      ).toBe(deployedOnSepolia);
      // The primer formula alone gets this wrong: this anonymizer never deploys a Primer at all.
      expect(shadowAccountAddress(commitment, anonymizer)).not.toBe(deployedOnSepolia);
    }
  );
});

describe("shadowAccountAddressOnChain", () => {
  /** A minimal `ProviderInterface` stub: only `callContract` is exercised. */
  function mockProvider(callContract: ProviderInterface["callContract"]): ProviderInterface {
    return { callContract } as unknown as ProviderInterface;
  }

  it(
    "returns the anonymizer's registered address once one is deployed, even for a pre-primer " +
      "anonymizer (real Sepolia vector)",
    async () => {
      const { commitment, anonymizer, deployedOnSepolia } = SEPOLIA;
      const callContract = vi.fn().mockImplementation(async (call) => {
        expect(call.entrypoint).toBe("get_shadow_account");
        expect(call.contractAddress).toBe(`0x${anonymizer.toString(16)}`);
        expect(call.calldata).toEqual([`0x${commitment.toString(16)}`]);
        return [`0x${deployedOnSepolia.toString(16)}`];
      });

      await expect(
        shadowAccountAddressOnChain(commitment, anonymizer, mockProvider(callContract))
      ).resolves.toBe(deployedOnSepolia);
      expect(callContract).toHaveBeenCalledTimes(1);
      // The registry lookup is authoritative regardless of generation: the primer formula alone
      // would have gotten this one wrong.
      expect(shadowAccountAddress(commitment, anonymizer)).not.toBe(deployedOnSepolia);
    }
  );

  it(
    "falls back to the primer formula when the registry has nothing deployed for this " +
      "commitment yet",
    async () => {
      const callContract = vi.fn().mockImplementation(async (call) => {
        expect(call.entrypoint).toBe("get_shadow_account");
        return ["0x0"];
      });

      await expect(
        shadowAccountAddressOnChain(COMMITMENT, ANONYMIZER, mockProvider(callContract))
      ).resolves.toBe(shadowAccountAddress(COMMITMENT, ANONYMIZER));
      expect(callContract).toHaveBeenCalledTimes(1);
    }
  );
});
