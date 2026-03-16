import privacy.channels.discoverable_outgoing
import privacy.notes.discoverable

structure ScanOutgoingNoteContext (crypto: Crypto) (m: Memory) extends ScanOutgoingChannelContext crypto m, ScanNoteContext crypto m where

theorem ScanOutgoingNoteContext.from {crypto: Crypto} (rm: ReachableMemory crypto) :
    ScanOutgoingNoteContext crypto rm.m :=
  {
    toScanOutgoingChannelContext := .from rm,
    toScanNoteContext := .from rm,
  }

def scan_outgoing_notes_for_sender
    {crypto: Crypto} {m: Memory} (context: ScanOutgoingNoteContext crypto m)
    (addralice kalice: ℕ)
    : List ExScannedNote := List.dedup <| do
  let addrbob ← scan_outgoing_channels context.toScanOutgoingChannelContext addralice kalice
  let Kbob := m .PublicKeys [addrbob]
  let c := crypto.hash [addralice, kalice, addrbob, Kbob]
  let token ← scan_tokens_for_channel (context.toScanTokenContext) c
  let sn ← scan_notes_for_channel context.toScanNoteContext c token
  return ⟨sn, addralice, addrbob⟩

theorem NoteImplies.from_scan_outgoing_notes_for_sender
    {crypto: Crypto} {rm: ReachableMemory crypto} {addralice kalice: ℕ} {esn: ExScannedNote}
    (h: esn ∈ scan_outgoing_notes_for_sender (.from rm) addralice kalice) :
    ∃ (inp: CreateNoteInput) (_note_imp: NoteImplies rm inp),
    inp.to_ex_scanned_note crypto = esn ∧ inp.addralice = addralice ∧ inp.kalice = kalice := by
  simp only [scan_outgoing_notes_for_sender, List.bind_eq_flatMap, List.mem_dedup, List.mem_flatMap,
    List.pure_def, List.mem_singleton] at h

  obtain ⟨addrbob, h_bob, token, h_token, sn, h_sn, h_esn⟩ := h
  have ⟨h_c, h_token⟩ := scan_notes_for_channel_props h_sn
  let Kbob := rm.m MemoryType.PublicKeys [addrbob]

  unfold scan_notes_for_channel at h_sn
  simp only [List.mem_map, List.mem_range, Nat.lt_find_iff] at h_sn
  obtain ⟨i₁, h_sn, h_note_id⟩ := h_sn

  replace h_sn := h_sn i₁ (by rfl)
  rw [h_esn, ←h_note_id]

  have ⟨inp, note_impl, h_note_id⟩ := NoteImplies.from_note_exists h_sn
  apply crypto.h_hash at h_note_id
  injections

  have h_c' : inp.c crypto = crypto.hash [addralice, kalice, addrbob, rm.m MemoryType.PublicKeys [addrbob]] := by assumption
  apply crypto.h_hash at h_c'
  injections

  refine ⟨inp, note_impl, ?_, by assumption, by assumption⟩
  ext
  all_goals simp [*]

theorem NoteImplies.scan_outgoing
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp.to_ex_scanned_note crypto ∈ scan_outgoing_notes_for_sender (.from rm) inp.addralice inp.kalice := by
  have := note_imp.subchannel.channel.scan

  have h_Kbob := note_imp.subchannel.channel.bob_registered.public_key
  simp only [note_imp.h_Kbob] at h_Kbob

  simp only [scan_outgoing_notes_for_sender, List.bind_eq_flatMap, List.mem_dedup, List.mem_flatMap,
    List.pure_def, List.mem_singleton]
  refine ⟨inp.addrbob, ?_, inp.token, h_Kbob ▸ note_imp.subchannel.scan_for_channel, inp.to_scanned_note crypto, ?_, ?_⟩
  · rw [note_imp.h_kalice]
    use outgoing_channels_are_discoverable note_imp.subchannel.channel.h_channel_exists
  · rw [h_Kbob]
    exact note_imp.scan_for_channel
  · simp [*]
