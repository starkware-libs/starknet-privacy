import privacy.actions
import privacy.amounts
import privacy.compliance.all_notes
import privacy.notes.used_notes
import privacy.registration.discoverable
import privacy.tracing.utils
import privacy.transactions.transactions
import privacy.transactions.withdrawals

theorem withdrawals_for_user_token_sum
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (user: UserPrivKey crypto stxs.rm.m) (token: ℕ) :
    (
      withdrawals_for_user_token (.from stxs.rm) stxs.events user token
      |>.map (λ evt ↦ evt.amount)
      |>.sum
    ) = (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = user.addr)
      |>.map (λ tx ↦ tx.sum_withdraw_amounts token)
      |>.sum
    ) := by
  unfold withdrawals_for_user_token
  rw [withdrawals_for_user.eq]
  rw [mapIdx_filter_map
    (h_p := by intros; simp)
    (h_q := by intros; simp)
  ]

  simp only [List.flatMap_reverse, List.filter_reverse, List.map_reverse, List.sum_reverse]
  simp only [List.filter_flatMap, List.map_flatMap]
  conv => rhs; rw [←List.filterMap_eq_filter, List.map_filterMap]
  rw [List.filterMap_eq_flatMap_toList]
  unfold List.flatMap
  rw [List.sum_flatten, List.sum_flatten]
  apply congrArg
  simp only [List.map_map]
  apply List.map_congr_left
  intro tx h_tx

  by_cases h_owner: tx.owner = user.addr
  case neg =>
    simp [h_owner, Option.guard]
  case pos =>
    simp [h_owner, Transaction₀.sum_amounts]
    apply congrArg
    simp only [List.filter_filterMap, List.map_filterMap]
    apply List.filterMap_congr
    intro action h_action

    simp [ActionFunc.withdraw, filter_Withdraw]
    cases action
    case Withdraw inp =>
      simp only [Option.map_some, Option.filter_some]
      split
      case isTrue h_token =>
        simp only [decide_eq_true_eq] at h_token
        simp only [h_token, Option.map_some, decide_eq_true_eq, Option.map_if,
          Option.some_eq_ite_none_right, Option.some.injEq]
        exact ⟨h_token, by rfl⟩
      case isFalse h_token =>
        simp only [decide_eq_true_eq] at h_token
        simp
        exact h_token

    all_goals simp
