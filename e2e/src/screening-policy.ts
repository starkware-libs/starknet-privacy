import type { Account, RpcProvider } from "starknet";

import { executeAndWait } from "./utils.js";

/**
 * `OpenNoteScreeningPolicy::Exempt` — the second variant, so index 1.
 *
 * The variant order is load-bearing on-chain (`starknet::Store` numbers the `#[default]` variant 0
 * and the rest in declaration order), and the pool's own doc forbids reordering, so indexing by
 * position is stable.
 */
const POLICY_EXEMPT = 1n;

/**
 * `Role::AppGovernor` and `Role::AppRoleAdmin`, as the chain expects them.
 *
 * `Role` carries a hand-written `Serde` that sends a role *id* — `keccak("ROLE_<NAME>") & 2^250-1`,
 * the constants in `starkware_utils::components::roles::interface` — rather than the variant index
 * the ABI's variant list suggests. Passing an index fails deserialization inside `grant_role`.
 */
const ROLE_APP_GOVERNOR =
  "0xd2ead78c620e94b02d0a996e99298c59ddccfa1d8a0149080ac3a20de06068";
const ROLE_APP_ROLE_ADMIN =
  "0x3e615638e0b79444a70f8c695bf8f2a47033bf1cf95691ec3130f64939cee99";

/**
 * Lists `depositor` as an open-note depositor whose deposits carry no screening requirement.
 *
 * An Invoke target that funds open notes and carries no policy is the transaction's screening
 * subject, so the pool demands a screening attestation naming the target itself. The swap and
 * lending executors act on behalf of many users and are exempt on the deployed pools too — the
 * upgrade's governance batch lists them — so a devnet that exercises those flows has to list them
 * as well, or every deposit through one reverts with `SCREENING_REQUIRED`.
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
  depositor: string,
): Promise<void> {
  await executeAndWait(admin, provider, [
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
}
