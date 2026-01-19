import privacy.actions.reachable_memory
import privacy.registration.discoverable
import privacy.notes.discoverable

structure ScanAllNotesContext (crypto: Crypto) (m: Memory) (events: List Event) extends ScanNoteContext crypto m where
  h_scan_users_private_key: ∀ user : { x // x ∈ scan_users crypto events }, user.val.2 ∈ crypto.PrivateKeys

theorem ScanAllNotesContext.from {crypto: Crypto} (rm: ReachableMemory crypto) :
    ScanAllNotesContext crypto rm.m rm.events :=
  {
    toScanNoteContext := .from rm,
    h_scan_users_private_key := λ user ↦ scan_users_private_key rm user.prop,
  }

def scan_all_notes {crypto: Crypto} {m: Memory} {events: List Event}
    (context: ScanAllNotesContext crypto m events) : List ScannedNote := do
  scan_users crypto events
  |>.attach
  |>.flatMap (λ user ↦
    scan_notes_for_recipient (context.toScanNoteContext) user.val.1 ⟨user.val.2, context.h_scan_users_private_key user⟩
  )

theorem scan_all_notes_iff {crypto: Crypto} {rm: ReachableMemory crypto} {sn: ScannedNote} :
    sn ∈ scan_all_notes (.from rm) ↔
    ∃ (addralice: ℕ), ∃ (kalice: crypto.PrivateKeys),
      (addralice, ↑kalice) ∈ scan_users crypto rm.events ∧
      sn ∈ scan_notes_for_recipient (.from rm) addralice kalice := by
  rw [scan_all_notes, List.mem_flatMap]
  constructor
  · intro h
    have ⟨⟨⟨addralice, kalice⟩, h_in_scan_users⟩, h₀, h₁⟩ := h
    use addralice, ⟨kalice, scan_users_private_key rm h_in_scan_users⟩, h_in_scan_users, h₁
  · intro h
    have ⟨addralice, kalice, h₀, h₁⟩ := h
    use ⟨⟨addralice, kalice⟩, h₀⟩, List.mem_attach _ ⟨_, h₀⟩, h₁

-- All notes can be retrieved given the compliance private key.
theorem NoteImplies.scan_all_notes {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
  (note_imp: NoteImplies rm inp) :
  inp.to_scanned_note crypto ∈ scan_all_notes (.from rm) := by
  rw [scan_all_notes_iff]
  exact ⟨
    inp.addrbob,
    note_imp.subchannel.channel.kbob,
    note_imp.subchannel.channel.bob_registered.scan,
    note_imp.scan_for_recipient
  ⟩
