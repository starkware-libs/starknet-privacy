import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { num } from "starknet";
import type { Call, InvocationsSignerDetails } from "starknet";
import {
  Eip712CallSetSigner,
  computeCallSet712Hash,
  secp256k1SignFn,
} from "../../src/signers/eip712-call-set-signer.js";

const ACCOUNT = 0x1234n;
const SN_CHAIN = "SN_SEPOLIA";
const EVM_CHAIN = 1n;
const SAMPLE_CALLS: Call[] = [
  { contractAddress: "0x111", entrypoint: "approve", calldata: ["0x1", "0x2"] },
];

// Equal to earn-contracts `get_call_set_hash` / scripts/eip712.py::call_set_msg_hash for the same
// vector (account=0x1234, [approve(0x111,[1,2])], SN_SEPOLIA, evm chain 1).
const GOLDEN = "0x98c5426ff67151a3338d0c99f03bd3b6e4a64e64aa86baea760f3d5f18ade0f7";

function to32(v: bigint): Uint8Array {
  const o = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    o[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return o;
}
const ethAddrFromPub = (pub64: Uint8Array): bigint =>
  num.toBigInt("0x" + Buffer.from(keccak_256(pub64).slice(12)).toString("hex"));
const ethAddressOfKey = (pk: bigint): bigint =>
  ethAddrFromPub(secp256k1.getPublicKey(to32(pk), false).slice(1));

describe("Eip712CallSetSigner", () => {
  it("computeCallSet712Hash matches the L1 golden vector", () => {
    expect(num.toHex(computeCallSet712Hash(ACCOUNT, SAMPLE_CALLS, SN_CHAIN, EVM_CHAIN))).toBe(GOLDEN);
  });

  it("signTransaction returns a 6-felt signature that recovers to the signer's eth address", async () => {
    const pk = 0xdeadbeefn;
    const signer = new Eip712CallSetSigner({
      accountAddress: ACCOUNT,
      snChainName: SN_CHAIN,
      evmChainId: EVM_CHAIN,
      sign: secp256k1SignFn(pk),
    });

    const felts = (await signer.signTransaction(
      SAMPLE_CALLS,
      {} as InvocationsSignerDetails
    )) as string[];

    expect(felts).toHaveLength(6);
    expect(num.toBigInt(felts[5])).toBe(EVM_CHAIN); // evm_chain_id slot
    const v = Number(num.toBigInt(felts[4]));
    expect([27, 28]).toContain(v);

    // Reconstruct (r, s) from the felt halves and recover — mirrors the account's is_valid_eth_signature.
    const r = (num.toBigInt(felts[0]) << 128n) | num.toBigInt(felts[1]);
    const s = (num.toBigInt(felts[2]) << 128n) | num.toBigInt(felts[3]);
    const msgHash = computeCallSet712Hash(ACCOUNT, SAMPLE_CALLS, SN_CHAIN, EVM_CHAIN);
    const recoveredPub = new secp256k1.Signature(r, s)
      .addRecoveryBit(v - 27)
      .recoverPublicKey(to32(msgHash))
      .toRawBytes(false)
      .slice(1);
    expect(ethAddrFromPub(recoveredPub)).toBe(ethAddressOfKey(pk));
  });

  it("binds calls / account / sn-chain / evm-chain", () => {
    const base = computeCallSet712Hash(ACCOUNT, SAMPLE_CALLS, SN_CHAIN, EVM_CHAIN);
    expect(computeCallSet712Hash(ACCOUNT, [], SN_CHAIN, EVM_CHAIN)).not.toBe(base);
    expect(computeCallSet712Hash(0x9n, SAMPLE_CALLS, SN_CHAIN, EVM_CHAIN)).not.toBe(base);
    expect(computeCallSet712Hash(ACCOUNT, SAMPLE_CALLS, "SN_MAIN", EVM_CHAIN)).not.toBe(base);
    expect(computeCallSet712Hash(ACCOUNT, SAMPLE_CALLS, SN_CHAIN, 2n)).not.toBe(base);
  });
});
