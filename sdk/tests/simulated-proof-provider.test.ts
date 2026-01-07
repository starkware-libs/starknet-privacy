import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Devnet } from "starknet-devnet";
import {
  RpcProvider,
  Account,
  Contract,
  CallData,
  json,
  transaction,
  type CompiledSierra,
  type CairoAssembly,
  type Call,
} from "starknet";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { SimulatedProofProvider } from "../src/proof_providers/simulated.js";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to compiled Echo contract artifacts
const CONTRACTS_PATH = path.join(__dirname, "../../packages/test_contracts/compiled");
const ECHO_SIERRA_PATH = path.join(CONTRACTS_PATH, "test_contracts_Echo.contract_class.json");
const ECHO_CASM_PATH = path.join(
  CONTRACTS_PATH,
  "test_contracts_Echo.compiled_contract_class.json"
);

describe("SimulatedProofProvider", () => {
  let devnet: Devnet;
  let provider: RpcProvider;
  let account: Account;
  let echoContract: Contract;

  beforeAll(async () => {
    // Spawn devnet (auto-downloads if not installed)
    devnet = await Devnet.spawnVersion("latest", {
      args: ["--seed", "0"],
    });

    // Create RpcProvider
    provider = new RpcProvider({ nodeUrl: devnet.provider.url });

    // Get predeployed account
    const predeployedAccounts = await devnet.provider.getPredeployedAccounts();
    const predeployed = predeployedAccounts[0];
    account = new Account({
      provider,
      address: predeployed.address,
      signer: predeployed.private_key,
    });

    // Load and deploy Echo contract
    const sierraCode = json.parse(fs.readFileSync(ECHO_SIERRA_PATH, "utf-8")) as CompiledSierra;
    const casmCode = json.parse(fs.readFileSync(ECHO_CASM_PATH, "utf-8")) as CairoAssembly;

    // Declare contract first
    const declareResponse = await account.declare({
      contract: sierraCode,
      casm: casmCode,
    });
    await provider.waitForTransaction(declareResponse.transaction_hash);

    // Deploy using UDC
    const UDC_ADDRESS = "0x41A78E741E5AF2FEC34B695679BC6891742439F7AFB8484ECD7766661AD02BF";
    const salt = "0x0"; // Use deterministic salt
    const unique = false;

    const deployCall: Call = {
      contractAddress: UDC_ADDRESS,
      entrypoint: "deployContract",
      calldata: CallData.compile({
        classHash: declareResponse.class_hash,
        salt,
        unique,
        calldata: [], // No constructor args for Echo
      }),
    };

    const deployResponse = await account.execute(deployCall);
    await provider.waitForTransaction(deployResponse.transaction_hash);

    // Calculate the deployed contract address
    const deployedAddress = await provider.getTransactionReceipt(deployResponse.transaction_hash);
    // Extract contract address from events
    const deployEvent = (deployedAddress as { events?: Array<{ data?: string[] }> }).events?.find(
      (e) => e.data && e.data.length >= 1
    );
    const contractAddress = deployEvent?.data?.[0];

    if (!contractAddress) {
      throw new Error("Failed to get deployed contract address");
    }

    // Create contract instance
    echoContract = new Contract({
      abi: sierraCode.abi,
      address: contractAddress,
      providerOrAccount: provider,
    });
  }, 60000); // 60s timeout for setup

  afterAll(() => {
    devnet?.kill();
  });

  /**
   * Build an invocation for a set of calls.
   * Since we use skipValidate=true in simulation, we don't need to sign
   * or use the correct nonce.
   */
  function buildInvocation(calls: Call[]) {
    // Build calldata for the account's __execute__ (Cairo 1 format)
    const calldata = transaction.getExecuteCalldata(calls, "1");

    return {
      contractAddress: account.address,
      calldata,
      signature: [], // Empty signature - validation is skipped
    };
  }

  it("should simulate transaction and return execution result", async () => {
    const simulatedProvider = new SimulatedProofProvider({
      nodeUrl: devnet.provider.url,
    });

    // Build a call to the echo function
    const call: Call = {
      contractAddress: echoContract.address,
      entrypoint: "echo",
      calldata: CallData.compile({ a: 42n, b: 123n }),
    };

    // Build the invocation (no signature needed for simulation)
    const invocation = buildInvocation([call]);

    // Use SimulatedProofProvider to prove
    const proof = await simulatedProvider.prove(invocation);

    // Verify the proof contains the execution result
    expect(proof.output).toBeDefined();
    expect(proof.output.length).toBeGreaterThan(0);

    // The echo function returns (a, b) which should be in the result
    // The result format depends on the account's __execute__ return format
    // For OZ accounts, it returns the outputs of all calls
    expect(proof.output).toContain("0x2a"); // 42 in hex
    expect(proof.output).toContain("0x7b"); // 123 in hex
  });

  it("should throw on reverted transaction", async () => {
    const simulatedProvider = new SimulatedProofProvider({
      nodeUrl: devnet.provider.url,
    });

    // Build an invalid invocation (calling non-existent function)
    const invalidCall: Call = {
      contractAddress: echoContract.address,
      entrypoint: "non_existent_function",
      calldata: [],
    };

    // Build the invocation (no signature needed for simulation)
    const invocation = buildInvocation([invalidCall]);

    // Should throw because the transaction will revert
    await expect(simulatedProvider.prove(invocation)).rejects.toThrow();
  });
});
