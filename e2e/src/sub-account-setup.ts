import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Account, RpcProvider, type Abi } from "starknet";
import {
  artifactPair,
  declareClass,
  deployContract,
  repoRoot,
} from "./utils.js";

// `scarb build -t -p sub_account_anonymizer` emits these external contracts (sierra only) via the
// package's `[[test]] build-external-contracts`. Sourcing them from the workspace test build means
// no separate Scarb project, no duplicated `starkware_utils` rev pin, and no `MockDapp` mirror.
const TEST_BUILD_DIR = join(repoRoot(), "target/dev");
const TEST_TARGET_PREFIX = "sub_account_anonymizer_unittest";

export interface SubAccountAddresses {
  /** The SubAccountAnonymizer driven via the privacy pool's compute-and-invoke flow. */
  anonymizer: string;
  /** The dapp the deployed sub-account calls; `transfer_to_caller` returns funds to the sub-account. */
  mockDapp: string;
  /** The anonymizer's ABI, for compiling `privacy_invoke_with_computation` calldata. */
  anonymizerAbi: Abi;
}

/**
 * Declare a contract emitted by the workspace TEST build (`scarb build -t`), which produces sierra
 * only. `universal-sierra-compiler` compiles it to casm the same way snforge does, so the class is
 * declarable on devnet. USC ships with starknet-foundry and is set up in the e2e CI job.
 */
async function declareTestBuildContract(
  admin: Account,
  provider: RpcProvider,
  contractName: string,
): Promise<string> {
  const sierraPath = join(
    TEST_BUILD_DIR,
    `${TEST_TARGET_PREFIX}_${contractName}.test.contract_class.json`,
  );
  const casmPath = join(
    mkdtempSync(join(tmpdir(), "sub-account-casm-")),
    `${contractName}.casm.json`,
  );
  execFileSync("universal-sierra-compiler", [
    "compile-contract",
    "--sierra-path",
    sierraPath,
    "--output-path",
    casmPath,
  ]);
  return declareClass(admin, provider, sierraPath, casmPath);
}

/**
 * Declare + deploy the contracts the compute-and-invoke flow needs on devnet:
 * - `SubAccount` (workspace test build) — the class the anonymizer deploys per commitment.
 * - `SubAccountAnonymizer` (workspace build) — constructed with the privacy pool address, the
 *   SubAccount class hash, and `admin` as upgrade owner.
 * - `MockDapp` (workspace test build) — the target dapp the sub-account invokes.
 *
 * Idempotent on the class declarations (see `declareClass`); deploys use distinct salts.
 */
export async function deploySubAccountAnonymizer(
  admin: Account,
  provider: RpcProvider,
  privacyAddress: string,
): Promise<SubAccountAddresses> {
  const subAccountClassHash = await declareTestBuildContract(
    admin,
    provider,
    "SubAccount",
  );

  const anonymizerArtifact = artifactPair(
    join(repoRoot(), "target/dev"),
    "sub_account_anonymizer",
    "SubAccountAnonymizer",
  );
  const anonymizerClassHash = await declareClass(
    admin,
    provider,
    anonymizerArtifact.classPath,
    anonymizerArtifact.compiledPath,
  );
  const anonymizerAbi: Abi = JSON.parse(
    readFileSync(anonymizerArtifact.classPath, "utf8"),
  ).abi;
  // constructor(privacy_contract, sub_account_class_hash, governance_admin)
  const anonymizer = await deployContract(
    admin,
    provider,
    anonymizerClassHash,
    [privacyAddress, subAccountClassHash, admin.address],
    "0x900",
  );

  const mockDappClassHash = await declareTestBuildContract(
    admin,
    provider,
    "MockDapp",
  );
  const mockDapp = await deployContract(
    admin,
    provider,
    mockDappClassHash,
    [],
    "0x901",
  );

  return { anonymizer, mockDapp, anonymizerAbi };
}
