import privacy.utils
import privacy.actions

structure ScannedNote where
  (c token i₀ i₁: ℕ)
deriving DecidableEq

@[ext] theorem ScannedNote.ext : ∀ {sn sn' : ScannedNote},
    sn.c = sn'.c → sn.token = sn'.token → sn.i₀ = sn'.i₀ → sn.i₁ = sn'.i₁ → sn = sn' := by
  intro sn sn' h_c h_token h_i₀ h_i₁
  cases sn; cases sn'
  simp at *
  simp [*]

abbrev ScannedNote.note_id (crypto: Crypto) (sn: ScannedNote) : ℕ :=
  crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁]

theorem ScannedNote.note_id_eq {crypto: Crypto} {sn sn': ScannedNote} :
    sn.note_id crypto = sn'.note_id crypto → sn = sn' := by
  intro h
  apply crypto.h_hash at h
  injections
  ext
  repeat assumption

abbrev ScannedNote.amount (crypto: Crypto) (m: Memory) (sn: ScannedNote) : ℕ :=
  note_amount crypto m (sn.note_id crypto) sn.c sn.token sn.i₀ sn.i₁

abbrev CreateNoteInput.to_scanned_note (crypto: Crypto) (inp: CreateNoteInput) : ScannedNote :=
  ⟨inp.c crypto, inp.token, inp.i₀, inp.i₁⟩

theorem CreateNoteInput.to_scanned_note_eq {crypto: Crypto} {inp: CreateNoteInput} {sn: ScannedNote}
    (h: inp.note_id crypto = sn.note_id crypto) :
    inp.to_scanned_note crypto = sn :=
   ScannedNote.note_id_eq (crypto:=crypto) h

abbrev CancelNoteInput.to_scanned_note (inp: CancelNoteInput) : ScannedNote :=
  ⟨inp.c, inp.token, inp.i₀, inp.i₁⟩
