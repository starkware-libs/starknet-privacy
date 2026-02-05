import privacy.notes.discoverable_outgoing
import privacy.notes.open_deposits
import privacy.amounts.amounts

def nonopen_created_notes
  {crypto: Crypto} {m: Memory} (context: ScanOutgoingNoteContext crypto m)
  (addralice: ℕ) (kalice: ℕ) (token: ℕ) : List ExScannedNote :=
  (
    scan_outgoing_notes_for_sender context addralice kalice
    |>.filter (λ sn ↦ sn.token = token)
    |>.filter (λ sn ↦ is_open_note crypto m (sn.note_id crypto) = false)
  )

theorem filtered_scan_outgoing_notes_eq_notes_from_actions
    {crypto: Crypto} (rm: ReachableMemory crypto) (alice: UserPrivKey crypto rm.m) (token: ℕ) :
    (
      nonopen_created_notes (.from rm) alice.addr alice.k token
      |>.toFinset
    ) = (
      create_note_actions crypto rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = alice.addr ∧ inp.r ≠ 1)
      |>.map (λ inp ↦ inp.to_ex_scanned_note crypto)
      |>.toFinset
    ) := by
  ext esn
  simp only [nonopen_created_notes, List.mem_toFinset, List.mem_filter, List.mem_map, decide_eq_true_eq]
  constructor
  · intro ⟨⟨h_scan, h_token⟩, h_open⟩
    have ⟨inp, note_imp, h_esn, h_addralice, _⟩ := NoteImplies.from_scan_outgoing_notes_for_sender h_scan
    refine ⟨inp, ⟨note_imp.in_create_note_actions, ?_, h_addralice, ?_⟩, h_esn⟩
    · rw [←h_token, ←h_esn]
    · rw [is_open_note, decide_eq_false_iff_not, ←h_esn] at h_open
      exact note_imp.h_r ▸ h_open
  · intro ⟨inp, ⟨h_in, h_token, h_addralice, h_r⟩, h_esn⟩
    have ⟨note_imp⟩ := NoteImplies.from_create_note_actions h_in
    have := h_esn ▸ note_imp.scan_outgoing

    have h_kalice : inp.kalice = alice.k := by
       rw [note_imp.h_kalice]
       apply crypto.priv_to_pub_inj (note_imp.subchannel.channel.alice_registered.h_kalice) (by simp)
       rw [←alice.h_k, ←h_addralice]
       rw [note_imp.subchannel.channel.alice_registered.public_key]

    refine ⟨⟨?_, ?_⟩, ?_⟩
    · rw [←h_esn, ←h_addralice, ←h_kalice]
      exact note_imp.scan_outgoing
    · rw [←h_esn, ←h_token]
    · rw [is_open_note, decide_eq_false_iff_not, ←h_esn]
      rw [note_imp.h_r]
      exact h_r

theorem sum_of_nonopen_created_notes_to_scanned_notes
    {crypto: Crypto} {rm: ReachableMemory crypto} (alice: UserPrivKey crypto rm.m) (token: ℕ) :
    (
      nonopen_created_notes (.from rm) alice.addr alice.k token
      |>.map (λ sn ↦ sn.amount crypto rm)
      |>.sum
    ) = (
      create_note_actions crypto rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = alice.addr ∧ inp.r ≠ 1)
      |>.map (λ inp ↦ inp.amount)
      |>.sum
    ) := by
  rw [←List.sum_toFinset _ (by
    apply List.Nodup.filter
    apply List.Nodup.filter
    apply List.nodup_dedup
  )]

  rw [filtered_scan_outgoing_notes_eq_notes_from_actions rm alice token]

  rw [List.sum_toFinset _ (by
    apply filter_map_nodup
    apply List.Nodup.of_map (λ x ↦ x.note_id crypto)
    rw [List.map_map]
    have : ((λ x ↦ x.note_id crypto) ∘ λ inp ↦ inp.to_ex_scanned_note crypto) =
        (λ inp ↦ CreateNoteInput.note_id crypto inp) := by
      ext x; simp
    rw [this]
    apply List.nodup_iff_count_le_one.2
    intro x
    apply create_note_actions_note_id_nodup
  )]

  apply congrArg

  simp only [ne_eq, Bool.decide_and, decide_not, List.map_map]
  apply List.map_congr_left
  intro inp h_inp
  simp only [List.mem_filter, Bool.and_eq_true, decide_eq_true_eq, Bool.not_eq_eq_eq_not,
    Bool.not_true, decide_eq_false_iff_not] at h_inp
  have ⟨h_inp, h_token, h_addralice, h_r⟩ := h_inp
  simp only [Function.comp_apply]

  have ⟨note_imp⟩ := NoteImplies.from_create_note_actions h_inp

  rw [(note_amount_eq_amount h_inp).2]
  simp [sum_deposits_for_note_id_eq_zero₁ note_imp h_r]
