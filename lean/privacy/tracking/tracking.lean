import privacy.tracking.outgoing_notes
import privacy.tracking.incoming_notes
import privacy.tracking.coin

theorem incoming_eq_outgoing
  {crypto: Crypto} (stxs: SuccessfulTransactions crypto) (addr: ℕ) (token: ℕ) :
  sum_cancel_note_amounts crypto stxs.rm addr token = (
    create_note_actions crypto stxs.rm
    |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = addr)
    |>.map (λ inp ↦ inp.amount)
    |>.sum
  ) := by
  rw [incoming_notes, outgoing_notes]
  conv => rhs; enter [1, 1, tx]; rw [tx.h_balance]

def created_coins (actions: List Action) (addralice token: ℕ) : List (Fin actions.length × ℕ) :=
  collect_coins actions
    (λ action ↦
      filter_CreateNote action
      |>.filter (λ inp ↦ inp.addralice = addralice)
      |>.map (λ inp ↦ (inp.token, inp.amount))
    )
    token

def canceled_coins (actions: List Action) (addrbob: ℕ) (token: ℕ) : List (Fin actions.length × ℕ) :=
  collect_coins actions
    (λ action ↦
      filter_CancelNote action
      |>.filter (λ inp ↦ inp.addrbob = addrbob)
      |>.map (λ inp ↦ (inp.token, inp.amount))
    )
    token

theorem created_coins_length {crypto: Crypto} (rm: ReachableMemory crypto) (addralice token: ℕ) :
    (created_coins rm.actions addralice token).length = (
      create_note_actions crypto rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = addralice)
      |>.map (λ inp ↦ inp.amount)
      |>.sum
    ) := by
  unfold created_coins create_note_actions
  rw [collect_coins_length]
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_actions
  cases action
  case CreateNote inp =>
    by_cases h: inp.token = token
    all_goals simp [h, Option.filter_some]
    by_cases h: inp.addralice = addralice
    all_goals simp [h, Option.filter_some]

  all_goals simp

theorem canceled_coins_length {crypto: Crypto} (rm: ReachableMemory crypto) (addrbob token: ℕ) :
    (canceled_coins rm.actions addrbob token).length = sum_cancel_note_amounts crypto rm addrbob token := by
  unfold canceled_coins sum_cancel_note_amounts cancel_note_actions
  rw [collect_coins_length]

  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_actions
  cases action
  case CancelNote inp =>
    by_cases h: inp.token = token
    all_goals simp [h, Option.filter_some]
    by_cases h: inp.addrbob = addrbob
    all_goals simp [h, Option.filter_some]

  all_goals simp

-- A bijection between `created_coins.toFinset` and `canceled_coins.toFinset`.
def coins_equiv {crypto: Crypto} (stxs: SuccessfulTransactions crypto) (addr token: ℕ) :
    (created_coins stxs.rm.actions addr token).toFinset ≃ (canceled_coins stxs.rm.actions addr token).toFinset :=
  two_lists_equiv
    (created_coins stxs.rm.actions addr token)
    (canceled_coins stxs.rm.actions addr token)
    (by rw [created_coins_length, canceled_coins_length, incoming_eq_outgoing])
    collect_coins_nodup
    collect_coins_nodup
