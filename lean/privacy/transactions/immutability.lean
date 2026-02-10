import privacy.actions
import privacy.utils

-------------------------
-- Storage functionals --
-------------------------

abbrev Functional (β: Type) := Memory → β

def mem_cell_fn (t: MemoryType) (x: List ℕ) : Functional ℕ := λ m: Memory ↦ m t x

-- If the note is (r=1, amount=0), returns 0.
-- Otherwise, returns the packed encrypted value of the note.
def note_modified_value_fn (crypto: Crypto) (note_id: ℕ) :=
  (λ val ↦ if val = crypto.pack 1 0 then 0 else val) ∘ (mem_cell_fn .Notes [note_id, 0])

def note_exists_fn (note_id: ℕ) : Memory → Bool :=
  (λ val ↦ decide (val ≠ 0)) ∘ (mem_cell_fn .Notes [note_id, 0])

------------------
-- Immutability --
------------------

-- For certain memory spaces, once a value is written, it cannot be changed.
theorem immutability₀ (crypto: Crypto) (m: Memory) (action: Action) (t: MemoryType) (x: List ℕ)
    (h_nonzero: m t x ≠ 0)
    (h_t:
      t ≠ .ChannelsJ ∧
      t ≠ .Channels ∧
      t ≠ .Notes ∧
      t ≠ .OpenNoteToken ∧
      (t = .SubchannelTokens → ∃ v, x = [v, 0]) ∧
      (t = .OutgoingChannels → ∃ v, x = [v, 0])
    )
    (success: (run_action crypto action m).success)
    : (run_action crypto action m).m t x = m t x := by
  cases action
  case Register inp =>
    let info := register_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _ (by
      by_contra
      simp only [Prod.mk.injEq] at this
      simp [this] at h_nonzero
      exact h_nonzero info.alice_was_not_registered
    )]

  case OpenChannel inp =>
    let info := open_channel_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _ (by
      simp only [ne_eq, Prod.mk.injEq, h_t, false_and, not_false_eq_true, not_and, true_and]
      refine ⟨?_, ?_, ?_⟩

      · intro h₀ h₁
        rw [h₀, h₁, info.channel_didnt_exist] at h_nonzero
        contradiction
      · intro h₀ h₁
        rw [h₀, h₁, info.outgoing_channel_didnt_exist] at h_nonzero
        contradiction
      · intro h₀ h₁; simp [h₀, h₁] at h_t
    )]

  case OpenSubchannel inp =>
    let info := open_subchannel_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _
      (λ h' ↦ h_nonzero (by rw [Prod.mk.injEq] at h'; simp [h'.1, h'.2, info.old_hash_was_zero]))
      (λ h' ↦ h_nonzero (by rw [Prod.mk.injEq] at h'; simp [h'.1, h'.2, info.old_token_was_zero]))
      (λ h' ↦ by rw [Prod.mk.injEq] at h'; simp [h'] at h_t)]

  case CreateNote inp =>
    let info := create_note_info crypto inp m success
    rw [run_action, ←info.h_m', info.no_change _ _
      (λ h' ↦ h_nonzero (by rw [Prod.mk.injEq] at h'; simp [h'.1, h'.2, info.old_value_was_zero]))
      (by simp [h_t])]

  case UseNote inp =>
    let info := use_note_info crypto inp m success
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
      t ≠ .ChannelsJ ∧
      t ≠ .Channels ∧
      t ≠ .Notes ∧
      t ≠ .OpenNoteToken ∧
      (t = .SubchannelTokens → ∃ v, x = [v, 0]) ∧
      (t = .OutgoingChannels → ∃ v, x = [v, 0])
    )
    : rm'.m t x = rm.m t x := by
  revert rm'
  apply invariant_induction_for_extends rm
  case inv₀ => trivial

  intro action rm' h_extends h success
  rw [←h, ←immutability₀ (h_t:=h_t) (h_nonzero:=by rwa [h]) (success:=success)]
  rfl

-- For PublicKeys, once a value is written, it cannot be changed back to 0.
theorem note_amount_immutable₀ (crypto: Crypto) (m: Memory) (action: Action) (note_id: ℕ)
    (success: (run_action crypto action m).success) :
    (m .Notes [note_id, 0] ≠ 0 → (run_action crypto action m).m .Notes [note_id, 0] ≠ 0) ∧
    (note_modified_value_fn crypto note_id m ≠ 0 →
      note_modified_value_fn crypto note_id (run_action crypto action m).m =
      note_modified_value_fn crypto note_id m) := by
  dsimp only [note_modified_value_fn, mem_cell_fn, Function.comp_apply]

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
    rw [ReachableMemory.add_m success]
    rw [(note_amount_immutable₀ crypto rm' action note_id success).2 (by rwa [h.2 h_nonzero])]
    exact h.2 h_nonzero

-------------------------

-- A function on the memory is called immutable if once it becomes non-zero, it cannot be changed.
def immutable_fn {β: Type} [Inhabited β] (m₀ m₁: Memory) (f: Functional β) : Prop :=
  f m₀ ≠ default → f m₁ = f m₀

theorem immutable_fn_prop {m₀ m₁: Memory} {f: Functional Bool} (imm: immutable_fn m₀ m₁ f) :
    f m₀ → (f m₁ ↔ f m₀) := by
  intro h
  rw [imm (by simp [h])]

theorem open_channel_immutable
    {crypto: Crypto} {m₀ m₁: Memory} (inp: OpenChannelInput)
    (imm₀: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .PublicKeys x))
    (imm₁: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .OutgoingChannels [x, 0]))
    (success: (run_action₀ crypto (.OpenChannel inp) m₀).2) :
    run_action₀ crypto (.OpenChannel inp) m₁ = run_action₀ crypto (.OpenChannel inp) m₀ := by
  dsimp only [run_action₀, open_channel] at *
  rw [decide_eq_true_iff] at success

  have ⟨h₀, h₁, h₂, h₃, h₄⟩ := success

  dsimp only [immutable_fn, mem_cell_fn] at imm₀ imm₁

  apply Prod.ext
  · trivial
  · simp only [imm₀ [inp.addralice] (by
      rw [h₁]; exact crypto.zero_not_public_key ⟨inp.kalice, h₂⟩
    )]

    cases h₄
    case inl h₄ => simp [h₄]
    case inr h₄ => rw [imm₁ _ h₄]

theorem open_subchannel_immutable
    {crypto: Crypto} {m₀ m₁: Memory} (inp: OpenSubchannelInput)
    (imm₀: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .ChannelMarkers x))
    (imm₁: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .SubchannelTokens [x, 0]))
    (success: (run_action₀ crypto (.OpenSubchannel inp) m₀).2) :
    run_action₀ crypto (.OpenSubchannel inp) m₁ = run_action₀ crypto (.OpenSubchannel inp) m₀ := by
  dsimp only [run_action₀, open_subchannel] at *
  rw [decide_eq_true_iff] at success
  have ⟨h₀, h₁, h₂, h₃⟩ := success

  dsimp only [immutable_fn, mem_cell_fn] at imm₀ imm₁

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
    (imm₀: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .SubchannelMarkers x))
    (imm₁: ∀ x, immutable_fn m₀ m₁ (note_exists_fn x))
    (success: (run_action₀ crypto (.CreateNote inp) m₀).2) :
    run_action₀ crypto (.CreateNote inp) m₁ = run_action₀ crypto (.CreateNote inp) m₀ := by
  dsimp only [run_action₀, create_note] at *
  rw [decide_eq_true_iff] at success
  have ⟨h₀, h₁, h₂, h₃⟩ := success

  dsimp only [immutable_fn, mem_cell_fn] at imm₀
  dsimp only [note_exists_fn] at imm₁

  apply Prod.ext
  · trivial
  · simp only
    rw [imm₀ _ h₂]
    cases h₁
    case inl h₁ =>
      simp [h₁]
    case inr h₁ =>
      have := immutable_fn_prop
        (imm₁ (crypto.hash [CreateNoteInput.c crypto inp, inp.token, inp.i - 1]))
        (by simp; exact h₁)
      simp only [Function.comp_apply, decide_eq_true_eq, mem_cell_fn] at this
      conv => lhs; arg 1; rw [this]

theorem use_note_immutable
    {crypto: Crypto} {m₀ m₁: Memory} (inp: UseNoteInput)
    (imm₀: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .SubchannelMarkers x))
    (imm₂: ∀ x, immutable_fn m₀ m₁ (note_modified_value_fn crypto x))
    (success: (run_action₀ crypto (.UseNote inp) m₀).2) :
    run_action₀ crypto (.UseNote inp) m₁ = run_action₀ crypto (.UseNote inp) m₀ := by
  dsimp only [run_action₀, use_note] at *
  rw [decide_eq_true_iff] at success
  have ⟨h₀, h₁, h₂, h₃, h₅⟩ := success

  dsimp only [immutable_fn, mem_cell_fn] at imm₀ imm₂
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

    have := imm₂ (inp.note_id crypto) (by simpa [mem_cell_fn, ←h_val₀, reduceIte, non_empty_note])
    simp only [Function.comp_apply, mem_cell_fn, ←h_val₀, reduceIte, non_empty_note] at this
    rw [ite_eq_iff] at this
    simp [Ne.symm h₁] at this
    rw [this.2]

structure ImmutableCells (crypto: Crypto) (m₀ m₁: Memory) where
  (imm₀: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .ChannelMarkers x))
  (imm₁: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .SubchannelTokens [x, 0]))
  (imm₂: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .SubchannelMarkers x))
  (imm₃: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .PublicKeys x))
  (imm₄: ∀ x, immutable_fn m₀ m₁ (mem_cell_fn .OutgoingChannels [x, 0]))
  (imm₅: ∀ x, immutable_fn m₀ m₁ (note_exists_fn x))
  (imm₆: ∀ x, immutable_fn m₀ m₁ (note_modified_value_fn crypto x))

theorem run_action₀_immutable
    {crypto: Crypto} {m₀ m₁: Memory} (actions: Action)
    (imm: ImmutableCells crypto m₀ m₁)
    (success: (run_action₀ crypto actions m₀).2) :
    run_action₀ crypto actions m₁ = run_action₀ crypto actions m₀ := by
  cases actions
  case Register inp => trivial
  case OpenChannel inp => exact open_channel_immutable inp imm.imm₃ imm.imm₄ success
  case OpenSubchannel inp => exact open_subchannel_immutable inp imm.imm₀ imm.imm₁ success
  case CreateNote inp => exact create_note_immutable inp imm.imm₂ imm.imm₅ success
  case UseNote inp => exact use_note_immutable inp imm.imm₂ imm.imm₆ success
  case OpenDeposit inp => trivial

theorem ImmutableCells.of_extends
    (crypto: Crypto) {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm) :
    ImmutableCells crypto rm.m rm'.m := by
  constructor
  all_goals intro x h
  case imm₅ =>
    unfold note_exists_fn at *
    simp only [Function.comp_apply, mem_cell_fn, decide_eq_decide] at *
    rw [Bool.default_bool, ne_eq, decide_eq_false_iff_not, not_not] at h
    simp [(note_amount_immutable h_extends).1 h, h]
  case imm₆ => exact (note_amount_immutable h_extends).2 h
  all_goals exact immutability h_extends h (by simp)

------------------------
-- Server-side action --
------------------------

-- The output of a ServerAction is the same if
-- (1) the input is the same, OR
-- (2) the action changed the value.
def reflection_prop (crypto: Crypto) (f: Functional β) : Prop :=
  ∀ {sa: ServerAction},
  ∀ {m m': Memory},
  (h: f m = f m' ∨ f (sa.run crypto m).1 ≠ f m) → f (sa.run crypto m).1 = f (sa.run crypto m').1

-- Helper lemma for reflection₀: a single write either modifies the target cell (equal results)
-- or another cell (preserves the original relationship).
private lemma reflection_single_write
    {t t': MemoryType} {x x': List ℕ} {v: ℕ} {m m': Memory} (g: ℕ → β) :
    let f := g ∘ (mem_cell_fn t x)
    (h: f m = f m' ∨ f (write t' x' v m) ≠ f m) →
    (f (write t' x' v m) = f (write t' x' v m')) := by
  simp only [mem_cell_fn, Function.comp_apply]
  intro h
  by_cases h' : t = t' ∧ x = x'
  case pos => simp [h'.1, h'.2, write_eq]
  case neg =>
    rw [write_ne (by simp [h']), write_ne (by simp [h'])]
    cases h
    case inl h => exact h
    case inr h => rw [write_ne (by simp [h'])] at h; contradiction

lemma reflection₀
    (crypto: Crypto)
    (t: MemoryType) (x: List ℕ)
    (g: ℕ → β)
    (h_t: t ≠ .ChannelsJ ∧ t ≠ .Channels) :
    reflection_prop crypto (g ∘ (mem_cell_fn t x)) := by
  intro sa m m' h
  cases sa
  case Write t' x' v' => exact reflection_single_write g h
  case WriteOnce t' x' v' => exact reflection_single_write g h
  case Append t_idx' t' x' v' h_t' =>
    unfold ServerAction.run mem_cell_fn at h ⊢
    dsimp only at h ⊢
    simp only [Function.comp_apply] at h ⊢
    have h_ne_t : t ≠ t' := λ h' ↦ by simp [h', h_t'] at h_t
    have h_ne_idx : t ≠ t_idx' := λ h' ↦ by simp [h', h_t'] at h_t
    rw [write_ne (by simp [*]), write_ne (by simp [*]),
        write_ne (by simp [*]), write_ne (by simp [*])]
    rw [write_ne (by simp [*]), write_ne (by simp [*])] at h
    exact h.elim id (absurd rfl)
  case OpenDeposit note_id amount token => exact reflection_single_write g h

  all_goals exact h.elim id (absurd rfl)

-------------------------

-- If there are two paths `m₀ → m` and `m₀ → m₁`, and we have
-- (1) immutability for `m₀ → m₁` and
-- (2) changes in `m → m₀` are reflected in `m₁`,
-- we can conclude immutability for `m → m₁`.
theorem reflected_immutability₀
    {β: Type} [Inhabited β]
    {f: Functional β}
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
    {crypto: Crypto} {f: Functional β}
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
    {f: Functional β}
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
  rename_i imm₀ imm₁ imm₂ imm₃ imm₄ imm₅ imm₆

  constructor
  case imm₀ =>
    intro x
    apply reflected_immutability e _ (reflection₀ _ .ChannelMarkers x id (by simp))
    exact imm₀ x
  case imm₁ =>
    intro x
    apply reflected_immutability e _ (reflection₀ _ .SubchannelTokens [x, 0] id (by simp))
    exact imm₁ x
  case imm₂ =>
    intro x
    apply reflected_immutability e _ (reflection₀ _ .SubchannelMarkers x id (by simp))
    exact imm₂ x
  case imm₃ =>
    intro x
    apply reflected_immutability e _ (reflection₀ _ .PublicKeys x id (by simp))
    exact imm₃ x
  case imm₄ =>
    intro x
    apply reflected_immutability e _ (reflection₀ _ .OutgoingChannels [x, 0] id (by simp))
    exact imm₄ x
  case imm₅ =>
    intro x
    apply reflected_immutability e _ (reflection₀ _ .Notes [x, 0] _ (by simp))
    exact imm₅ x
  case imm₆ =>
    intro x
    apply reflected_immutability e _ (reflection₀ _ .Notes [x, 0] _ (by simp))
    exact imm₆ x

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
