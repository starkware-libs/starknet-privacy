import privacy.actions
import privacy.amounts
import privacy.compliance.all_notes
import privacy.notes.canceled_notes
import privacy.notes.discoverable_outgoing
import privacy.registration.discoverable
import privacy.tracing.utils
import privacy.transactions.transactions
import privacy.amounts.outgoing

theorem outgoing_notes
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (alice: UserPrivKey crypto stxs.rm.m) (token: ℕ) :
    (
      nonopen_created_notes (.from stxs.rm) alice.addr alice.k token
      |>.map (λ sn ↦ sn.amount crypto stxs.rm)
      |>.sum
    ) = (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = alice.addr)
      |>.map (λ tx ↦ tx.sum_amounts .create_nonopen token)
      |>.sum
    ) := by
  rw [sum_of_nonopen_created_notes_to_scanned_notes alice token]
  rw [←filtered_note_actions_to_tx_actions]

  unfold create_note_actions ActionFunc.create_nonopen ActionFuncRes.from_create
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_action

  cases h_some: filter_CreateNote action
  case none => simp
  case some inp =>
    by_cases h_r: inp.r = 1
    all_goals simp [Option.filter_some, h_r]
