import privacy.actions
import privacy.amounts
import privacy.compliance.all_notes
import privacy.notes.canceled_notes
import privacy.registration.discoverable
import privacy.transactions.transactions
import privacy.tracking.utils

theorem incoming_notes
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (addrbob: ℕ) (token: ℕ) :
    sum_cancel_note_amounts crypto stxs.rm addrbob token = (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = addrbob)
      |>.map (λ tx ↦ tx.sum_cancel_note_amounts token)
      |>.sum
    ) := by
  rw [←filtered_note_actions_to_tx_actions]
  unfold sum_cancel_note_amounts cancel_note_actions ActionFunc.cancel ActionFuncRes.from_cancel
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_action
  cases h_some: filter_CancelNote action
  case none => simp
  case some inp => simp [Option.filter_some]
