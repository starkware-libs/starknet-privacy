import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { num, shortString } from "starknet";
import type { Call, InvocationsSignerDetails, TypedData } from "starknet";
import {
  callSetTypedData,
  computeCallSet712Hash,
  computeOutsideExecution712Hash,
  Eip712HashSigner,
  Eip712TypedDataSigner,
  secp256k1SignFn,
} from "../../src/signers/eip712-call-set-signer.js";

const ACCOUNT = 0x1234n;
const SN_CHAIN = "SN_SEPOLIA";
const EVM_CHAIN = 1n;
const SAMPLE_CALLS: Call[] = [
  { contractAddress: "0x111", entrypoint: "approve", calldata: ["0x1", "0x2"] },
];

function to32(v: bigint): Uint8Array {
  const o = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    o[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return o;
}
const keccakStr = (s: string): bigint =>
  num.toBigInt("0x" + Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex"));
const ethAddrFromPub = (pub64: Uint8Array): bigint =>
  num.toBigInt("0x" + Buffer.from(keccak_256(pub64).slice(12)).toString("hex"));
const ethAddressOfKey = (pk: bigint): bigint =>
  ethAddrFromPub(secp256k1.getPublicKey(to32(pk), false).slice(1));

describe("EIP-712 CallSet signers", () => {
  it("pins the starkware_accounts EIP-712 type hashes (keccak of encodeType)", () => {
    // Proves the wallet (which derives type hashes from the `types` object the same way) computes
    // the same type hashes as the on-chain Eth712Account.
    expect(keccakStr("Call(uint256 address,uint256 selector,uint256[] data)")).toBe(
      0x7793b9bed3b87c6119fe923f0da4e85e1f97a03272a446514622ee7bd62ad25fn
    );
    expect(
      keccakStr(
        "CallSet(Call[] calls,uint256[] additional_data)Call(uint256 address,uint256 selector,uint256[] data)"
      )
    ).toBe(0xa6b8079d8aedb3bfd5ee9effaf1c1d19c1514c55ed0dc439faf8aabe5460582fn);
    expect(
      keccakStr(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
      )
    ).toBe(0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400fn);
  });

  it("reproduces the starkware_accounts on-chain-validated CallSet signature (approve fixture)", async () => {
    // Golden vector from starkware_accounts eth_712_utils test_utils.cairo
    // `get_call_set_with_approve_signature()` — an approve(0x1234, 500) CallSet on SN_MAIN / evm chain 1.
    const account = 0x07120acc07120acc07120acc07120accn;
    const privateKey = 0xa6d86467b6ec9e161649b27edfd8519e75a2e1cf5f4c309c628706e6999780e8n;
    const approveCall: Call = {
      contractAddress: "0x0e2c200e2c200e2c200e2c200e2c2000",
      entrypoint: "approve",
      calldata: ["0x1234", "0x1f4", "0x0"], // spender, amount.low (500), amount.high
    };
    const signer = new Eip712HashSigner({
      accountAddress: account,
      snChainName: "SN_MAIN",
      evmChainId: 1n,
      sign: secp256k1SignFn(privateKey),
    });

    const felts = (await signer.signTransaction(
      [approveCall],
      {} as InvocationsSignerDetails
    )) as string[];

    expect(felts.map((f) => num.toBigInt(f))).toEqual([
      0x278778484aaed07e7aedfde9d083a8efn,
      0x887154c31481c204416d3d323bcb108cn,
      0x25eed52af478ac87dcf1dd528475af22n,
      0xfd39cb55c54d25904c96ff0d079b89b6n,
      28n,
      1n,
    ]);
  });

  it("reproduces the starkware_accounts golden with non-empty additional_data", async () => {
    // starkware_accounts `get_call_set_with_additional_data_signature()`: same approve CallSet, but
    // additional_data = [10, 11] bound into the message.
    const account = 0x07120acc07120acc07120acc07120accn;
    const privateKey = 0xa6d86467b6ec9e161649b27edfd8519e75a2e1cf5f4c309c628706e6999780e8n;
    const approveCall: Call = {
      contractAddress: "0x0e2c200e2c200e2c200e2c200e2c2000",
      entrypoint: "approve",
      calldata: ["0x1234", "0x1f4", "0x0"],
    };
    const signer = new Eip712HashSigner({
      accountAddress: account,
      snChainName: "SN_MAIN",
      evmChainId: 1n,
      additionalData: [10n, 11n],
      sign: secp256k1SignFn(privateKey),
    });

    const felts = (await signer.signTransaction(
      [approveCall],
      {} as InvocationsSignerDetails
    )) as string[];

    expect(felts.map((f) => num.toBigInt(f))).toEqual([
      0xcefcd06a012378cceb1bfa5b2831ef0dn,
      0xa5424ce854f5a39bf61df96013f21f94n,
      0x390242713792f83e134ccabc69a153can,
      0x8916d2267a20441a5a60b0b565735d03n,
      27n,
      1n,
    ]);
  });

  it("signTransaction returns a 6-felt signature that recovers to the signer's eth address", async () => {
    const pk = 0xdeadbeefn;
    const signer = new Eip712HashSigner({
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
    expect(num.toBigInt(felts[5])).toBe(EVM_CHAIN);
    const v = Number(num.toBigInt(felts[4]));
    expect([27, 28]).toContain(v);

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

  it("callSetTypedData maps domain + calls into the EIP-712 message", () => {
    const td = callSetTypedData(ACCOUNT, SAMPLE_CALLS, SN_CHAIN, EVM_CHAIN);
    expect(td.primaryType).toBe("CallSet");
    expect(td.domain.name).toBe(SN_CHAIN);
    expect(td.domain.version).toBe("2");
    expect(num.toBigInt(td.domain.verifyingContract)).toBe(ACCOUNT & ((1n << 128n) - 1n));
    expect(num.toBigInt(td.message.calls[0].address)).toBe(0x111n);
    expect(td.message.calls[0].data.map((d) => num.toBigInt(d))).toEqual([0x1n, 0x2n]);
  });

  it("signTypedData path yields the same 6-felt signature as the raw-hash path", async () => {
    const pk = 0xdeadbeefn;
    const rawSigner = new Eip712HashSigner({
      accountAddress: ACCOUNT,
      snChainName: SN_CHAIN,
      evmChainId: EVM_CHAIN,
      sign: secp256k1SignFn(pk),
    });
    // A wallet signing the v4 digest of the typed data (equal to computeCallSet712Hash for these
    // types — see the type-hash test), returned as a 0x-prefixed 65-byte (r‖s‖v) signature.
    const walletSigner = new Eip712TypedDataSigner({
      accountAddress: ACCOUNT,
      snChainName: SN_CHAIN,
      evmChainId: EVM_CHAIN,
      signTypedData: (td) => {
        expect(td.primaryType).toBe("CallSet");
        const digest = computeCallSet712Hash(ACCOUNT, SAMPLE_CALLS, SN_CHAIN, EVM_CHAIN);
        const sig = secp256k1.sign(to32(digest), to32(pk));
        const raw = new Uint8Array([...to32(sig.r), ...to32(sig.s), 27 + sig.recovery]);
        return "0x" + Buffer.from(raw).toString("hex");
      },
    });

    const fromRaw = await rawSigner.signTransaction(SAMPLE_CALLS, {} as InvocationsSignerDetails);
    const fromWallet = await walletSigner.signTransaction(
      SAMPLE_CALLS,
      {} as InvocationsSignerDetails
    );
    expect(fromWallet).toEqual(fromRaw);
  });

  it("reproduces the starkware_accounts OutsideExecution golden signature", async () => {
    // starkware_accounts `get_outside_execution_signature()` for `get_test_outside_execution()`:
    // empty calls, caller=ANY_CALLER, nonce=1, execute_after=1000, execute_before=3000, SN_MAIN, evm 1.
    const MASK_128 = (1n << 128n) - 1n;
    const privateKey = 0xa6d86467b6ec9e161649b27edfd8519e75a2e1cf5f4c309c628706e6999780e8n;
    const hash = computeOutsideExecution712Hash(
      0x07120acc07120acc07120acc07120accn,
      [],
      BigInt(shortString.encodeShortString("ANY_CALLER")),
      1n,
      1000n,
      3000n,
      "SN_MAIN",
      1n
    );
    const { r, s, v } = await secp256k1SignFn(privateKey)(hash);

    expect([r >> 128n, r & MASK_128, s >> 128n, s & MASK_128, BigInt(v), 1n]).toEqual([
      0x7ffb66a7163f54ab83a435079d74198dn,
      0x5ceb653460c57bda62685e60d4b67dc9n,
      0x7c07a7689645c4ec1775cd794e6a6bdcn,
      0xfaecbd63a4629b6e3d43e88568000326n,
      27n,
      1n,
    ]);
  });

  it("signMessage authorizes an OutsideExecution and reproduces the golden signature", async () => {
    // signMessage reads the OutsideExecution fields from the typed-data message and hashes them with
    // the signer's own account/domain, so only `message` needs to be well-formed here.
    const signer = new Eip712HashSigner({
      accountAddress: 0x07120acc07120acc07120acc07120accn,
      snChainName: "SN_MAIN",
      evmChainId: 1n,
      sign: secp256k1SignFn(0xa6d86467b6ec9e161649b27edfd8519e75a2e1cf5f4c309c628706e6999780e8n),
    });
    const outsideExecution = {
      primaryType: "OutsideExecution",
      domain: {},
      types: {},
      message: {
        calls: [],
        caller: num.toHex(shortString.encodeShortString("ANY_CALLER")),
        nonce: "0x1",
        execute_after: "0x3e8", // 1000
        execute_before: "0xbb8", // 3000
      },
    } as unknown as TypedData;

    const felts = (await signer.signMessage(outsideExecution, "0x07120acc")) as string[];

    expect(felts.map((f) => num.toBigInt(f))).toEqual([
      0x7ffb66a7163f54ab83a435079d74198dn,
      0x5ceb653460c57bda62685e60d4b67dc9n,
      0x7c07a7689645c4ec1775cd794e6a6bdcn,
      0xfaecbd63a4629b6e3d43e88568000326n,
      27n,
      1n,
    ]);
  });
});
