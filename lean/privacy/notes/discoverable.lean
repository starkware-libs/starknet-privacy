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
  h_notes: ∀ c token, ∃ i, m .Notes [crypto.hash [c, token, i], 0] = 0

theorem ScanNoteContext.from {crypto: Crypto} (rm: ReachableMemory crypto) :
    ScanNoteContext crypto rm := {
  toScanTokenContext := .from rm,
  h_notes := by
    intro c token
    obtain ⟨bound, h_bound⟩ := notes_contiguous c token
    use bound
    have := (h_bound bound).not.mp (Nat.lt_irrefl bound)
    unfold note_exists at this
    simp only [ne_eq, not_not] at this
    exact this
  }

----------------------------
-- Scan notes for channel --
----------------------------

def scan_notes_for_channel
    {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
    (c token: ℕ)
    : List ScannedNote :=
  let bound := Nat.find (context.h_notes c token)
  (List.range bound).map (λ i ↦ ⟨c, token, i⟩)

-- Once a note is discoverable, it stays discoverable.
theorem notes_discoverable_monotone {crypto: Crypto} {rm: ReachableMemory crypto} {action: Action}
    (success: (run_action crypto action rm.m).success)
    {c token: ℕ} {sn: ScannedNote}
    (h : sn ∈ scan_notes_for_channel (.from rm) c token) :
    sn ∈ scan_notes_for_channel (.from (rm.add action success)) c token := by
  simp only [scan_notes_for_channel, List.mem_map, List.mem_range, Nat.lt_find_iff] at *
  obtain ⟨i, h⟩ := h
  use i
  constructor
  · intro i' i'_le_i
    have := h.1 i' i'_le_i
    let note_id := crypto.hash [c, token, i']
    exact note_exists_monotone success (h.1 i' i'_le_i)
  · exact h.2

-- Existing note is discoverable via `scan_notes_for_channel`.
theorem NoteImplies.scan_for_channel
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp.to_scanned_note crypto ∈ scan_notes_for_channel (.from rm) (inp.c crypto) inp.token := by
  simp only [scan_notes_for_channel, List.mem_map, List.mem_range, Nat.lt_find_iff]
  use inp.i
  constructor
  · intro i' i'_le_i
    obtain ⟨bound, h_bound⟩ := notes_contiguous (inp.c crypto) inp.token
    have := (h_bound inp.i).2 note_imp.h_note_exists
    have := (h_bound i').1 (by omega)
    exact this
  · rfl

theorem scan_notes_for_channel_props {crypto: Crypto} {rm: ReachableMemory crypto}
    {sn: ScannedNote} {c token: ℕ}
    (h: sn ∈ scan_notes_for_channel (.from rm) c token) :
    sn.c = c ∧ sn.token = token := by
  simp only [scan_notes_for_channel, List.mem_range, List.mem_map, Nat.lt_find_iff] at h
  obtain ⟨i, h₀, h₁⟩ := h
  simp [←h₁]

------------------------------
-- Scan notes for recipient --
------------------------------

def scan_notes_for_recipient
    {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
    (addrbob: ℕ) (kbob: crypto.PrivateKeys)
    : List ExScannedNote := List.dedup <| do
  let (c, addralice) ← scan_channels crypto m addrbob kbob
  let token ← scan_tokens_for_channel (context.toScanTokenContext) c
  let sn ← scan_notes_for_channel context c token
  return { addralice := addralice, addrbob := addrbob, toScannedNote := sn }

abbrev scan_notes_for_recipient₀
    {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
    (addrbob: ℕ) (kbob: crypto.PrivateKeys)
    : List ScannedNote :=
  scan_notes_for_recipient context addrbob kbob |>.map ExScannedNote.toScannedNote

theorem scan_notes_for_recipient'
    (crypto: Crypto)
    (rm: ReachableMemory crypto)
    (sn: ExScannedNote) (addrbob: ℕ) (kbob: crypto.PrivateKeys):
    sn ∈ scan_notes_for_recipient (.from rm) addrbob kbob ↔ (
      sn.addrbob = addrbob ∧
      (sn.c, sn.addralice) ∈ scan_channels crypto rm addrbob kbob ∧
      sn.token ∈ scan_tokens_for_channel (.from rm) sn.c ∧
      ↑sn ∈ scan_notes_for_channel (.from rm) sn.c sn.token
    ) := by
  simp only [scan_notes_for_recipient, List.bind_eq_flatMap, List.mem_dedup, List.mem_flatMap, List.pure_def,
    List.mem_cons, List.not_mem_nil, or_false]
  constructor
  · intro h
    obtain ⟨⟨c, addralice⟩, h_c, token, h_token, sn', h, h_sn⟩ := h
    have := scan_notes_for_channel_props h
    rw [h_sn, this.1, this.2]
    trivial
  · intro ⟨h₀, h₁, h₂, h₃⟩
    use ⟨sn.c, sn.addralice⟩, h₁, sn.token, h₂, ↑sn, h₃
    rw [←h₀]

-- Existing notes are discoverable by `scan_notes_for_recipient`.
theorem NoteImplies.scan_for_recipient
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    ⟨inp.to_scanned_note crypto, inp.addralice, inp.addrbob⟩ ∈
      scan_notes_for_recipient (.from rm) inp.addrbob note_imp.subchannel.channel.kbob := by
  rw [scan_notes_for_recipient']
  refine ⟨by rfl, ?_, note_imp.subchannel.scan_for_channel, note_imp.scan_for_channel⟩
  · have := note_imp.subchannel.channel.scan
    simp only [OpenChannelInput.c, CreateNoteInput.c, ←NoteImplies.h_kalice] at this
    exact this

theorem NoteImplies.scan_for_recipient₀
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp.to_scanned_note crypto ∈
      scan_notes_for_recipient₀ (.from rm) inp.addrbob note_imp.subchannel.channel.kbob := by
  rw [List.mem_map]
  use ⟨inp.to_scanned_note crypto, inp.addralice, inp.addrbob⟩, note_imp.scan_for_recipient

-- Discoverable note → note_exists and c is linked to (addrbob, kbob).
theorem NoteImplies.from_scan_notes_for_recipient
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys}
    {sn: ExScannedNote}
    (h_kbob: rm.m MemoryType.PublicKeys [addrbob] = crypto.priv_to_pub kbob)
    (h: sn ∈ scan_notes_for_recipient (.from rm) addrbob kbob) :
    ∃ (inp: CreateNoteInput) (_: NoteImplies rm inp),
      inp.to_scanned_note crypto = sn ∧
      inp.addrbob = addrbob ∧
      sn.addralice = inp.addralice ∧
      sn.addrbob = inp.addrbob ∧
      inp.Kbob = crypto.priv_to_pub kbob := by
  rw [scan_notes_for_recipient'] at *
  obtain ⟨h_addrbob, h_scan_channels, _, h'⟩ := h
  unfold scan_notes_for_channel at h'
  simp only [List.mem_map, List.mem_range, Nat.lt_find_iff] at h'
  obtain ⟨i₁, h', h_sn⟩ := h'
  replace h' := h' i₁ (by rfl)

  have ⟨inp, note_imp, h_note_id'⟩ := NoteImplies.from_note_exists (h_sn ▸ h')

  have h_sn' : sn = inp.to_scanned_note crypto := by
    apply Eq.symm
    apply CreateNoteInput.to_scanned_note_eq
    rw [h_note_id', ←h_sn, ScannedNote.note_id]

  have ⟨inp_channel, channel_imp, h_c, h_addralice', h_addrbob', h_kbob⟩ := ChannelImplies.from_scan h_kbob h_scan_channels
  rw [h_sn'] at h_c
  dsimp only [CreateNoteInput.to_scanned_note] at h_c

  refine ⟨inp, note_imp, ?_, ?_, ?_, ?_, ?_⟩
  · apply CreateNoteInput.to_scanned_note_eq
    rw [h_note_id', ←h_sn, ScannedNote.note_id]
  · simp [channel_imp.same_c h_c, h_addrbob']
  · simp [h_addralice', channel_imp.same_c h_c]
  · simp [h_addrbob, h_addrbob', channel_imp.same_c h_c]
  · simp [channel_imp.same_c h_c, channel_imp.h_Kbob, h_kbob]

-- Discoverable note → note_exists and c is linked to (addrbob, kbob).
theorem NoteImplies.from_scan_notes_for_recipient₀
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys}
    {sn: ScannedNote}
    (h_kbob: rm.m MemoryType.PublicKeys [addrbob] = crypto.priv_to_pub kbob)
    (h: sn ∈ scan_notes_for_recipient₀ (.from rm) addrbob kbob) :
    ∃ (inp: CreateNoteInput) (_: NoteImplies rm inp),
      inp.to_scanned_note crypto = sn ∧
      inp.addrbob = addrbob ∧
      inp.Kbob = crypto.priv_to_pub kbob := by
  rw [List.mem_map] at h
  have ⟨sn, h, h_sn⟩ := h
  have ⟨inp, note_imp, h_sn, h_addrbob, h_sn_addralice, h_sn_addrbob, h_kbob⟩ := NoteImplies.from_scan_notes_for_recipient h_kbob h
  use inp, note_imp
  simp [*]

theorem scan_notes_for_recipient₀.nodup
    {crypto: Crypto} {rm: ReachableMemory crypto}
    {addrbob: ℕ} {kbob: crypto.PrivateKeys}
    (h_kbob: rm.m MemoryType.PublicKeys [addrbob] = crypto.priv_to_pub kbob) :
    (scan_notes_for_recipient₀ (.from rm) addrbob kbob).Nodup := by
  rw [scan_notes_for_recipient₀]
  apply List.Nodup.map_on
  · intro x h_x y h_y h_eq

    have ⟨inp, note_imp, h₀, h₁, h₂, h₃, h₄⟩ := NoteImplies.from_scan_notes_for_recipient h_kbob h_x
    have ⟨inp', note_imp', h₀', h₁', h₂', h₃', h₄'⟩ := NoteImplies.from_scan_notes_for_recipient h_kbob h_y

    have : inp.c crypto = inp'.c crypto := by
      have := h₀ ▸ h₀' ▸ congrArg ScannedNote.c h_eq
      exact this

    apply crypto.h_hash at this
    injections

    apply ExScannedNote.ext h_eq
    · rw [h₂, h₂']; simp [*]
    · rw [h₃, h₃']; simp [*]
  · apply List.nodup_dedup
