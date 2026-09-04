import { describe, expect, it } from "vitest";

import {
  PRIMER_CLASS_HASH,
  shadowAccountAddress,
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

describe("shadow account derivation", () => {
  it("matches the committed Cairo vector", () => {
    expect(poseidonHash(IDENTITY_KEY, DAPP_NAME)).toBe(PARTIAL_COMMITMENT);
    expect(shadowAccountCommitment(PARTIAL_COMMITMENT, NONCE)).toBe(COMMITMENT);
    // The vector stays the felt Cairo asserts; the function returns that felt in hex.
    expect(BigInt(shadowAccountAddress(COMMITMENT, ANONYMIZER))).toBe(ADDRESS);
  });

  it("returns the address as a felt in hex with no leading zeros", () => {
    // A padded or upper-case form would silently never match a canonicalized address.
    expect(shadowAccountAddress(COMMITMENT, ANONYMIZER)).toMatch(/^0x(0|[1-9a-f][0-9a-f]*)$/);
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
