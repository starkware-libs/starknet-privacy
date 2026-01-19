import privacy.transactions.transactions

theorem filtered_note_actions_to_tx_actions
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (f: ActionFunc)
    (addrbob: ℕ) (token: ℕ) :
    (
      stxs.rm.actions
      |>.filterMap f.f
      |>.filter (λ res ↦ res.token = token ∧ res.owner = addrbob)
      |>.map (λ res ↦ res.amount)
      |>.sum
    ) = (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = addrbob)
      |>.map (λ tx ↦ tx.sum_amounts f token)
      |>.sum
    ) := by
  simp [SuccessfulTransactions.timed_txs]

  induction stxs.txs
  case nil => trivial

  case cons tx txs ih =>
    rw [(by simp : tx :: txs = [tx] ++ txs)]
    rw [List.filter_append]
    simp only [List.cons_append, List.nil_append, List.map_cons, List.flatMap_cons,
      List.filterMap_append, List.filter_append, List.map_append, List.sum_append] at ih ⊢
    apply congrArg₂
    case hy => exact ih
    case hx =>
      by_cases h: tx.owner = addrbob
      case neg =>
        apply congrArg
        simp only [h, decide_false, Bool.false_eq_true, not_false_eq_true, List.filter_cons_of_neg,
          List.filter_nil, List.map_nil, List.map_eq_nil_iff, List.filter_eq_nil_iff,
          List.mem_filterMap, forall_exists_index, Bool.and_eq_true, decide_eq_true_eq, not_and,
          and_imp]
        intro res action h_action h_some h_token h_owner
        have h_check_owner := tx.h_owner action h_action

        have := (f.h_owner action res h_some tx.owner).2 h_check_owner
        rw [←h_owner, this] at h
        contradiction

      case pos =>
        simp only [Transaction₀.sum_amounts, h, decide_true, List.filter_cons_of_pos,
          List.filter_nil, List.map_cons, List.map_nil, List.sum_cons, List.sum_nil, add_zero]
        apply congrArg
        apply congrArg
        simp only [List.filter_filterMap]
        apply List.filterMap_congr
        intro action h_action
        have h_check_owner := tx.h_owner action h_action

        cases h_some: f.f action
        case some res =>
          have := (f.h_owner action res h_some tx.owner).2 h_check_owner
          simp [Option.filter_some, this, h]
        case none => simp
