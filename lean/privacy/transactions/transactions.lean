import privacy.actions
import privacy.transactions.transaction0

def Action.check_owner (action: Action) (owner: ℕ) : Prop :=
  match action with
  | .Register inp => inp.addralice = owner
  | .CreateChannel inp => inp.addralice = owner
  | .CreateSubchannel inp => inp.addralice = owner
  | .CreateNote inp => inp.addralice = owner
  | .CancelNote inp => inp.addrbob = owner
  | .OpenDeposit _ => true

structure ActionFuncRes where
  (token amount owner: ℕ)

def ActionFuncRes.from_create (inp: CreateNoteInput) : ActionFuncRes :=
  { token := inp.token, amount := inp.amount, owner := inp.addralice }

def ActionFuncRes.from_cancel (inp: CancelNoteInput) : ActionFuncRes :=
  { token := inp.token, amount := inp.amount, owner := inp.addrbob }

structure ActionFunc where
  f: Action → Option ActionFuncRes
  h_owner: ∀ action res, f action = some res →
    ∀ owner', res.owner = owner' ↔ action.check_owner owner'

def ActionFunc.create : ActionFunc := {
  f := λ (a: Action) ↦ (filter_CreateNote a).map ActionFuncRes.from_create,
  h_owner := by
    intro action res h_some owner'
    simp only [filter_CreateNote, Option.map_eq_some_iff, Action.check_owner] at h_some ⊢
    obtain ⟨action', h_some, h_some'⟩ := h_some
    cases action
    case CreateNote inp =>
      simp only [Option.some.injEq] at h_some
      rw [←h_some', ActionFuncRes.from_create, h_some]
    all_goals contradiction
}

def ActionFunc.cancel : ActionFunc := {
  f := λ (a: Action) ↦ (filter_CancelNote a).map ActionFuncRes.from_cancel,
  h_owner := by
    intro action res h_some owner'
    simp only [filter_CancelNote, Option.map_eq_some_iff, Action.check_owner] at h_some ⊢
    obtain ⟨action', h_some, h_some'⟩ := h_some
    cases action
    case CancelNote inp =>
      simp only [Option.some.injEq] at h_some
      rw [←h_some', ActionFuncRes.from_cancel, h_some]
    all_goals contradiction
}

def Transaction₀.sum_amounts (tx: Transaction₀) (f: ActionFunc) (token: ℕ) : ℕ :=
  tx.actions
  |>.filterMap f.f
  |>.filter (λ res ↦ res.token = token)
  |>.map (λ res ↦ res.amount)
  |>.sum

abbrev Transaction₀.sum_create_note_amounts (tx: Transaction₀) (token: ℕ) : ℕ :=
  tx.sum_amounts .create token

abbrev Transaction₀.sum_cancel_note_amounts (tx: Transaction₀) (token: ℕ) : ℕ :=
  tx.sum_amounts .cancel token

structure Transaction extends TimedTransaction where
  owner: ℕ
  h_owner: ∀ action ∈ actions, action.check_owner owner
  h_balance: ∀ token, toTransaction₀.sum_create_note_amounts token = toTransaction₀.sum_cancel_note_amounts token

structure SuccessfulTransactions (crypto: Crypto) where
  txs: List Transaction
  success: (run_transactions crypto ttxs).success

abbrev SuccessfulTransactions.timed_txs {crypto: Crypto} (stxs: SuccessfulTransactions crypto) :=
  stxs.txs.map Transaction.toTimedTransaction

abbrev SuccessfulTransactions.m {crypto: Crypto} (stxs: SuccessfulTransactions crypto) :=
  (run_transactions crypto stxs.timed_txs).m

abbrev SuccessfulTransactions.rm {crypto: Crypto} (stxs: SuccessfulTransactions crypto) : ReachableMemory crypto :=
  {
    actions := stxs.timed_txs >>= (λ tx ↦ tx.actions)
    success := by
      have ⟨rm, h, _⟩ := run_transactions_is_reachable crypto stxs.timed_txs stxs.success
      rw [←h]
      exact rm.success
  }
