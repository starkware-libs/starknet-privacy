import privacy.actions
import privacy.amounts
import privacy.compliance.all_notes
import privacy.notes.canceled_notes
import privacy.registration.discoverable
import privacy.transactions.transactions
import privacy.tracing.utils

theorem incoming_notes
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (bob: UserPrivKey crypto stxs.rm.m)
    (token: ℕ) :
    (
      spent_notes (.from stxs.rm) bob.addr bob.k token
      |>.map (λ sn ↦ sn.amount crypto stxs.rm)
      |>.sum
    ) = (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = bob.addr)
      |>.map (λ tx ↦ tx.sum_cancel_note_amounts token)
      |>.sum
    ) := by
  rw [←sum_of_canceled_notes_to_scanned_notes bob token]
  rw [←filtered_note_actions_to_tx_actions]
  unfold sum_cancel_note_amounts cancel_note_actions ActionFunc.cancel ActionFuncRes.from_cancel
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_action
  cases h_some: filter_CancelNote action
  case none => simp
  case some inp => simp [Option.filter_some]
