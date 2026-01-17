import privacy.actions
import privacy.amounts
import privacy.compliance.all_notes
import privacy.notes.canceled_notes
import privacy.registration.discoverable
import privacy.transactions.transactions
import privacy.tracking.utils

theorem outgoing_notes
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (addralice: ℕ) (token: ℕ) :
    (
      create_note_actions crypto stxs.rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = addralice)
      |>.map (λ inp ↦ inp.amount)
      |>.sum
    ) = (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = addralice)
      |>.map (λ tx ↦ tx.sum_create_note_amounts token)
      |>.sum
    ) := by
  rw [←filtered_note_actions_to_tx_actions]
  unfold create_note_actions ActionFunc.create ActionFuncRes.from_create
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_action
  cases h_some: filter_CreateNote action
  case none => simp
  case some inp => simp [Option.filter_some]
