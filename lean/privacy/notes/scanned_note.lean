import privacy.utils
import privacy.actions
import privacy.notes.note_implies

structure ScannedNote where
  (c token i: ℕ)
deriving DecidableEq

@[ext] theorem ScannedNote.ext : ∀ {sn sn' : ScannedNote},
    sn.c = sn'.c → sn.token = sn'.token → sn.i = sn'.i → sn = sn' := by
  intro sn sn' h_c h_token h_i
  cases sn; cases sn'
  simp at *
  simp [*]

abbrev ScannedNote.note_id (crypto: Crypto) (sn: ScannedNote) : ℕ :=
  crypto.hash [sn.c, sn.token, sn.i]

theorem ScannedNote.note_id_eq {crypto: Crypto} {sn sn': ScannedNote} :
    sn.note_id crypto = sn'.note_id crypto → sn = sn' := by
  intro h
  apply crypto.h_hash at h
  injections
  ext
  repeat assumption

abbrev ScannedNote.amount (crypto: Crypto) (m: Memory) (sn: ScannedNote) : ℕ :=
  note_amount crypto m (sn.note_id crypto) sn.c sn.token sn.i

abbrev NoteImplies.from_amount_nz
    {crypto: Crypto} {rm: ReachableMemory crypto} {sn: ScannedNote}
    (h_amount_nz: sn.amount crypto rm ≠ 0) :
    ∃ (inp: CreateNoteInput) (_: NoteImplies rm inp), inp.note_id crypto = sn.note_id crypto := by
  apply NoteImplies.from_note_exists
  by_contra not_exists
  dsimp only [ScannedNote.amount, note_amount] at h_amount_nz
  simp only [note_exists, ne_eq, Decidable.not_not] at not_exists
  simp [not_exists, crypto.unpack_zero] at h_amount_nz

abbrev CreateNoteInput.to_scanned_note (crypto: Crypto) (inp: CreateNoteInput) : ScannedNote :=
  ⟨inp.c crypto, inp.token, inp.i⟩

theorem CreateNoteInput.to_scanned_note_eq {crypto: Crypto} {inp: CreateNoteInput} {sn: ScannedNote}
    (h: inp.note_id crypto = sn.note_id crypto) :
    inp.to_scanned_note crypto = sn :=
   ScannedNote.note_id_eq (crypto:=crypto) h

abbrev UseNoteInput.to_scanned_note (inp: UseNoteInput) : ScannedNote :=
  ⟨inp.c, inp.token, inp.i⟩

structure ExScannedNote extends ScannedNote where
  (addralice addrbob: ℕ)
deriving DecidableEq

instance : Coe ExScannedNote ScannedNote where
  coe := ExScannedNote.toScannedNote

@[ext] theorem ExScannedNote.ext {sn sn' : ExScannedNote}
    (h_sn: sn.toScannedNote = sn'.toScannedNote)
    (h_addralice: sn.addralice = sn'.addralice)
    (h_addrbob: sn.addrbob = sn'.addrbob) :
    sn = sn' := by
  cases sn; cases sn'
  simp at *
  simp [*]

abbrev CreateNoteInput.to_ex_scanned_note (crypto: Crypto) (inp: CreateNoteInput) : ExScannedNote :=
  ⟨
    inp.to_scanned_note crypto,
    inp.addralice,
    inp.addrbob,
  ⟩
