import type { Account, RpcProvider } from "starknet";

/** `OpenNoteScreeningPolicy::Exempt` — the second variant, so index 1. */
const POLICY_EXEMPT = 1n;

/**
 * `Role::AppRoleAdmin` and `Role::AppGovernor`, as the chain expects them.
 *
 * `Role` carries a hand-written `Serde` that sends a role *id* — `keccak("ROLE_<NAME>") & 2^250-1`,
 * the constants in `starkware_utils::components::roles::interface` — rather than the variant index
 * the ABI's variant list suggests. Passing an index fails deserialization inside `grant_role`.
 */
const ROLE_APP_ROLE_ADMIN = "0x3e615638e0b79444a70f8c695bf8f2a47033bf1cf95691ec3130f64939cee99";
const ROLE_APP_GOVERNOR = "0xd2ead78c620e94b02d0a996e99298c59ddccfa1d8a0149080ac3a20de06068";

/**
 * Lists `depositor` as an open-note depositor whose deposits carry no screening requirement.
 *
 * An Invoke target that funds open notes and carries no policy is the transaction's screening
 * subject, so the pool demands an attestation naming the target itself. Anonymizers and executors
 * act on behalf of many users and are exempt on the deployed pools, so a devnet exercising those
 * flows has to list them too, or every deposit through one reverts with `SCREENING_REQUIRED`.
 *
 * `admin` deploys the pool as its governance admin, which is not the role that sets policies. Walk
 * the pool's role graph the same way its Cairo test harness does: the governance admin grants
 * itself `AppRoleAdmin`, which grants it `AppGovernor`, which may then set the policy. All three
 * calls ride one transaction, in order. Re-granting a held role is a no-op, so calling this for
 * several depositors is safe.
 */
export async function exemptOpenNoteDepositor(
  admin: Account,
  provider: RpcProvider,
  poolAddress: string,
  depositor: string
): Promise<void> {
  const { transaction_hash } = await admin.execute([
    {
      contractAddress: poolAddress,
      entrypoint: "grant_role",
      calldata: [ROLE_APP_ROLE_ADMIN, admin.address],
    },
    {
      contractAddress: poolAddress,
      entrypoint: "grant_role",
      calldata: [ROLE_APP_GOVERNOR, admin.address],
    },
    {
      contractAddress: poolAddress,
      entrypoint: "set_open_note_screening_policy",
      calldata: [depositor, POLICY_EXEMPT],
    },
  ]);
  const receipt = await provider.waitForTransaction(transaction_hash);
  if (!receipt.isSuccess()) {
    throw new Error(`Failed to exempt ${depositor}: ${transaction_hash}`);
  }
}
