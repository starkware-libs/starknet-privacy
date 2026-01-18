import privacy.utils
import privacy.actions
import privacy.channels.discoverable
import privacy.subchannels.subchannels
import privacy.subchannels.discoverable
import privacy.notes.notes
import privacy.notes.contiguous
import privacy.notes.scanned_note
import privacy.notes.note_implies

structure ScanNoteContext (crypto: Crypto) (m: Memory) extends ScanTokenContext crypto m where
  h_notes: ∀ c token i₀, ∃ i₁, m .Notes [crypto.hash [c, token, i₀, i₁], 0] = 0

theorem ScanNoteContext.from {crypto: Crypto} (rm: ReachableMemory crypto) :
    ScanNoteContext crypto rm := {
  toScanTokenContext := .from rm,
  h_notes := by
    intro c token i₀
    obtain ⟨bound, h_bound⟩ := notes_contiguous c token i₀
    use bound
    have := (h_bound bound).not.mp (Nat.lt_irrefl bound)
    unfold note_exists at this
    simp only [ne_eq, not_not] at this
    exact this
  }

----------------------------------
-- Scan notes for (channel, i₀) --
----------------------------------

def scan_notes_for_channel_i₀
    {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
    (c token i₀: ℕ)
    : List ScannedNote :=
  let bound := Nat.find (context.h_notes c token i₀)
  (List.range bound).map (λ i₁ ↦ ⟨c, token, i₀, i₁⟩)

-- Once a note is discoverable, it stays discoverable.
theorem notes_discoverable_monotone {crypto: Crypto} {rm: ReachableMemory crypto} {action: Action}
    (success: (run_action crypto action rm.m).success)
    {c token i₀: ℕ} {sn: ScannedNote}
    (h : sn ∈ scan_notes_for_channel_i₀ (.from rm) c token i₀) :
    sn ∈ scan_notes_for_channel_i₀ (.from (rm.add action success)) c token i₀ := by
  simp only [scan_notes_for_channel_i₀, List.mem_map, List.mem_range, Nat.lt_find_iff] at *
  obtain ⟨i₁, h⟩ := h
  use i₁
  constructor
  · intro i₁' i₁'_le_i₁
    have := h.1 i₁' i₁'_le_i₁
    let note_id := crypto.hash [c, token, i₀, i₁']
    exact note_exists_monotone success (h.1 i₁' i₁'_le_i₁)
  · exact h.2

theorem NoteImplies.scan_i₀
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp.to_scanned_note crypto ∈ scan_notes_for_channel_i₀ (.from rm) (inp.c crypto) inp.token inp.i₀ := by
  simp only [scan_notes_for_channel_i₀, List.mem_map, List.mem_range, Nat.lt_find_iff]
  use inp.i₁
  constructor
  · intro i₁' i₁'_le_i₁
    obtain ⟨bound, h_bound⟩ := notes_contiguous (inp.c crypto) inp.token inp.i₀
    have := (h_bound inp.i₁).2 note_imp.h_note_exists
    have := (h_bound i₁').1 (by omega)
    exact this
  · rfl

----------------------------
-- Scan notes for channel --
----------------------------

def scan_notes_for_channel
    {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
    (c token: ℕ) : List ScannedNote :=
  (List.range crypto.MAX_I₀).flatMap
    λ i₀ ↦ scan_notes_for_channel_i₀ context c token i₀

theorem scan_notes_for_channel_props {crypto: Crypto} {rm: ReachableMemory crypto}
    {sn: ScannedNote} {c token: ℕ}
    (h: sn ∈ scan_notes_for_channel (.from rm) c token) :
    sn.c = c ∧ sn.token = token := by
  simp only [scan_notes_for_channel, scan_notes_for_channel_i₀,
    List.mem_flatMap, List.mem_range, List.mem_map, Nat.lt_find_iff] at h
  obtain ⟨i₀, h_i₀, i₁, h₀, h₁⟩ := h
  simp [←h₁]

-- Existing note is discoverable via `scan_notes_for_channel`.
theorem NoteImplies.scan_for_channel
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp.to_scanned_note crypto ∈ scan_notes_for_channel (.from rm) (inp.c crypto) inp.token := by
  simp only [scan_notes_for_channel, List.mem_flatMap, List.mem_range]
  use inp.i₀, note_imp.h_i₀, note_imp.scan_i₀

------------------------------
-- Scan notes for recipient --
------------------------------

def scan_notes_for_recipient
    {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
    (addrbob: ℕ) (kbob: crypto.PrivateKeys)
    : List ScannedNote := do
  let c ← scan_channels crypto m addrbob kbob
  let token ← scan_tokens_for_channel (context.toScanTokenContext) c
  scan_notes_for_channel context c token

theorem scan_notes_for_recipient'
    (crypto: Crypto)
    (rm: ReachableMemory crypto)
    (sn: ScannedNote) (addrbob: ℕ) (kbob: crypto.PrivateKeys):
    sn ∈ scan_notes_for_recipient (.from rm) addrbob kbob ↔ (
      sn.c ∈ scan_channels crypto rm addrbob kbob ∧
      sn.token ∈ scan_tokens_for_channel (.from rm) sn.c ∧
      sn ∈ scan_notes_for_channel (.from rm) sn.c sn.token
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

-- Existing notes are discoverable by `scan_notes_for_recipient`.
theorem NoteImplies.scan_for_recipient
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp.to_scanned_note crypto ∈ scan_notes_for_recipient (.from rm) inp.addrbob note_imp.subchannel.channel.kbob := by
  rw [scan_notes_for_recipient']
  refine ⟨?_, note_imp.subchannel.scan, note_imp.scan_for_channel⟩
  · have := note_imp.subchannel.channel.scan
    simp only [CreateChannelInput.c, CreateNoteInput.c, ←NoteImplies.h_kalice] at this
    exact this

-- Discoverable note → note_exists and c is linked to (addrbob, kbob).
theorem NoteImplies.from_scan_notes_for_recipient
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys}
    {sn: ScannedNote}
    (h_kbob: rm.m MemoryType.PublicKeys [addrbob] = crypto.priv_to_pub kbob)
    (h: sn ∈ scan_notes_for_recipient (.from rm) addrbob kbob) :
    ∃ (inp: CreateNoteInput) (_: NoteImplies rm inp),
      inp.to_scanned_note crypto = sn ∧
      inp.addrbob = addrbob ∧
      inp.Kbob = crypto.priv_to_pub kbob := by
  rw [scan_notes_for_recipient'] at *
  obtain ⟨h_scan_channels, _, h'⟩ := h
  unfold scan_notes_for_channel at h'
  simp only [List.mem_flatMap, List.mem_range] at h'
  obtain ⟨i₀, i₀_lt, h'⟩ := h'
  unfold scan_notes_for_channel_i₀ at h'
  simp only [List.mem_map, List.mem_range, Nat.lt_find_iff] at h'
  obtain ⟨i₁, h', h_sn⟩ := h'
  replace h' := h' i₁ (by rfl)

  have ⟨inp, note_imp, h_note_id'⟩ := NoteImplies.from_note_exists (h_sn ▸ h')

  have h_sn' : sn = inp.to_scanned_note crypto := by
    apply Eq.symm
    apply CreateNoteInput.to_scanned_note_eq
    rw [h_note_id', ←h_sn, ScannedNote.note_id]

  have ⟨inp_channel, channel_imp, h_c, h_addrbob, h_kbob⟩ := ChannelImplies.from_scan h_kbob h_scan_channels
  rw [h_sn'] at h_c
  dsimp only [CreateNoteInput.to_scanned_note] at h_c

  refine ⟨inp, note_imp, ?_, ?_, ?_⟩
  · apply CreateNoteInput.to_scanned_note_eq
    rw [h_note_id', ←h_sn, ScannedNote.note_id]
  · simp [channel_imp.same_c h_c, h_addrbob]
  · simp [channel_imp.same_c h_c, channel_imp.h_Kbob, h_kbob]
