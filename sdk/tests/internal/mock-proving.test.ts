import { describe, it, expect } from "vitest";
import { constants, type BlockIdentifier, type ProviderInterface } from "starknet";
import {
  CallMockProofProvider,
  type CallMockProofProviderOptions,
} from "../../src/internal/mock-proving.js";
import { buildProofFacts } from "../../src/utils/proof-facts.js";
import type { ProofInvocation } from "../../src/interfaces.js";

const POOL_ADDRESS = "0x1";
const POOL_CLASS_HASH = "0xdec1a23ed";
const SERVER_ACTIONS = ["0xac1", "0xac2"];
const LATEST_BLOCK_NUMBER = 100;
const CHAIN_ID = constants.StarknetChainId.SN_MAIN;

// __execute__ calldata of a single call: [n_calls, to, selector, inner_len, ...inner].
const INVOCATION = {
  sender_address: POOL_ADDRESS,
  calldata: ["0x1", POOL_ADDRESS, "0x0", "0x1", "0x0"],
} as unknown as ProofInvocation;

const blockHashOf = (blockNumber: number) => `0x${(blockNumber + 0xb00).toString(16)}`;

/** A node with blocks 0..LATEST_BLOCK_NUMBER, all reporting `starknetVersion`. */
function makeNode(starknetVersion: string): ProviderInterface {
  const blockAt = (blockNumber: number) => ({
    block_number: blockNumber,
    block_hash: blockHashOf(blockNumber),
    starknet_version: starknetVersion,
  });
  return {
    getBlock: async (blockIdentifier: BlockIdentifier) =>
      blockAt(blockIdentifier === "latest" ? LATEST_BLOCK_NUMBER : Number(blockIdentifier)),
    callContract: async () => SERVER_ACTIONS,
    getClassHashAt: async () => POOL_CLASS_HASH,
  } as unknown as ProviderInterface;
}

async function proveProofFacts(
  starknetVersion: string,
  blockIdentifier?: BlockIdentifier,
  options?: CallMockProofProviderOptions
): Promise<string[]> {
  const provider = new CallMockProofProvider(makeNode(starknetVersion), CHAIN_ID, {
    validateSignature: false,
    ...options,
  });
  return (await provider.prove(INVOCATION, blockIdentifier)).proofFacts;
}

const BASE_BLOCK_NUMBER_INDEX = 4;
const BASE_BLOCK_HASH_INDEX = 5;

describe("CallMockProofProvider base block", () => {
  it.each([
    ["no block identifier", undefined],
    ["the latest tag", "latest"],
    ["the latest block number", LATEST_BLOCK_NUMBER],
    ["a block inside the stored-hash buffer", LATEST_BLOCK_NUMBER - 5],
  ])("moves %s back to latest - 10", async (_, blockIdentifier) => {
    const proofFacts = await proveProofFacts("0.14.4", blockIdentifier);

    expect(proofFacts[BASE_BLOCK_NUMBER_INDEX]).toBe(
      `0x${(LATEST_BLOCK_NUMBER - 10).toString(16)}`
    );
    expect(proofFacts[BASE_BLOCK_HASH_INDEX]).toBe(blockHashOf(LATEST_BLOCK_NUMBER - 10));
  });

  it.each([LATEST_BLOCK_NUMBER - 10, LATEST_BLOCK_NUMBER - 50])(
    "keeps an explicit block %i that is old enough",
    async (blockNumber) => {
      const proofFacts = await proveProofFacts("0.14.4", blockNumber);

      expect(proofFacts[BASE_BLOCK_NUMBER_INDEX]).toBe(`0x${blockNumber.toString(16)}`);
      expect(proofFacts[BASE_BLOCK_HASH_INDEX]).toBe(blockHashOf(blockNumber));
    }
  );
});

describe("CallMockProofProvider protocol fields", () => {
  const expectedProofFacts = (starknetVersion: string) =>
    buildProofFacts(
      POOL_ADDRESS,
      POOL_CLASS_HASH,
      SERVER_ACTIONS,
      BigInt(LATEST_BLOCK_NUMBER - 10),
      blockHashOf(LATEST_BLOCK_NUMBER - 10),
      CHAIN_ID,
      { starknetVersion }
    );

  it.each(["0.14.2", "0.14.4"])("follows the base block's starknet_version %s", async (version) => {
    expect(await proveProofFacts(version)).toEqual(expectedProofFacts(version));
  });

  it("the 0.14.2 and 0.14.4 protocols produce different facts", () => {
    expect(expectedProofFacts("0.14.2")).not.toEqual(expectedProofFacts("0.14.4"));
  });

  it("applies proofFactsConfig over the block's version", async () => {
    const proofFacts = await proveProofFacts("0.14.4", undefined, {
      proofFactsConfig: { starknetVersion: "0.14.2", osConfigHash: "0xabc" },
    });

    const legacyProofFacts = expectedProofFacts("0.14.2");
    expect(proofFacts[0]).toBe(legacyProofFacts[0]);
    expect(proofFacts[2]).toBe(legacyProofFacts[2]);
    expect(proofFacts[6]).toBe("0xabc");
  });

  it("keeps the block's version when proofFactsConfig overrides only a field", async () => {
    const proofFacts = await proveProofFacts("0.14.2", undefined, {
      proofFactsConfig: { osConfigHash: "0xabc" },
    });

    expect(proofFacts.slice(0, 6)).toEqual(expectedProofFacts("0.14.2").slice(0, 6));
    expect(proofFacts[6]).toBe("0xabc");
  });
});
