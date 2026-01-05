import privacy.actions
import privacy.utils

-- For certain memory spaces, once a value is written, it cannot be changed.
theorem immutability₀ (crypto: Crypto) (m: Memory) (action: Action) (t: MemoryType) (x: List ℕ)
    (h_nonzero: m t x ≠ 0)
    (h_t:
      t ≠ .PublicKeys ∧
      t ≠ .ChannelsJ ∧
      t ≠ .Channels ∧
      t ≠ .Notes ∧
      t ≠ .OpenNoteToken ∧
      (t = .Tokens → ∃ v, x = [v, 0])
    )
    (success: (run_action crypto action m).2)
    : (run_action crypto action m).1 t x = m t x := by
  cases action
  case Register inp =>
    let info := register_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _ (by simp [h_t])]

  case CreateChannel inp =>
    let info := create_channel_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _ (by simp [h_t]) (by simp [h_t])
      (λ h' ↦ h_nonzero (by rw [Prod.mk.injEq] at h'; simp [h'.1, h'.2, info.channel_didnt_exist]))]

  case CreateSubchannel inp =>
    let info := create_subchannel_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _
      (λ h' ↦ h_nonzero (by rw [Prod.mk.injEq] at h'; simp [h'.1, h'.2, info.old_hash_was_zero]))
      (λ h' ↦ h_nonzero (by rw [Prod.mk.injEq] at h'; simp [h'.1, h'.2, info.old_token_was_zero]))
      (λ h' ↦ by rw [Prod.mk.injEq] at h'; simp [h'] at h_t)]

  case CreateNote inp =>
    let info := create_note_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _
      (λ h' ↦ h_nonzero (by rw [Prod.mk.injEq] at h'; simp [h'.1, h'.2, info.old_value_was_zero]))
      (by simp [h_t])]

  case CancelNote inp =>
    let info := cancel_note_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _
      (λ h' ↦ h_nonzero (by rw [Prod.mk.injEq] at h'; simp [h'.1, h'.2, info.nullifier_didnt_exist]))]

  case OpenDeposit inp =>
    let info := open_deposit_info crypto inp m success
    rw [run_action, ←info.h_m',
      info.no_change _ _ (λ h' ↦ by rw [Prod.mk.injEq] at h'; simp [h'] at h_t)]

-- Once a value is non-zero in certain memory spaces, it cannot change.
theorem immutability {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm)
    {t: MemoryType} {x: List ℕ}
    (h_nonzero: rm.m t x ≠ 0)
    (h_t:
      t ≠ .PublicKeys ∧
      t ≠ .ChannelsJ ∧
      t ≠ .Channels ∧
      t ≠ .Notes ∧
      t ≠ .OpenNoteToken ∧
      (t = .Tokens → ∃ v, x = [v, 0])
    )
    : rm'.m t x = rm.m t x := by
  revert rm'
  apply invariant_induction_for_extends rm
  case inv₀ => trivial

  intro action rm' h_extends h success
  dsimp only [ReachableMemory.add]
  rwa [immutability₀ (h_t:=h_t) (h_nonzero:=by rwa [h]) (success:=success)]

-- For PublicKeys, once a value is written, it cannot be changed back to 0.
theorem public_key_stays_nonzero₀ (crypto: Crypto) (m: Memory) (action: Action) (x: List ℕ)
    (h_nonzero: m .PublicKeys x ≠ 0)
    (success: (run_action crypto action m).2)
    : (run_action crypto action m).1 .PublicKeys x ≠ 0 := by
  cases action
  case Register inp =>
    let info := register_info crypto inp m success
    rw [run_action, ←info.h_m']
    by_cases h: x = [inp.addrbob]
    case pos =>
      rw [h, info.memory_diff₀]
      exact crypto.zero_not_public_key ⟨inp.kbob, info.kbob_private_key⟩
    case neg => rwa [info.no_change _ _ (by simp [h])]

  all_goals trivial

-- Once a public key entry is non-zero, it stays non-zero.
theorem public_key_stays_nonzero {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm)
    {x: List ℕ}
    (h_nonzero: rm.m .PublicKeys x ≠ 0)
    : rm'.m .PublicKeys x ≠ 0 := by
  revert rm'
  apply invariant_induction_for_extends rm

  case inv₀ => trivial

  intro action rm' h_extends h success
  apply public_key_stays_nonzero₀ (success:=success)
  exact h

-- If the note is (r=1, amount=0), returns 0.
-- Otherwise, returns the packed encrypted value of the note.
def note_modified_value_fn (crypto: Crypto) (note_id: ℕ) :=
  λ (m: Memory) ↦ (
    let val := m .Notes [note_id, 0]
    if val = crypto.pack 1 0 then 0 else val
)

-- For PublicKeys, once a value is written, it cannot be changed back to 0.
theorem note_amount_immutable₀ (crypto: Crypto) (m: Memory) (action: Action) (note_id: ℕ)
    (success: (run_action crypto action m).2) :
    (m .Notes [note_id, 0] ≠ 0 → (run_action crypto action m).1 .Notes [note_id, 0] ≠ 0) ∧
    (note_modified_value_fn crypto note_id m ≠ 0 →
      note_modified_value_fn crypto note_id (run_action crypto action m).1 =
      note_modified_value_fn crypto note_id m) := by
  cases action
  case CreateNote inp =>
    let info := create_note_info crypto inp m success
    rw [run_action, ←info.h_m']
    by_cases h: note_id = inp.note_id crypto
    case pos =>
      constructor
      · intro h_nonzero
        simp [h, CreateNoteInput.note_id, CreateNoteInput.c, info.memory_diff₀]
        exact crypto.pack_nz info.r_ne_zero
      · intro h_nonzero
        have note_existed : m .Notes [note_id, 0] ≠ 0 := by
          by_contra h'
          dsimp only [note_modified_value_fn] at h_nonzero
          simp [h'] at h_nonzero
        have := info.old_value_was_zero
        rw [h] at note_existed
        have := note_existed this
        contradiction
    case neg =>
      constructor
      · intro h_nonzero
        rwa [info.no_change _ _ (by simpa) (by simp)]
      · intro h_nonzero
        unfold note_modified_value_fn
        rw [info.no_change _ _ (by simpa) (by simp)]

  case OpenDeposit inp =>
    let info := open_deposit_info crypto inp m success
    rw [run_action, ←info.h_m']
    by_cases h: note_id = inp.note_id
    case pos =>
      constructor
      · intro h_nonzero
        simp [h, info.memory_diff₀]
        exact crypto.pack_nz (by simp)
      · intro h_nonzero
        unfold note_modified_value_fn at *
        simp [h, info.old_value, ne_eq] at h_nonzero
    case neg =>
      constructor
      · intro h_nonzero
        rwa [info.no_change _ _ (by simp [h])]
      · intro h_nonzero
        unfold note_modified_value_fn
        rw [info.no_change _ _ (by simp [h])]

  all_goals exact ⟨by intro _; trivial, by intro _; trivial⟩

theorem note_amount_immutable {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm)
    {note_id: ℕ} :
    (rm.m .Notes [note_id, 0] ≠ 0 → rm'.m .Notes [note_id, 0] ≠ 0) ∧
    (note_modified_value_fn crypto note_id rm ≠ 0 →
      note_modified_value_fn crypto note_id rm' = note_modified_value_fn crypto note_id rm)  := by
  revert rm'
  apply invariant_induction_for_extends rm

  case inv₀ => exact ⟨by intro _; trivial, by intro _; trivial⟩

  intro action rm' h_extends h success
  constructor
  · intro h_nonzero
    exact (note_amount_immutable₀ crypto rm' action note_id success).1 (h.1 h_nonzero)
  · intro h_nonzero
    unfold ReachableMemory.add
    rw [(note_amount_immutable₀ crypto rm' action note_id success).2 (by rwa [h.2 h_nonzero])]
    exact h.2 h_nonzero

-------------------------

-- A function on the memory is called immutable if once it becomes non-zero, it cannot be changed.
def immutable_fn {β: Type} [Inhabited β] (m₀ m₁: Memory) (f: Memory → β) : Prop :=
  f m₀ ≠ default → f m₁ = f m₀

theorem immutable_fn_prop {m₀ m₁: Memory} {f: Memory → Bool} (imm: immutable_fn m₀ m₁ f) :
    f m₀ → (f m₁ ↔ f m₀) := by
  intro h
  rw [imm (by simp [h])]

def immutable_cell (m₀ m₁: Memory) (t: MemoryType) (x: List ℕ) : Prop :=
  immutable_fn m₀ m₁ (λ m: Memory ↦ m t x)

def note_exists_fn (note_id: ℕ) : Memory → Bool :=
  λ (m: Memory) ↦ decide (m .Notes [note_id, 0] ≠ 0)

theorem create_subchannel_immutable
    {crypto: Crypto} {m₀ m₁: Memory} (inp: CreateSubchannelInput)
    (imm₀: ∀ x, immutable_cell m₀ m₁ .ChannelHashes x)
    (imm₁: ∀ x, immutable_cell m₀ m₁ .Tokens [x, 0])
    (success: (run_action₀ crypto (.CreateSubchannel inp) m₀).2) :
    run_action₀ crypto (.CreateSubchannel inp) m₁ = run_action₀ crypto (.CreateSubchannel inp) m₀ := by
  dsimp only [run_action₀, create_subchannel] at *
  rw [decide_eq_true_iff] at success
  have ⟨h₀, h₁, h₂, h₃⟩ := success

  dsimp only [immutable_cell, immutable_fn] at imm₀ imm₁

  apply Prod.ext
  · trivial
  · simp only
    rw [imm₀ _ h₁]
    cases h₂
    case inl h₂ =>
      simp [h₂]
    case inr h₂ =>
      simp only [bne_iff_ne] at h₂
      rw [imm₁ _ h₂]

theorem create_note_immutable
    {crypto: Crypto} {m₀ m₁: Memory} (inp: CreateNoteInput)
    (imm₀: ∀ x, immutable_cell m₀ m₁ .SubchannelHashes x)
    (imm₁: ∀ x, immutable_fn m₀ m₁ (note_exists_fn x))
    (success: (run_action₀ crypto (.CreateNote inp) m₀).2) :
    run_action₀ crypto (.CreateNote inp) m₁ = run_action₀ crypto (.CreateNote inp) m₀ := by
  dsimp only [run_action₀, create_note] at *
  rw [decide_eq_true_iff] at success
  have ⟨h₀, h₁, h₂, h₃⟩ := success

  dsimp only [immutable_cell, immutable_fn] at imm₀
  unfold note_exists_fn at imm₁

  apply Prod.ext
  · trivial
  · simp only
    rw [imm₀ _ h₃]
    cases h₁
    case inl h₁ =>
      simp [h₁]
    case inr h₁ =>
      have := immutable_fn_prop (imm₁ (crypto.hash [CreateNoteInput.c crypto inp, inp.token, inp.i₀, inp.i₁ - 1])) (by simp; exact h₁)
      simp only [decide_eq_true_eq] at this
      conv => lhs; arg 1; rw [this]

theorem cancel_note_immutable
    {crypto: Crypto} {m₀ m₁: Memory} (inp: CancelNoteInput)
    (imm₀: ∀ x, immutable_cell m₀ m₁ .SubchannelHashes x)
    (imm₂: ∀ x, immutable_fn m₀ m₁ (note_modified_value_fn crypto x))
    (success: (run_action₀ crypto (.CancelNote inp) m₀).2) :
    run_action₀ crypto (.CancelNote inp) m₁ = run_action₀ crypto (.CancelNote inp) m₀ := by
  dsimp only [run_action₀, cancel_note] at *
  rw [decide_eq_true_iff] at success
  have ⟨h₀, h₁, h₂, h₃, h₅⟩ := success

  dsimp only [immutable_cell, immutable_fn] at imm₀ imm₂
  unfold note_modified_value_fn at imm₂

  apply Prod.ext
  · trivial
  · simp only
    rw [imm₀ _ h₀]
    dsimp only [note_amount]

    set val₀ := m₀ MemoryType.Notes [inp.note_id crypto, 0] with h_val₀

    have non_empty_note: val₀ ≠ crypto.pack 1 0 := by
      by_contra empty_note
      dsimp only [note_amount] at h₂
      rw [←h_val₀, empty_note, crypto.unpack_pack] at h₂
      simp at h₂
      omega

    have := imm₂ (inp.note_id crypto) (by simpa [←h_val₀, reduceIte, non_empty_note])
    simp only [←h_val₀, reduceIte, non_empty_note] at this
    rw [ite_eq_iff] at this
    simp [Ne.symm h₁] at this
    rw [this.2]

structure ImmutableCells (crypto: Crypto) (m₀ m₁: Memory) where
  (imm₀: ∀ x, immutable_cell m₀ m₁ .ChannelHashes x)
  (imm₁: ∀ x, immutable_cell m₀ m₁ .Tokens [x, 0])
  (imm₂: ∀ x, immutable_cell m₀ m₁ .SubchannelHashes x)
  (imm₃: ∀ x, immutable_fn m₀ m₁ (note_exists_fn x))
  (imm₄: ∀ x, immutable_fn m₀ m₁ (note_modified_value_fn crypto x))

theorem run_action₀_immutable
    {crypto: Crypto} {m₀ m₁: Memory} (actions: Action)
    (imm: ImmutableCells crypto m₀ m₁)
    (success: (run_action₀ crypto actions m₀).2) :
    run_action₀ crypto actions m₁ = run_action₀ crypto actions m₀ := by
  cases actions
  case Register inp => trivial
  case CreateChannel inp => trivial
  case CreateSubchannel inp => exact create_subchannel_immutable inp imm.imm₀ imm.imm₁ success
  case CreateNote inp => exact create_note_immutable inp imm.imm₂ imm.imm₃ success
  case CancelNote inp => exact cancel_note_immutable inp imm.imm₂ imm.imm₄ success
  case OpenDeposit inp => trivial

theorem ImmutableCells.of_extends
    (crypto: Crypto) {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm) :
    ImmutableCells crypto rm.m rm'.m := by
  constructor
  all_goals intro x h
  case imm₃ =>
    unfold note_exists_fn at *
    rw [decide_eq_decide]
    rw [Bool.default_bool, ne_eq, decide_eq_false_iff_not, not_not] at h
    simp [(note_amount_immutable h_extends).1 h, h]
  case imm₄ => exact (note_amount_immutable h_extends).2 h
  all_goals exact immutability h_extends h (by simp)

------------------------
-- Server-side action --
------------------------

-- The output of a ServerAction is the same if
-- (1) the input is the same, OR
-- (2) the action changed the value.
def reflection_prop (crypto: Crypto) (f: Memory → β) : Prop :=
  ∀ {m m': Memory},
  ∀ {sa: ServerAction},
  (h: f m = f m' ∨ f (sa.run crypto m).1 ≠ f m) → f (sa.run crypto m).1 = f (sa.run crypto m').1

-- Helper lemma for reflection₀: a single write either modifies the target cell (equal results)
-- or another cell (preserves the original relationship).
private lemma reflection_single_write
    {t t': MemoryType} {x x': List ℕ} {v: ℕ} {m m': Memory}
    (h: m t x = m' t x ∨ write t' x' v m t x ≠ m t x) :
    write t' x' v m t x = write t' x' v m' t x := by
  by_cases h' : t = t' ∧ x = x'
  case pos => simp [h'.1, h'.2, write_eq]
  case neg =>
    rw [write_ne (by simp [h']), write_ne (by simp [h'])]
    cases h
    case inl h => exact h
    case inr h => rw [write_ne (by simp [h'])] at h; contradiction

lemma reflection₀
    (crypto: Crypto)
    {t: MemoryType} {x: List ℕ}
    (h_t: t ≠ .ChannelsJ ∧ t ≠ .Channels) :
    reflection_prop crypto (λ m: Memory ↦ m t x) := by
  intro m m' sa h
  cases sa
  case Write t' x' v' => exact reflection_single_write h
  case WriteOnce t' x' v' => exact reflection_single_write h
  case Append t_idx' t' x' v' h_t' =>
    dsimp only [ServerAction.run] at h ⊢
    have h_ne_t : t ≠ t' := λ h' ↦ by simp [h', h_t'] at h_t
    have h_ne_idx : t ≠ t_idx' := λ h' ↦ by simp [h', h_t'] at h_t
    rw [write_ne (by simp [*]), write_ne (by simp [*]),
        write_ne (by simp [*]), write_ne (by simp [*])]
    rw [write_ne (by simp [*]), write_ne (by simp [*])] at h
    exact h.elim id (absurd rfl)
  case Check t' x' v' => exact h.elim id (absurd rfl)
  case OpenDeposit note_id amount token => exact reflection_single_write h

lemma reflection₁
    (crypto: Crypto) (note_id: ℕ) :
    reflection_prop crypto (note_exists_fn note_id) ∧
    reflection_prop crypto (note_modified_value_fn crypto note_id) := by
  apply forall_and.1; intro m
  apply forall_and.1; intro m'
  apply forall_and.1; intro sa

  unfold note_exists_fn at *
  simp [decide_eq_decide] at *
  cases sa

  case Write t' x' v' =>
    constructor
    all_goals
    . intro h
      dsimp only [ServerAction.run, note_modified_value_fn] at h ⊢
      by_cases h' : .Notes = t' ∧ [note_id, 0] = x'
      case pos => simp [h', write_eq]
      case neg =>
        cases h
        case inl h =>
          rw [write_ne (by simp [h'])]
          rwa [write_ne (by simp [h'])]
        case inr h =>
          rw [write_ne (by simp [h'])] at h
          try rw [iff_self] at h
          contradiction

  case WriteOnce t' x' v' =>
    constructor
    all_goals
    . intro h
      dsimp only [ServerAction.run, note_modified_value_fn] at h ⊢
      by_cases h' : .Notes = t' ∧ [note_id, 0] = x'
      case pos => simp [h', write_eq]
      case neg =>
        cases h
        case inl h =>
          rw [write_ne (by simp [h'])]
          rwa [write_ne (by simp [h'])]
        case inr h =>
          rw [write_ne (by simp [h'])] at h
          try rw [iff_self] at h
          contradiction

  case Append t_idx' t' x' v' h_t' =>
    constructor
    all_goals
    · intro h
      dsimp only [ServerAction.run, note_modified_value_fn] at h ⊢
      have : .Notes ≠ t' := λ h' ↦ by simp [←h'] at h_t'
      have : .Notes ≠ t_idx' := λ h' ↦ by simp [←h'] at h_t'
      rw [write_ne (by simp [*])]
      rw [write_ne (by simp [*])]
      rw [write_ne (by simp [*])]
      rw [write_ne (by simp [*])]
      rw [write_ne (by simp [*])] at h
      rw [write_ne (by simp [*])] at h
      simp only [not_true_eq_false, or_false] at h
      exact h

  case Check t' x' v' =>
    constructor
    all_goals
    · intro h
      cases h
      case inl h => trivial
      case inr h =>
        dsimp only [ServerAction.run] at h
        try rw [iff_self] at h
        contradiction

  case OpenDeposit note_id' amount token =>
    constructor
    all_goals
    · intro h
      dsimp only [ServerAction.run, note_modified_value_fn] at h ⊢
      by_cases h' : note_id = note_id'
      case pos => simp [h', write_eq]
      case neg =>
        cases h
        case inl h =>
          rw [write_ne (by simp [h'])]
          rwa [write_ne (by simp [h'])]
        case inr h =>
          rw [write_ne (by simp [h'])] at h
          try rw [iff_self] at h
          contradiction

-------------------------

-- If there are two paths `m₀ → m` and `m₀ → m₁`, and we have
-- (1) immutability for `m₀ → m₁` and
-- (2) changes in `m → m₀` are reflected in `m₁`,
-- we can conclude immutability for `m → m₁`.
theorem reflected_immutability₀
    {β: Type} [Inhabited β]
    {f: Memory → β}
    {m m₀ m₁: Memory}
    (imm: immutable_fn m₀ m₁ f)
    (reflected: f m ≠ f m₀ → f m₁ = f m)
    : immutable_fn m m₁ f := by
  intro h
  by_cases h' : f m = f m₀
  case pos =>
    simp only [h'] at h
    simp only [imm h, h']
  case neg =>
    exact reflected h'

lemma reflection
    {β: Type} [Inhabited β]
    {crypto: Crypto} {f: Memory → β}
    {m: Memory} {ℓ: List ServerAction}
    (h_change: f (ServerAction.run_all crypto ℓ m).1 ≠ f m)
    (refl_prop: reflection_prop crypto f)
    : ∀ m': Memory, f (ServerAction.run_all crypto ℓ m').1 = f (ServerAction.run_all crypto ℓ m).1 := by
  induction ℓ using List.reverseRecOn
  case nil => contradiction
  case append_singleton ℓ sa ih =>
    intro m'
    by_cases h : f (ServerAction.run_all crypto (ℓ ++ [sa]) m).1 = f (ServerAction.run_all crypto ℓ m).1
    case pos =>
      rw [h] at h_change
      have := ih h_change m'
      simp only [ServerAction.run_all, List.foldl_append, List.foldl_cons, List.foldl_nil]
      rwa [←ServerAction.run_all, ←ServerAction.run_all, refl_prop (Or.inl _)]
    case neg =>
      simp only [ServerAction.run_all, List.foldl_append, List.foldl_cons, List.foldl_nil] at h ⊢
      rw [←ServerAction.run_all] at h
      rw [←ServerAction.run_all, ←ServerAction.run_all, refl_prop (Or.inr h)]

--------------------------------

structure TransactionExecution where
  -- Actions that ran so far.
  actions: List ServerAction
  -- The memory used during at the beginning of the client-side execution.
  m_c₀: Memory
  -- The memory on the server at the beginning of the execution.
  m_s₀: Memory

-- The current memory on the client.
abbrev TransactionExecution.m_c (crypto: Crypto) (e: TransactionExecution) : Memory :=
  (ServerAction.run_all crypto e.actions e.m_c₀).1

-- The current memory on the server.
abbrev TransactionExecution.m_s (crypto: Crypto) (e: TransactionExecution) : Memory :=
  (ServerAction.run_all crypto  e.actions e.m_s₀).1

theorem reflected_immutability
    {β: Type} [Inhabited β]
    {f: Memory → β}
    (e: TransactionExecution)
    (imm: immutable_fn e.m_c₀ (e.m_s crypto) f)
    (refl_prop: reflection_prop crypto f) :
    immutable_fn (e.m_c crypto) (e.m_s crypto) f := by
  apply reflected_immutability₀ imm
  intro h_changed
  apply reflection h_changed refl_prop

theorem ImmutableCells.reflected_immutability'
    (e: TransactionExecution)
    (imm: ImmutableCells crypto e.m_c₀ (e.m_s crypto)) :
    ImmutableCells crypto (e.m_c crypto) (e.m_s crypto) := by
  cases imm
  rename_i imm₀ imm₁ imm₂ imm₃ imm₄

  constructor
  case imm₀ =>
    intro x
    have : reflection_prop crypto (λ m: Memory ↦ m .ChannelHashes x) := reflection₀ _ (t:=.ChannelHashes) (x:=x) (h_t:=by simp)
    apply reflected_immutability e _ this
    exact imm₀ x
  case imm₁ =>
    intro x
    have : reflection_prop crypto (λ m: Memory ↦ m .Tokens [x, 0]) := reflection₀ _ (t:=.Tokens) (x:=[x, 0]) (h_t:=by simp)
    apply reflected_immutability e _ this
    exact imm₁ x
  case imm₂ =>
    intro x
    have : reflection_prop crypto (λ m: Memory ↦ m .SubchannelHashes x) := reflection₀ _ (t:=.SubchannelHashes) (x:=x) (h_t:=by simp)
    apply reflected_immutability e _ this
    exact imm₂ x
  case imm₃ =>
    intro x
    have := reflection₁ crypto x
    apply reflected_immutability e _ this.1
    exact imm₃ x
  case imm₄ =>
    intro x
    have := reflection₁ crypto x
    apply reflected_immutability e _ this.2
    exact imm₄ x

def TransactionExecution.add
    (e: TransactionExecution) (crypto: Crypto) (action: Action) : TransactionExecution :=
  let res := run_action₀ crypto action (e.m_c crypto)
  {
    actions := e.actions ++ res.1
    m_c₀ := e.m_c₀
    m_s₀ := e.m_s₀
  }

theorem TransactionExecution.add_run_on_server
    (e: TransactionExecution) (crypto: Crypto) (action: Action)
    (success: (run_action₀ crypto action (e.m_c crypto)).2)
    (imm: ImmutableCells crypto e.m_c₀ (e.m_s crypto)) :
    run_action₀ crypto action (e.m_s crypto) = run_action₀ crypto action (e.m_c crypto) := by
  apply run_action₀_immutable (success:=success)
  exact ImmutableCells.reflected_immutability' e imm
