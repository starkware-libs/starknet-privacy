import privacy.utils
import privacy.actions
import privacy.notes.notes
import privacy.subchannels.subchannels

def note_canceled (crypto: Crypto) (m: Memory) (c token i₀ i₁ kbob: ℕ) : Prop :=
  m .Nullifiers [crypto.hash [c, token, i₀, i₁, kbob]] ≠ 0

-- Once a note is canceled, it stays canceled.
theorem note_canceled_monotone
    {crypto: Crypto} {rm: ReachableMemory crypto} {action: Action}
    (success: (run_action crypto action rm.m).success)
    (h: note_canceled crypto rm.m c token i₀ i₁ kbob) :
    note_canceled crypto (rm.add action success) c token i₀ i₁ kbob := by
  unfold note_canceled
  cases action
  case CancelNote inp =>
    let info := cancel_note_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    by_cases h_is_same : crypto.hash [c, token, i₀, i₁, kbob] = inp.nullifier crypto
    case pos =>
      simp [h_is_same, info.memory_diff₀]
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same])]
      exact h

  repeat exact h

-- Canceled note must exist.
theorem canceled_note_implies_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {c token i₀ i₁ kbob: ℕ}
    (h_note_canceled: note_canceled crypto rm c token i₀ i₁ kbob) :
    note_exists rm (crypto.hash [c, token, i₀, i₁]) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success h_note_canceled
  cases action
  case CancelNote inp =>
    dsimp only [note_canceled, note_exists] at h_note_canceled ⊢
    let info := cancel_note_info crypto inp rm success
    by_cases h_is_same : crypto.hash [c, token, i₀, i₁] = inp.note_id crypto ∧ kbob = inp.kbob
    case pos =>
      rw [ReachableMemory.add_m, run_action, ←info.h_m', h_is_same.1, info.no_change _ _ (by simp)]
      use info.r_ne_zero
    case neg =>
      have : crypto.hash [c, token, i₀, i₁, kbob] ≠ CancelNoteInput.nullifier crypto inp := by
        by_contra h₀
        apply crypto.h_hash at h₀
        repeat injection h₀ with _ h₀
        simp [*] at h_is_same
      rw [ReachableMemory.add_m, run_action, ←info.h_m', info.no_change _ _ (by simp [this])] at h_note_canceled
      exact note_exists_monotone success (ih h_note_canceled)

  case CreateNote inp =>
    exact note_exists_monotone success (ih h_note_canceled)

  case OpenDeposit inp =>
    exact note_exists_monotone success (ih h_note_canceled)

  repeat exact ih h_note_canceled

-- If a note was canceled, kbob must be a valid private key.
theorem canceled_note_implies_kbob_private_key
    {crypto: Crypto} {rm: ReachableMemory crypto} {c token i₀ i₁ kbob: ℕ}
    (h_note_canceled: note_canceled crypto rm c token i₀ i₁ kbob) :
    kbob ∈ crypto.PrivateKeys := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h_note_canceled; trivial

  intro action rm ih success h_note_canceled
  cases action
  case CancelNote inp =>
    dsimp only [note_canceled] at h_note_canceled
    let info := cancel_note_info crypto inp rm success
    by_cases h_is_same : crypto.hash [c, token, i₀, i₁] = inp.note_id crypto ∧ kbob = inp.kbob
    case pos =>
      simp only [h_is_same]
      exact info.kbob_private_key
    case neg =>
      have : crypto.hash [c, token, i₀, i₁, kbob] ≠ CancelNoteInput.nullifier crypto inp := by
        by_contra h₀
        apply crypto.h_hash at h₀
        repeat injection h₀ with _ h₀
        simp [*] at h_is_same
      rw [ReachableMemory.add_m, run_action, ←info.h_m', info.no_change _ _ (by simp [this])] at h_note_canceled
      exact ih h_note_canceled

  repeat exact ih h_note_canceled

def cancel_note_actions (crypto: Crypto) (rm: ReachableMemory crypto) : List CancelNoteInput :=
  rm.actions.filterMap filter_CancelNote

theorem cancel_note_actions_add
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (success: (run_action crypto (.CancelNote inp) rm.m).success) :
    (cancel_note_actions crypto (rm.add (.CancelNote inp) success)) =
    inp :: cancel_note_actions crypto rm := by
  simp [cancel_note_actions]

-- Note is canceled ↔ there's a CancelNote action that corresponds to the note_id.
theorem cancel_note_actions_iff_note_canceled {crypto: Crypto} {rm: ReachableMemory crypto} {c token i₀ i₁ kbob: ℕ} :
    note_canceled crypto rm c token i₀ i₁ kbob ↔
    ∃ inp, inp ∈ cancel_note_actions crypto rm ∧
      inp.note_id crypto = crypto.hash [c, token, i₀, i₁] ∧
      inp.kbob = kbob := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ =>
    constructor
    · intro h; contradiction
    · intro h; obtain ⟨inp, h₀, h₁⟩ := h; contradiction

  intro action rm ih success
  cases action
  case CancelNote inp =>
    let info := cancel_note_info crypto inp rm success
    rw [cancel_note_actions_add]
    simp only [List.mem_cons, exists_eq_or_imp]

    by_cases h_is_same : crypto.hash [c, token, i₀, i₁] = inp.note_id crypto ∧ inp.kbob = kbob
    case pos =>
      constructor
      · intro h'
        apply Or.inl
        simp [h_is_same]
      · intro h'
        have := h_is_same.1
        apply crypto.h_hash at this
        repeat injection this with _ this

        rw [ReachableMemory.add_m, run_action, ←info.h_m', note_canceled]
        simp only [*]
        simp [←h_is_same.2, info.memory_diff₀]
    case neg =>
      constructor
      · intro h'
        by_cases h_canceled_before: note_canceled crypto rm.m c token i₀ i₁ kbob
        case pos =>
          obtain ⟨inp, ih⟩ := ih.1 h_canceled_before
          apply Or.inr
          use inp
        case neg =>
          apply Or.inl
          rw [ReachableMemory.add_m, run_action, ←info.h_m', note_canceled, info.no_change _ _ (by
            by_contra h₀
            simp only [CancelNoteInput.nullifier, Prod.mk.injEq, List.cons.injEq, and_true,
              true_and] at h₀
            apply crypto.h_hash at h₀
            repeat injection h₀ with _ h₀
            simp [*] at h_is_same
          )] at h'
          contradiction
      ·
        intro h'
        cases h'
        case inl h' =>
          have := crypto.h_hash (Eq.symm h'.1)
          injections
          rw [ReachableMemory.add_m, run_action, ←info.h_m', note_canceled]
          simp [*]
          simp [←h'.2, info.memory_diff₀]
        case inr h' =>
          exact note_canceled_monotone success (ih.2 h')

  repeat exact ih

theorem note_cancel_action_implies
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (h: inp ∈ cancel_note_actions crypto rm) :
    (∃ addralice kalice, inp.c = crypto.hash [addralice, kalice, inp.addrbob, inp.Kbob crypto]) ∧
    inp.kbob ∈ crypto.PrivateKeys ∧
    inp.amount ≠ 0 ∧
    note_canceled crypto rm inp.c inp.token inp.i₀ inp.i₁ inp.kbob := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success h
  cases action
  case CancelNote inp' =>
    rw [cancel_note_actions_add, List.mem_cons] at h
    cases h

    case inl h =>
      rw [h]
      let info := cancel_note_info crypto inp' rm success

      exact ⟨
        subchannel_hash_exists_implies_hash info.subchannel_exists,
        info.kbob_private_key,
        info.amount_ne_zero,
        by
          rw [ReachableMemory.add_m, run_action, ←info.h_m', note_canceled, info.memory_diff₀]
          simp
      ⟩
    case inr h =>
      have ⟨ih₀, ih₁, ih₂, ih₃⟩ := ih h
      exact ⟨ih₀, ih₁, ih₂, note_canceled_monotone success ih₃⟩

  repeat exact ih h

theorem note_canceled_monotone_extends
    {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm)
    (h: note_canceled crypto rm c token i₀ i₁ kbob) :
    note_canceled crypto rm' c token i₀ i₁ kbob := by
  apply cancel_note_actions_iff_note_canceled.2
  apply cancel_note_actions_iff_note_canceled.1 at h
  obtain ⟨inp, h⟩ := h
  use inp
  refine ⟨?_, h.2⟩
  obtain ⟨ℓ, h_extends⟩ := h_extends
  rw [cancel_note_actions, ←h_extends]
  rw [List.filterMap_append, List.mem_append, List.mem_filterMap]
  exact Or.inr h.1
