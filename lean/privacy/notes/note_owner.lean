import privacy.utils
import privacy.actions
import privacy.notes.create_note_actions
import privacy.notes.discoverable

def note_owner (crypto: Crypto) (note_id: ℕ) (addrbob: ℕ) : Prop :=
  ∃ sn: ScannedNote, ∃ addralice kalice Kbob,
    sn.note_id crypto = note_id ∧ sn.c = crypto.hash [addralice, kalice, addrbob, Kbob]

-- CreateNote action implies that `note_owner` is the recipient of the CreateNote action.
theorem note_owner_of_create_note
    (crypto: Crypto) (inp: CreateNoteInput) :
    note_owner crypto (inp.note_id crypto) inp.addrbob := by
  use inp.to_scanned_note crypto, inp.addralice, inp.kalice, inp.Kbob

-- Each note has at most one owner (addrbob, kbob).
theorem unique_note_owner
    {crypto: Crypto} {note_id: ℕ} {addrbob addrbob': ℕ}
    (h: note_owner crypto note_id addrbob)
    (h': note_owner crypto note_id addrbob') :
    addrbob = addrbob' := by
  have ⟨sn, addralice, kalice, Kbob, h_sn, h_c⟩ := h
  have ⟨sn', addralice', kalice', Kbob', h_sn', h_c'⟩ := h'
  rw [←h_sn'] at h_sn
  have h_sn : sn = sn' := ScannedNote.note_id_eq h_sn
  rw [h_sn, h_c'] at h_c
  have := crypto.h_hash h_c
  injections
  simp [*]
