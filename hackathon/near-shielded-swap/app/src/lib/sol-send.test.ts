import { describe, expect, it, vi, afterEach } from "vitest";
import {
  Connection,
  Keypair,
  SystemInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { buildSolTransfer, lamportsForSol } from "./sol-send";

// Stable, on-curve pubkeys for transfer construction. Generated once per
// test run; values are arbitrary — we only assert structural correctness.
const FROM_KEY = Keypair.generate().publicKey.toBase58();
const TO_KEY = Keypair.generate().publicKey.toBase58();

describe("lamportsForSol", () => {
  it("converts 1.5 SOL to 1_500_000_000 lamports", () => {
    expect(lamportsForSol(1.5)).toBe(1_500_000_000n);
  });

  it("treats non-positive amounts as zero", () => {
    expect(lamportsForSol(0)).toBe(0n);
    expect(lamportsForSol(-1)).toBe(0n);
    expect(lamportsForSol(Number.NaN)).toBe(0n);
  });

  it("preserves precision down to 1 lamport", () => {
    // 0.000000001 SOL is the smallest representable unit; this would lose
    // precision via naive `Math.round(sol * 1e9)`.
    expect(lamportsForSol(0.000000001)).toBe(1n);
  });
});

describe("buildSolTransfer", () => {
  it("produces exactly one SystemProgram.transfer instruction", () => {
    const transaction = buildSolTransfer({
      from: FROM_KEY,
      to: TO_KEY,
      lamports: 2_500n,
    });
    expect(transaction.instructions).toHaveLength(1);
    const ix = transaction.instructions[0]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
  });

  it("encodes the correct from / to / lamports", () => {
    const transaction = buildSolTransfer({
      from: FROM_KEY,
      to: TO_KEY,
      lamports: 1_234_567n,
    });
    const decoded = SystemInstruction.decodeTransfer(transaction.instructions[0]!);
    expect(decoded.fromPubkey.toBase58()).toBe(FROM_KEY);
    expect(decoded.toPubkey.toBase58()).toBe(TO_KEY);
    // `DecodedTransferInstruction.lamports` is typed as `bigint` in the SDK.
    expect(decoded.lamports).toBe(1_234_567n);
  });

  it("sets feePayer to the sender and leaves blockhash unset", () => {
    const transaction = buildSolTransfer({
      from: FROM_KEY,
      to: TO_KEY,
      lamports: 1n,
    });
    expect(transaction.feePayer?.toBase58()).toBe(FROM_KEY);
    // Builder must not pre-fill the blockhash — it's fetched right before
    // signing to avoid expiry while the wallet popup is open.
    expect(transaction.recentBlockhash).toBeUndefined();
  });
});

describe("Connection.getLatestBlockhash (mocked)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the RPC method invoked when fetching a blockhash, with no real network call", async () => {
    // Spy on the prototype so any `new Connection(...)` instance returns the
    // stub. Asserts the hook's chosen RPC verb without going to mainnet.
    const stub = vi
      .spyOn(Connection.prototype, "getLatestBlockhash")
      .mockResolvedValue({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 0,
      });

    const connection = new Connection("http://localhost:0");
    const result = await connection.getLatestBlockhash("confirmed");

    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub).toHaveBeenCalledWith("confirmed");
    expect(result.blockhash).toBe("11111111111111111111111111111111");
  });
});
