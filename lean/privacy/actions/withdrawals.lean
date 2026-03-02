import privacy.actions.action_spec
import privacy.actions.run_action
import privacy.actions.reachable_memory

structure WithdrawalImplies
    {crypto: Crypto} (rm: ReachableMemory crypto) (inp: WithdrawInput) where
  h_action: .Withdraw inp ∈ rm.actions
  amount_nz: inp.amount ≠ 0

theorem WithdrawalImplies.next
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: WithdrawInput}
    {action: Action} (success: (run_action crypto action rm.m).success)
    (withdrawal_imp: WithdrawalImplies rm inp) :
    Nonempty (WithdrawalImplies (rm.add action success) inp) :=
  ⟨{
    h_action := by simp [withdrawal_imp.h_action]
    amount_nz := withdrawal_imp.amount_nz
  }⟩

theorem WithdrawalImplies.from_action
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: WithdrawInput}
    (h: .Withdraw inp ∈ rm.actions) :
    Nonempty (WithdrawalImplies rm inp) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h
  cases h
  case head =>
    simp only [run_action, run_action₀, withdraw] at success
    simp only [ne_eq, decide_not, Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true,
      decide_eq_false_iff_not] at success
    exact ⟨{
      h_action := by simp [ReachableMemory.add]
      amount_nz := success.1
    }⟩
  case tail h =>
    have ⟨ih⟩ := ih h
    exact ih.next success

def withdraw_actions (crypto: Crypto) (rm: ReachableMemory crypto) : List WithdrawInput :=
  rm.actions.filterMap filter_Withdraw

theorem WithdrawalImplies.in_withdraw_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: WithdrawInput}
    (withdrawal_imp: WithdrawalImplies rm inp) :
    inp ∈ withdraw_actions crypto rm := by
  simp [withdraw_actions]
  use .Withdraw inp
  simp [withdrawal_imp.h_action]

theorem WithdrawalImplies.from_withdraw_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: WithdrawInput}
    (h: inp ∈ withdraw_actions crypto rm) :
    Nonempty (WithdrawalImplies rm inp) := by
  simp only [withdraw_actions, List.mem_filterMap, filter_Withdraw_some, exists_eq_right] at h
  exact WithdrawalImplies.from_action h
