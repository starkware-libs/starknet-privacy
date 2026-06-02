/**
 * Round-trip tests for the ForgeYields anonymizer SDK helpers.
 *
 * Locks in the calldata layout each builder produces. The end-to-end devnet
 * test (`e2e/tests/devnet/forge-yield.test.ts` + `forge-private-redemption.test.ts`)
 * uses these helpers directly, so drift here surfaces immediately.
 */
import { describe, it, expect } from "vitest";
import {
  buildForgeDepositInvoke,
  buildForgeRequestRedeemInvoke,
  buildForgeClaimRedeemInvoke,
  forgeRedemptionCommitment,
  decodeRedemptionId,
  FORGE_ANONYMIZER_ABI,
} from "../../src/anonymizers/forge.js";

const ANONYMIZER = "0x" + "a".repeat(63) + "1";
const UNDERLYING = "0x" + "0".repeat(62) + "42";
const GATEWAY = "0x" + "0".repeat(62) + "fa";
const ASSETS = 50n * 10n ** 18n;
const SHARES = 20n * 10n ** 18n;
const NOTE_ID = 0xdeadbeefn;
const SECRET = 0xc0ffeen;

describe("Forge anonymizer SDK helpers", () => {
  // ─── Deposit ──────────────────────────────────────────────────────────────
  describe("buildForgeDepositInvoke", () => {
    it("targets the anonymizer with the privacy_invoke entrypoint", () => {
      const call = buildForgeDepositInvoke({
        anonymizer: ANONYMIZER,
        underlying: UNDERLYING,
        gateway: GATEWAY,
        assets: ASSETS,
        noteId: NOTE_ID,
      });
      expect(call.contractAddress).toBe(ANONYMIZER);
      expect(call.entrypoint).toBe("privacy_invoke");
    });

    it("encodes Deposit variant (index 0) with the right payload", () => {
      const calldata = buildForgeDepositInvoke({
        anonymizer: ANONYMIZER,
        underlying: UNDERLYING,
        gateway: GATEWAY,
        assets: ASSETS,
        noteId: NOTE_ID,
      }).calldata as string[];

      // Variant tag (Deposit = 0) + payload (gateway, underlying, assets.low, assets.high, note_id)
      expect(calldata.length).toBe(6);
      expect(BigInt(calldata[0])).toBe(0n); // variant tag
      expect(BigInt(calldata[1])).toBe(BigInt(GATEWAY));
      expect(BigInt(calldata[2])).toBe(BigInt(UNDERLYING));
      expect(BigInt(calldata[3])).toBe(ASSETS & ((1n << 128n) - 1n));
      expect(BigInt(calldata[4])).toBe(ASSETS >> 128n);
      expect(BigInt(calldata[5])).toBe(NOTE_ID);
    });

    it("u256 over u128::MAX still splits cleanly", () => {
      const huge = (1n << 200n) + 7n;
      const calldata = buildForgeDepositInvoke({
        anonymizer: ANONYMIZER,
        underlying: UNDERLYING,
        gateway: GATEWAY,
        assets: huge,
        noteId: NOTE_ID,
      }).calldata as string[];
      expect(BigInt(calldata[3])).toBe(huge & ((1n << 128n) - 1n));
      expect(BigInt(calldata[4])).toBe(huge >> 128n);
    });
  });

  // ─── RequestRedeem ────────────────────────────────────────────────────────
  describe("buildForgeRequestRedeemInvoke", () => {
    it("encodes RequestRedeem variant (index 1) with (gateway, shares, commitment)", () => {
      const commitment = forgeRedemptionCommitment(SECRET);
      const calldata = buildForgeRequestRedeemInvoke({
        anonymizer: ANONYMIZER,
        gateway: GATEWAY,
        shares: SHARES,
        commitment,
      }).calldata as string[];

      expect(calldata.length).toBe(5);
      expect(BigInt(calldata[0])).toBe(1n); // RequestRedeem
      expect(BigInt(calldata[1])).toBe(BigInt(GATEWAY));
      expect(BigInt(calldata[2])).toBe(SHARES & ((1n << 128n) - 1n));
      expect(BigInt(calldata[3])).toBe(SHARES >> 128n);
      expect(BigInt(calldata[4])).toBe(BigInt(commitment));
    });
  });

  // ─── ClaimRedeem ──────────────────────────────────────────────────────────
  describe("buildForgeClaimRedeemInvoke", () => {
    it("encodes ClaimRedeem variant (index 2) with the full payload", () => {
      const redemptionId = 7n;
      const calldata = buildForgeClaimRedeemInvoke({
        anonymizer: ANONYMIZER,
        gateway: GATEWAY,
        underlying: UNDERLYING,
        redemptionId,
        secret: SECRET,
        noteId: NOTE_ID,
      }).calldata as string[];

      // tag + gateway + redemption_id (low/high) + secret + underlying + note_id
      expect(calldata.length).toBe(7);
      expect(BigInt(calldata[0])).toBe(2n); // ClaimRedeem
      expect(BigInt(calldata[1])).toBe(BigInt(GATEWAY));
      expect(BigInt(calldata[2])).toBe(redemptionId & ((1n << 128n) - 1n));
      expect(BigInt(calldata[3])).toBe(redemptionId >> 128n);
      expect(BigInt(calldata[4])).toBe(BigInt(SECRET));
      expect(BigInt(calldata[5])).toBe(BigInt(UNDERLYING));
      expect(BigInt(calldata[6])).toBe(NOTE_ID);
    });
  });

  // ─── Commitment / event helpers ───────────────────────────────────────────
  describe("commitment + event decoding", () => {
    it("forgeRedemptionCommitment is deterministic and non-trivial", () => {
      const c1 = forgeRedemptionCommitment(SECRET);
      const c2 = forgeRedemptionCommitment(SECRET);
      expect(c1).toBe(c2);
      expect(BigInt(c1)).not.toBe(0n);
      // Different secrets → different commitments
      expect(forgeRedemptionCommitment(SECRET + 1n)).not.toBe(c1);
    });

    it("decodeRedemptionId reassembles a u256 from event data", () => {
      // Event data: [redemption_id.low, redemption_id.high, commitment]
      const id = (1n << 130n) + 42n;
      const low = id & ((1n << 128n) - 1n);
      const high = id >> 128n;
      expect(decodeRedemptionId([low, high, 0n])).toBe(id);
    });
  });

  // ─── ABI sanity ───────────────────────────────────────────────────────────
  describe("FORGE_ANONYMIZER_ABI", () => {
    it("declares all three operation variants", () => {
      const enumDecl = FORGE_ANONYMIZER_ABI.find(
        (item) => item.type === "enum" && item.name.endsWith("::ForgeOperation")
      ) as { variants: { name: string }[] } | undefined;
      expect(enumDecl).toBeDefined();
      expect(enumDecl!.variants.map((v) => v.name)).toEqual([
        "Deposit",
        "RequestRedeem",
        "ClaimRedeem",
      ]);
    });
  });
});
