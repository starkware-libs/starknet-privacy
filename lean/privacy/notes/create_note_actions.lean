import privacy.actions
import privacy.notes.discoverable
import privacy.utils

def create_note_actions (crypto: Crypto) (rm: ReachableMemory crypto) : List CreateNoteInput :=
  rm.actions.filterMap filter_CreateNote

theorem create_note_actions_add
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (success: (run_action crypto (.CreateNote inp) rm.m).success) :
    (create_note_actions crypto (rm.add (.CreateNote inp) success)) =
    inp :: create_note_actions crypto rm := by
  simp [create_note_actions]

theorem create_note_actions_add'
    {crypto: Crypto} {rm: ReachableMemory crypto} {action: Action}
    (success: (run_action crypto action rm.m).success)
    (h: filter_CreateNote action = none) :
    (create_note_actions crypto (rm.add action success)) =
    create_note_actions crypto rm := by
  simp only [create_note_actions, ReachableMemory.add, List.filterMap_cons, h]

-- CreateNote action implies:
-- 1. note exists,
-- 2. subchannel hash is set,
-- 3. if r = 1 (open note), then note token is registered,
-- 4. inp.r appears in the note encoding.
theorem create_note_actions_implies
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (h: inp ∈ create_note_actions crypto rm) :
    note_exists rm (inp.note_id crypto) ∧
    rm.m .SubchannelHashes [crypto.hash [inp.c crypto, inp.addrbob, inp.Kbob, inp.token]] ≠ 0 ∧
    (inp.r = 1 → rm.m .OpenNoteToken [inp.note_id crypto] = inp.token) ∧
    (crypto.unpack (rm.m .Notes [inp.note_id crypto, 0])).1 = inp.r := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; obtain ⟨inp, h₀, h₁⟩ := h

  intro action rm ih success
  cases action
  case CreateNote inp' =>
    let info := create_note_info crypto inp' rm success

    intro h'
    rw [create_note_actions_add, List.mem_cons] at h'
    cases h'

    case inl h' =>
      rw [h']
      unfold note_exists
      rw [ReachableMemory.add_m, run_action, ←info.h_m']
      refine ⟨?_, ?_, ?_, ?_⟩
      · dsimp only
        rw [CreateNoteInput.note_id, CreateNoteInput.c, info.memory_diff₀]
        exact crypto.pack_nz info.r_ne_zero
      · rw [info.no_change _ _ (by simp) (by simp)]
        exact info.subchannel_exists
      · intro r_eq_one
        rw [CreateNoteInput.note_id, CreateNoteInput.c, info.memory_diff₁]
        simp [r_eq_one]
      · rw [CreateNoteInput.note_id, CreateNoteInput.c, info.memory_diff₀]
        rw [crypto.unpack_pack]

    case inr h' =>
      have ⟨h₀, h₁, h₂, h₃⟩ := ih h'
      have h_note_id : inp.note_id crypto ≠ inp'.note_id crypto :=
        λ h_note_id ↦ absurd (h_note_id ▸ info.old_value_was_zero) h₀

      refine ⟨?_, ?_, ?_, ?_⟩
      · apply note_exists_monotone
        exact h₀

      all_goals
        rw [ReachableMemory.add_m, run_action, ←info.h_m']
        rw [info.no_change _ _ (by simp [h_note_id]) (by simp [h_note_id])]
      exact h₁
      exact h₂
      exact h₃

  case CreateSubchannel inp' =>
    let info := create_subchannel_info crypto inp' rm success

    intro h'
    have ⟨h₀, h₁, h₂, h₃⟩ := ih h'
    refine ⟨h₀, ?_, h₂, h₃⟩

    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    by_cases h_is_same: crypto.hash [inp.c crypto, inp.addrbob, inp.Kbob, inp.token] = inp'.subchannel_hash crypto
    case pos =>
      rw [h_is_same, info.memory_diff₂]; simp
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same]) (by simp) (by simp)]
      exact h₁

  case OpenDeposit inp' =>
    rw [note_exists_open_deposit success]
    intro h_inp
    have ⟨h₀, h₁, h₂, h₃⟩ := ih h_inp
    refine ⟨h₀, h₁, h₂, ?_⟩

    let info := open_deposit_info crypto inp' rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h_is_same: inp.note_id crypto = inp'.note_id
    case pos =>
      rw [h_is_same, info.old_value] at h₃
      rw [h_is_same, info.memory_diff₀, ←h₃, crypto.unpack_pack, crypto.unpack_pack]
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same])]
      exact h₃

  all_goals
    intro h'; exact ih h'

-- Note exists ↔ there's a CreateNote action with the note_id.
theorem create_note_actions_iff_note_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {note_id: ℕ}:
    note_exists rm note_id ↔
    ∃ inp, inp ∈ create_note_actions crypto rm ∧ inp.note_id crypto = note_id := by
  constructor
  swap
  · intro ⟨inp, h⟩; rw [←h.2]; exact (create_note_actions_implies h.1).1

  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success
  cases action
  case CreateNote inp =>
    let info := create_note_info crypto inp rm success
    by_cases h_note_id : note_id = inp.note_id crypto
    case pos =>
      intro _; simp [create_note_actions, h_note_id]
    case neg =>
      intro h_note_exists
      have : note_exists rm.m note_id := by
        unfold note_exists at *
        rw [ReachableMemory.add_m, run_action, ←info.h_m'] at h_note_exists
        rw [info.no_change _ _ (by simp [h_note_id]) (by simp)] at h_note_exists
        exact h_note_exists
      obtain ⟨inp, ih⟩ := ih this
      simp [create_note_actions] at *
      exact Or.inr ⟨inp, ih⟩

  case OpenDeposit inp' => rwa [note_exists_open_deposit success]

  all_goals exact ih

-- Scanned note ↔ there's a CreateNote action that created it for (addrbob, kbob).
theorem create_note_actions_iff_note_discoverable
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (addrbob: ℕ) (kbob: crypto.PrivateKeys) (sn: ScannedNote) :
    sn ∈ scan_notes_for_recipient (.from rm) addrbob kbob ↔
    ∃ inp, inp ∈ create_note_actions crypto rm ∧
      inp.to_scanned_note crypto = sn ∧
      inp.addrbob = addrbob ∧
      inp.Kbob = crypto.priv_to_pub kbob := by
  constructor
  · intro h
    obtain ⟨h_note_exists, ⟨addralice, kalice, h_c⟩⟩ := discoverable_note_implies h
    obtain ⟨inp, h₀, h₁⟩ := create_note_actions_iff_note_exists.1 h_note_exists
    use inp, h₀, CreateNoteInput.to_scanned_note_eq h₁
    have ⟨h_inp_c, h_inp_token⟩ : inp.c crypto = sn.c ∧ inp.token = sn.token := by
      apply crypto.h_hash at h₁
      injections
      omega
    have : inp.addrbob = addrbob ∧ inp.Kbob = crypto.priv_to_pub kbob := by
      rw [h_c] at h_inp_c
      apply crypto.h_hash at h_inp_c
      injections
      omega

    simp [this]
  · intro h
    obtain ⟨inp, h₀, h₁, h_inp_addrbob, h_inp_Kbob⟩ := h
    have := create_note_actions_iff_note_exists.2 ⟨inp, h₀, by rfl⟩
    obtain ⟨addrbob', kbob', sn', h₆, h_note_id, _, ⟨addralice, kalice, h_c'⟩⟩ :=
      note_exists_implies_for_recipient this
    have h_sn := CreateNoteInput.to_scanned_note_eq h_note_id

    have : addrbob = addrbob' ∧ kbob = kbob' := by
      rw [←h_sn] at h_c'
      apply crypto.h_hash at h_c'
      rw [h_inp_addrbob, h_inp_Kbob] at h_c'
      injections
      exact ⟨by simp [*], Subtype.val_inj.1 (crypto.priv_to_pub_inj (by simp) (by simp) (by assumption))⟩

    rw [h₁] at h_sn
    simp [h_sn, this]
    exact h₆
