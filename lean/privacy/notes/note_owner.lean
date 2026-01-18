import privacy.utils
import privacy.actions
import privacy.notes.create_note_actions
import privacy.notes.discoverable

def note_owner (crypto: Crypto) (note_id: ℕ) (addrbob: ℕ) (kbob: crypto.PrivateKeys) : Prop :=
  ∃ sn: ScannedNote, ∃ addralice kalice,
    sn.note_id crypto = note_id ∧ sn.c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob]

-- CreateNote action implies that `note_owner` is the recipient of the CreateNote action.
theorem note_owner_of_create_note
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    let kbob := note_imp.subchannel.channel.kbob
    note_owner crypto (inp.note_id crypto) inp.addrbob kbob := by
  intro kbob
  use inp.to_scanned_note crypto, inp.addralice, inp.kalice
  rw [←note_imp.subchannel.channel.h_Kbob]
  exact ⟨by rfl, by rfl⟩

-- Each note has at most one owner (addrbob, kbob).
theorem unique_note_owner
    {crypto: Crypto} {note_id: ℕ} {addrbob addrbob': ℕ} {kbob kbob': crypto.PrivateKeys}
    (h: note_owner crypto note_id addrbob kbob)
    (h': note_owner crypto note_id addrbob' kbob') :
    addrbob = addrbob' ∧ kbob = kbob' := by
  have ⟨sn, addralice, kalice, h_sn, h_c⟩ := h
  have ⟨sn', addralice', kalice', h_sn', h_c'⟩ := h'
  rw [←h_sn'] at h_sn
  have h_sn : sn = sn' := ScannedNote.note_id_eq h_sn
  rw [h_sn, h_c'] at h_c
  have := crypto.h_hash h_c
  injections
  constructor
  · simp [*]
  · apply Subtype.coe_inj.1
    exact crypto.priv_to_pub_inj (by simp) (by simp) (by simp [*])
