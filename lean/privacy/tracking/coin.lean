import privacy.transactions.transactions

abbrev Transaction.ActionIdx (tx: Transaction) := Fin (tx.actions.length)

-- Map from action to optional (token, amount) pair.
private abbrev CollectCoinsFunc := Action → Option (ℕ × ℕ)

def Transaction.collect_coins (tx: Transaction) (f: CollectCoinsFunc) (token: ℕ) : List (tx.ActionIdx × ℕ) :=
  tx.actions
  |>.mapFinIdx (λ idx action h_idx ↦ ((⟨idx, h_idx⟩: tx.ActionIdx), action))
  |>.flatMap (λ (idx, action) ↦ (
    f action
    |>.filter (λ (token', _) ↦ token' = token)
    |>.map (λ (_, amount) ↦ (List.range amount).map (λ x ↦ (idx, x)))
    |>.getD []
  ))

theorem Transaction.collect_coins_length {tx: Transaction} {f: CollectCoinsFunc} {token: ℕ} :
    (tx.collect_coins f token).length =
    (tx.actions
      |>.filterMap f
      |>.filter (λ (token', _) ↦ token' = token)
      |>.map (λ (_, amount) ↦ amount) |>.sum) := by
  unfold Transaction.collect_coins
  rw [List.length_flatMap]
  rw [List.map_congr_left (by
    intro ⟨idx, action⟩ h_idx_action
    let g := λ a: tx.ActionIdx × Action ↦ (f a.2).map (λ val ↦ if val.1= token then val.2 else 0) |>.getD 0
    show _ = g (idx, action)
    simp only [g]
    cases f action
    case none => simp
    case some val =>
      simp [Option.filter_some]
      by_cases h: val.1 = token
      case pos => simp [h]
      case neg => simp [h]
  )]
  rw [map_maxFinIdx]
  rw [mapFinIdx_eq_map (λ action: Action ↦ (f action).map (λ val ↦ if val.1 = token then val.2 else 0) |>.getD 0)]
  simp [filter_map_sum_to_ite, filterMap_map_sum_to_getD]

theorem Transaction.collect_coins_nodup {tx: Transaction} {f: CollectCoinsFunc} {token: ℕ} :
    (tx.collect_coins f token).Nodup := by
  apply mapFinIdx_flatMap_Nodup (j := λ (idx, x) ↦ idx)
  case g_nodup =>
    intro ⟨idx, action⟩
    simp only
    cases f action
    case some val =>
      by_cases h: val.1 = token
      case pos =>
        simp [Option.filter_some, h]
        apply List.Nodup.map
        · intro a b hab
          simp only [Prod.mk.injEq] at hab
          exact hab.2
        · exact List.nodup_range
      case neg => simp [Option.filter_some, h]
    case none => simp

  case h_j =>
    intro i action h_idx res h_res
    simp only at h_res
    cases h_f: f action
    case some val =>
      rw [h_f] at h_res
      by_cases h: val.1 = token
      case pos =>
        simp only [Option.filter_some, h, decide_true, ↓reduceIte, Option.map_some,
          Option.getD_some, List.mem_map, List.mem_range] at h_res
        have ⟨_, _, h_res⟩ := h_res
        rw [←h_res]
      case neg => simp [Option.filter_some, h] at h_res
    case none => simp [h_f] at h_res

def Transaction.created_coins (tx: Transaction) (token: ℕ) : List (tx.ActionIdx × ℕ) :=
  tx.collect_coins
    (λ action ↦ (filter_CreateNote action).map (λ inp ↦ (inp.token, inp.amount)))
    token

def Transaction.canceled_coins (tx: Transaction) (token: ℕ) : List (tx.ActionIdx × ℕ) :=
  tx.collect_coins
   (λ action ↦ (filter_CancelNote action).map (λ inp ↦ (inp.token, inp.amount)))
   token

theorem created_coins_length (tx: Transaction) (token: ℕ) :
    (tx.created_coins token).length = tx.sum_create_note_amounts token := by
  unfold Transaction.created_coins
  rw [tx.collect_coins_length]
  simp only [Transaction₀.sum_create_note_amounts]
  unfold Transaction₀.sum_amounts ActionFunc.create ActionFuncRes.from_create
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_actions
  cases action
  case CreateNote inp =>
    by_cases h: inp.token = token
    all_goals simp [h, Option.filter_some]

  all_goals simp

theorem canceled_coins_length (tx: Transaction) (token: ℕ) :
    (tx.canceled_coins token).length = tx.sum_cancel_note_amounts token := by
  unfold Transaction.canceled_coins
  rw [tx.collect_coins_length]
  simp only [Transaction₀.sum_cancel_note_amounts]
  unfold Transaction₀.sum_amounts ActionFunc.cancel ActionFuncRes.from_cancel
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_actions
  cases action
  case CancelNote inp =>
    by_cases h: inp.token = token
    all_goals simp [h, Option.filter_some]

  all_goals simp

-- A bijection between `created_coins.toFinset` and `canceled_coins.toFinset`.
def Transaction.coins_equiv (tx: Transaction) (token: ℕ) :
    (tx.created_coins token).toFinset ≃ (tx.canceled_coins token).toFinset :=
  two_lists_equiv
    (tx.created_coins token)
    (tx.canceled_coins token)
    (by rw [created_coins_length, canceled_coins_length, tx.h_balance])
    collect_coins_nodup
    collect_coins_nodup
