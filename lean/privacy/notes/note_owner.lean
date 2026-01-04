import privacy.utils
import privacy.actions
import privacy.notes.create_note_actions
import privacy.notes.discoverable

def note_owner (crypto: Crypto) (note_id: ℕ) (addrbob: ℕ) (kbob: crypto.PrivateKeys) : Prop :=
  ∃ sn: ScannedNote, ∃ addralice kalice,
    sn.note_id crypto = note_id ∧ sn.c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob]

theorem note_owner_of_create_note₀
    (crypto: Crypto) (inp: CreateNoteInput) (kbob: crypto.PrivateKeys)
    (h_kbob: crypto.priv_to_pub kbob = inp.Kbob) :
    note_owner crypto (inp.note_id crypto) inp.addrbob kbob := by
  use inp.to_scanned_note crypto, inp.addralice, inp.kalice
  rw [h_kbob]
  exact ⟨by rfl, by rfl⟩

-- CreateNote action implies that `note_owner` is the recipient of the CreateNote action.
theorem note_owner_of_create_note
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (h_inp: inp ∈ create_note_actions crypto rm) :
    ∃ kbob: crypto.PrivateKeys,
    note_owner crypto (inp.note_id crypto) inp.addrbob kbob ∧
    crypto.priv_to_pub kbob = inp.Kbob := by
  have h_note_exists := (create_note_actions_implies h_inp).1
  have ⟨sn, h_note_id, _, _, h_subchannel_exists⟩ := note_exists_implies_i₀ h_note_exists
  have ⟨_, ⟨addralice, addrbob, Kbob, h_channel_exists⟩⟩ := subchannel_exists_implies h_subchannel_exists
  have ⟨⟨kalice, h_sn_c, _⟩, ⟨kbob, _⟩⟩ := channel_exists_implies_hash h_channel_exists

  have : crypto.priv_to_pub ↑kbob = inp.Kbob := by
    have := CreateNoteInput.to_scanned_note_eq h_note_id
    rw [←this] at h_sn_c
    apply crypto.h_hash at h_sn_c
    injections
    simp [*]

  exact ⟨kbob, note_owner_of_create_note₀ crypto inp kbob this, this⟩

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
