import privacy.actions
import privacy.transactions.transaction0
import privacy.notes.note_implies

def Action.check_owner (action: Action) (owner: ℕ) : Prop :=
  match action with
  | .Register inp => inp.addralice = owner
  | .OpenChannel inp => inp.addralice = owner
  | .OpenSubchannel inp => inp.addralice = owner
  | .CreateNote inp => inp.addralice = owner
  | .UseNote inp => inp.addrbob = owner
  | .OpenDeposit _ => true

structure ActionFuncRes where
  (token amount owner: ℕ)

def ActionFuncRes.from_create (inp: CreateNoteInput) : ActionFuncRes :=
  { token := inp.token, amount := inp.amount, owner := inp.addralice }

def ActionFuncRes.from_use (inp: UseNoteInput) : ActionFuncRes :=
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

def ActionFunc.create_nonopen : ActionFunc := {
  f := λ (a: Action) ↦ (filter_CreateNote a) |>.filter (λ inp ↦ inp.r ≠ 1) |>.map ActionFuncRes.from_create,
  h_owner := by
    intro action res h_some owner'
    simp only [filter_CreateNote, Option.map_eq_some_iff, Action.check_owner] at h_some ⊢
    obtain ⟨action', h_some, h_some'⟩ := h_some
    cases action
    case CreateNote inp =>
      simp only [Option.filter_some] at h_some
      by_cases h_r: inp.r ≠ 1
      case pos =>
        simp [h_r] at h_some
        rw [←h_some', ActionFuncRes.from_create, h_some]
      case neg => simp [h_r] at h_some
    all_goals contradiction
}

def ActionFunc.use : ActionFunc := {
  f := λ (a: Action) ↦ (filter_UseNote a).map ActionFuncRes.from_use,
  h_owner := by
    intro action res h_some owner'
    simp only [filter_UseNote, Option.map_eq_some_iff, Action.check_owner] at h_some ⊢
    obtain ⟨action', h_some, h_some'⟩ := h_some
    cases action
    case UseNote inp =>
      simp only [Option.some.injEq] at h_some
      rw [←h_some', ActionFuncRes.from_use, h_some]
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

abbrev Transaction₀.sum_use_note_amounts (tx: Transaction₀) (token: ℕ) : ℕ :=
  tx.sum_amounts .use token

structure Transaction extends TimedTransaction where
  owner: ℕ
  h_owner: ∀ action ∈ actions, action.check_owner owner
  h_balance: ∀ token, toTransaction₀.sum_create_note_amounts token = toTransaction₀.sum_use_note_amounts token

structure SuccessfulTransactions (crypto: Crypto) where
  txs: List Transaction
  success: (run_transactions crypto (txs.map Transaction.toTimedTransaction)).success

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

theorem Transaction.sum_create_note_amounts_eq_nonopen
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (tx: Transaction) (h: tx ∈ stxs.txs)
    (token: ℕ) :
    tx.sum_create_note_amounts token =
    tx.sum_amounts .create_nonopen token := by
  simp only [Transaction₀.sum_create_note_amounts, Transaction₀.sum_amounts, ActionFunc.create_nonopen, ActionFunc.create]
  simp only [List.filter_filterMap, filterMap_map_sum_to_getD]
  apply congrArg
  apply List.map_congr_left

  intro action h_action

  cases action
  case CreateNote inp =>
    by_cases h_r: inp.r = 1
    case pos =>
      have h_action' : .CreateNote inp ∈ stxs.rm.actions := by
        rw [SuccessfulTransactions.rm]
        simp only [List.bind_eq_flatMap, List.mem_flatMap, List.mem_map, exists_exists_and_eq_and]
        exact ⟨tx, h, h_action⟩
      have h_amount : inp.amount = 0 := by
        have ⟨note_imp⟩ := NoteImplies.from_action h_action'
        exact (note_imp.h_open_note h_r).2
      simp only [filter_CreateNote, Option.filter_some, h_r]

      by_cases h_token: inp.token = token
      case pos =>
        simp [Option.filter_some, ActionFuncRes.from_create, h_token, h_amount]
      case neg =>
        simp [Option.filter_some, ActionFuncRes.from_create, h_token]
    case neg =>
      simp [filter_CreateNote, Option.filter_some, h_r]

  all_goals simp
