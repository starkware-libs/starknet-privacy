import privacy.actions.reachable_memory
import privacy.registration.discoverable
import privacy.notes.discoverable

structure ScanAllNotesContext (crypto: Crypto) (m: Memory) (events: List Event) extends ScanNoteContext crypto m where
  h_scan_users_private_key: ∀ user : { x // x ∈ scan_users crypto events }, user.val.2 ∈ crypto.PrivateKeys

theorem ScanAllNotesContext.from {crypto: Crypto} (rm: ReachableMemory crypto) :
    ScanAllNotesContext crypto rm.m rm.events :=
  {
    toScanNoteContext := .from rm,
    h_scan_users_private_key := λ user ↦ (RegisterImplies.from_scan user.prop).h_kalice,
  }

def scan_all_notes {crypto: Crypto} {m: Memory} {events: List Event}
    (context: ScanAllNotesContext crypto m events) : List ExScannedNote := do
  scan_users crypto events
  |>.attach
  |>.flatMap (λ user ↦
    scan_notes_for_recipient (context.toScanNoteContext) user.val.1 ⟨user.val.2, context.h_scan_users_private_key user⟩
  )

private theorem scan_all_notes_iff {crypto: Crypto} {rm: ReachableMemory crypto} {sn: ExScannedNote} :
    sn ∈ scan_all_notes (.from rm) ↔
    ∃ (addralice: ℕ), ∃ (kalice: crypto.PrivateKeys),
      (addralice, ↑kalice) ∈ scan_users crypto rm.events ∧
      sn ∈ scan_notes_for_recipient (.from rm) addralice kalice := by
  rw [scan_all_notes, List.mem_flatMap]
  constructor
  · intro h
    have ⟨⟨⟨addralice, kalice⟩, h_in_scan_users⟩, h₀, h₁⟩ := h
    have register_imp := RegisterImplies.from_scan h_in_scan_users
    use addralice, ⟨kalice, register_imp.h_kalice⟩, h_in_scan_users, h₁
  · intro h
    have ⟨addralice, kalice, h₀, h₁⟩ := h
    use ⟨⟨addralice, kalice⟩, h₀⟩, List.mem_attach _ ⟨_, h₀⟩, h₁

-- All notes can be retrieved given the compliance private key.
theorem NoteImplies.in_scan_all_notes {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
  (note_imp: NoteImplies rm inp) :
  inp.to_ex_scanned_note crypto ∈ scan_all_notes (.from rm) := by
  rw [scan_all_notes_iff]
  exact ⟨
    inp.addrbob,
    note_imp.subchannel.channel.kbob,
    note_imp.subchannel.channel.bob_registered.scan,
    note_imp.scan_for_recipient
  ⟩

theorem NoteImplies.from_scan_all_notes
    {crypto: Crypto} {rm: ReachableMemory crypto} {esn: ExScannedNote}
    (h: esn ∈ scan_all_notes (.from rm)) :
    ∃ (inp: CreateNoteInput) (_note_imp: NoteImplies rm inp),
    inp.to_ex_scanned_note crypto = esn ∧
    inp.addralice = esn.addralice ∧ inp.addrbob = esn.addrbob := by
  have ⟨addralice, kalice, h₀, h₁⟩ := scan_all_notes_iff.1 h
  have register_imp := RegisterImplies.from_scan h₀
  have ⟨inp, note_imp, h⟩ := NoteImplies.from_scan_notes_for_recipient
    (by rw [register_imp.public_key]) h₁
  refine ⟨inp, note_imp, ?_, by simp [*], by simp [*]⟩
  apply ExScannedNote.ext
  all_goals simp [h]
