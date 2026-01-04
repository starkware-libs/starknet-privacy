import privacy.utils
import privacy.actions
import privacy.channels.discoverable
import privacy.subchannels.subchannels
import privacy.subchannels.discoverable
import privacy.notes.notes
import privacy.notes.contiguous
import privacy.notes.scanned_note

----------------------------------
-- Scan notes for (channel, i₀) --
----------------------------------

def scan_notes_for_channel_i₀
    (crypto: Crypto) (rm: ReachableMemory crypto) (c token i₀: ℕ)
    : List ScannedNote :=
  have h_exists : ∃ i₁, rm.m .Notes [crypto.hash [c, token, i₀, i₁], 0] = 0 := by
    obtain ⟨bound, h_bound⟩ := notes_contiguous c token i₀
    use bound
    have := (h_bound bound).not.mp (Nat.lt_irrefl bound)
    unfold note_exists at this
    simp only [ne_eq, not_not] at this
    exact this
  let bound := Nat.find h_exists
  (List.range bound).map (λ i₁ ↦ ⟨c, token, i₀, i₁⟩)

-- Once a note is discoverable, it stays discoverable.
theorem notes_discoverable_monotone {crypto: Crypto} {rm: ReachableMemory crypto} {action: Action}
    (success: (run_action crypto action rm.m).2)
    {c token i₀: ℕ} {sn: ScannedNote}
    (h : sn ∈ scan_notes_for_channel_i₀ crypto rm c token i₀) :
    sn ∈ scan_notes_for_channel_i₀ crypto (rm.add action success) c token i₀ := by
  simp only [scan_notes_for_channel_i₀, List.mem_map, List.mem_range, Nat.lt_find_iff] at *
  obtain ⟨i₁, h⟩ := h
  use i₁
  constructor
  · intro i₁' i₁'_le_i₁
    have := h.1 i₁' i₁'_le_i₁
    let note_id := crypto.hash [c, token, i₀, i₁']
    exact note_exists_monotone success (h.1 i₁' i₁'_le_i₁)
  · exact h.2

theorem note_exists_implies_i₀
    {crypto: Crypto} {rm: ReachableMemory crypto} {note_id: ℕ}
    (h_note_exists: note_exists rm note_id) :
    ∃ sn: ScannedNote,
      note_id = sn.note_id crypto ∧
      sn ∈ scan_notes_for_channel_i₀ crypto rm sn.c sn.token sn.i₀ ∧
      sn.i₀ < crypto.MAX_I₀ ∧
      subchannel_exists crypto rm sn.c sn.token := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => unfold note_exists; simp

  intro action rm ih success h_note_exists
  cases action
  case CreateSubchannel inp =>
    obtain ⟨⟨c, token, i₀, i₁⟩, ih₀, ih₁, ih₂, ih₃⟩ := ih h_note_exists
    use ⟨c, token, i₀, i₁⟩, ih₀, ih₁, ih₂
    apply subchannel_exists_monotone
    exact ih₃
  case CreateNote inp =>
    unfold ReachableMemory.add run_action
    unfold note_exists at h_note_exists
    let info := create_note_info crypto inp rm success
    simp only
    by_cases h₀ : crypto.hash [note_id, 0] = crypto.hash [inp.note_id crypto, 0]
    case pos =>
      use ⟨inp.c crypto, inp.token, inp.i₀, inp.i₁⟩
      unfold scan_notes_for_channel_i₀
      refine ⟨?_, ?_, ?_, ?_⟩
      · injection crypto.h_hash h₀ with h₀ _
      · simp only [List.mem_map, List.mem_range, Nat.lt_find_iff]
        use inp.i₁
        constructor
        · intro i₁' i₁'_le_i₁
          let rm' := rm.add (.CreateNote inp) success
          have : note_exists rm' (crypto.hash [inp.c crypto, inp.token, inp.i₀, inp.i₁]) := by
            -- TODO: can this be deduced from `note_exists`?
            simp [note_exists]
            unfold rm' ReachableMemory.add run_action
            simp
            rw [←info.h_m']
            rw [info.memory_diff₀]
            exact crypto.pack_nz info.r_ne_zero
          obtain ⟨bound, h_bound⟩ := notes_contiguous (inp.c crypto) inp.token inp.i₀
          have := (h_bound inp.i₁).2 this
          have := (h_bound i₁').1 (by omega)
          exact this
        · injection crypto.h_hash h₀ with h₀ _
          rfl
      · exact info.i₀_lt_MAX_I₀
      · unfold subchannel_exists
        use inp.addrbob, inp.Kbob
        exact info.subchannel_exists
    case neg =>
      have : note_id ≠ inp.note_id crypto := λ h₁ ↦ by simp [h₁] at h₀
      simp only [ReachableMemory.add, run_action] at h_note_exists
      rw [←info.h_m'] at h_note_exists
      rw [info.no_change _ _ (by simp [this]) (by simp)] at h_note_exists
      obtain ⟨⟨c, token, i₀, i₁⟩, ih₀, ih₁, ih₂, ih₃⟩ := ih h_note_exists
      use ⟨c, token, i₀, i₁⟩
      exact ⟨ih₀, notes_discoverable_monotone success ih₁, ih₂, ih₃⟩

  case OpenDeposit inp =>
    rw [note_exists_open_deposit success] at h_note_exists
    obtain ⟨sn, h₀, h₁, h₂, h₃⟩ := ih h_note_exists
    exact ⟨sn, h₀, notes_discoverable_monotone success h₁, h₂, h₃⟩

  all_goals exact ih h_note_exists

----------------------------
-- Scan notes for channel --
----------------------------

def scan_notes_for_channel
    (crypto: Crypto)
    (rm: ReachableMemory crypto)
    (c token: ℕ)
    : List ScannedNote :=
  (List.range crypto.MAX_I₀).flatMap
    λ i₀ ↦ scan_notes_for_channel_i₀ crypto rm c token i₀

theorem scan_notes_for_channel_props {crypto: Crypto} {rm: ReachableMemory crypto}
    {sn: ScannedNote} {c token: ℕ}
    (h: sn ∈ scan_notes_for_channel crypto rm c token) :
    sn.c = c ∧ sn.token = token := by
  simp only [scan_notes_for_channel, scan_notes_for_channel_i₀, List.mem_flatMap, List.mem_range,
    List.mem_map, Nat.lt_find_iff] at h
  obtain ⟨i₀, h_i₀, i₁, h₀, h₁⟩ := h
  simp [←h₁]

-- Existing note is discoverable via its channel and has a valid subchannel.
theorem note_exists_implies_for_channel (crypto: Crypto) (rm: ReachableMemory crypto) :
  ∀ note_id,
    note_exists rm note_id →
    ∃ sn: ScannedNote,
    note_id = sn.note_id crypto ∧
    sn ∈ scan_notes_for_channel crypto rm sn.c sn.token ∧
    subchannel_exists crypto rm sn.c sn.token := by
  intro note_id note_exists
  obtain ⟨sn, h₀, h₁, h₂, h₃⟩ := note_exists_implies_i₀ note_exists
  use sn, h₀
  constructor
  · simp only [scan_notes_for_channel, List.mem_flatMap, List.mem_range]
    use sn.i₀, h₂, h₁
  · exact h₃

------------------------------
-- Scan notes for recipient --
------------------------------

def scan_notes_for_recipient
    (crypto: Crypto)
    (rm: ReachableMemory crypto)
    (addrbob: ℕ) (kbob: crypto.PrivateKeys)
    : List ScannedNote := do
  let c ← scan_channels crypto rm addrbob kbob
  let token ← scan_tokens_for_channel crypto rm c
  scan_notes_for_channel crypto rm c token

theorem scan_notes_for_recipient'
    (crypto: Crypto)
    (rm: ReachableMemory crypto)
    (sn: ScannedNote) (addrbob: ℕ) (kbob: crypto.PrivateKeys):
    sn ∈ scan_notes_for_recipient crypto rm addrbob kbob ↔ (
      sn.c ∈ scan_channels crypto rm addrbob kbob ∧
      sn.token ∈ scan_tokens_for_channel crypto rm sn.c ∧
      sn ∈ scan_notes_for_channel crypto rm sn.c sn.token
    ) := by
  simp only [scan_notes_for_recipient, List.bind_eq_flatMap, List.mem_flatMap]
  constructor
  · intro h
    obtain ⟨c, h_c, token, h_token, h⟩ := h
    have := scan_notes_for_channel_props h
    rw [this.1, this.2]
    trivial
  · intro ⟨h₀, h₁, h₂⟩
    use sn.c, h₀, sn.token, h₁, h₂

-- The following are true for a existing note:
-- 1. It is discoverable by some recipient (addrbob, kbob),
-- 2. c is linked to the recipient (addrbob, kbob).
theorem note_exists_implies_for_recipient
    {crypto: Crypto} {rm: ReachableMemory crypto} {note_id: ℕ}
    (h_note_exists: note_exists rm note_id) :
    ∃ addrbob : ℕ, ∃ kbob: crypto.PrivateKeys, ∃ sn: ScannedNote,
      sn ∈ scan_notes_for_recipient crypto rm addrbob kbob ∧
      note_id = sn.note_id crypto ∧
      (∃ addralice kalice, sn.c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob]) := by
  obtain ⟨sn, h_note_id, note_id_in_scan, subchannel_exists⟩ := note_exists_implies_for_channel crypto rm note_id h_note_exists

  have := subchannel_exists_implies subchannel_exists
  obtain ⟨addralice, kalice, addrbob, Kbob, h'⟩ := channels_are_discoverable this.2

  use addrbob, Kbob, sn
  rw [scan_notes_for_recipient']

  exact ⟨⟨h'.2, this.1, note_id_in_scan⟩, h_note_id, ⟨addralice, kalice, h'.1⟩⟩

-- Discoverable note → note_exists and c is linked to (addrbob, kbob).
theorem discoverable_note_implies
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys}
    {sn: ScannedNote}
    (h: sn ∈ scan_notes_for_recipient crypto rm addrbob kbob) :
    note_exists rm (sn.note_id crypto) ∧
    (∃ addralice kalice, sn.c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob]) := by
  rw [scan_notes_for_recipient'] at *
  obtain ⟨h_scan_channels, _, h'⟩ := h
  unfold scan_notes_for_channel at h'
  simp only [List.mem_flatMap, List.mem_range] at h'
  obtain ⟨i₀, i₀_lt, h'⟩ := h'
  unfold scan_notes_for_channel_i₀ at h'
  simp only [List.mem_map, List.mem_range, Nat.lt_find_iff] at h'
  obtain ⟨i₁, h', h_note_id⟩ := h'
  replace h' := h' i₁ (by rfl)
  constructor
  ·
    rw [←h_note_id]
    exact h'
  · apply discoverable_channel_implies_exists at h_scan_channels
    exact h_scan_channels.2
