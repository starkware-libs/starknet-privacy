import privacy.channels.discoverable_outgoing
import privacy.notes.discoverable

structure ScanOutgoingNoteContext (crypto: Crypto) (m: Memory) extends ScanOutgoingChannelContext crypto m, ScanNoteContext crypto m where

theorem ScanOutgoingNoteContext.from {crypto: Crypto} (rm: ReachableMemory crypto) :
    ScanOutgoingNoteContext crypto rm.m :=
  {
    toScanOutgoingChannelContext := .from rm,
    toScanNoteContext := .from rm,
  }

def scan_outgoing_notes_for_recipient
    {crypto: Crypto} {m: Memory} (context: ScanOutgoingNoteContext crypto m)
    (addralice kalice: ℕ)
    : List ScannedNote := do
  let bob ← scan_outgoing_channels context.toScanOutgoingChannelContext addralice kalice
  let c := crypto.hash [addralice, kalice, bob.1, bob.2]
  let token ← scan_tokens_for_channel (context.toScanTokenContext) c
  scan_notes_for_channel context.toScanNoteContext c token

theorem scan_outgoing_notes_for_recipient_implies
    {crypto: Crypto} {rm: ReachableMemory crypto} {addralice kalice: ℕ} {sn: ScannedNote} :
    (h: sn ∈ scan_outgoing_notes_for_recipient (.from rm) addralice kalice) →
    note_exists rm (sn.note_id crypto) ∧
    ∃ addrbob kbob, sn.c = crypto.hash [addralice, kalice, addrbob, kbob] := by
  simp only [scan_outgoing_notes_for_recipient, List.bind_eq_flatMap, List.mem_flatMap]
  intro h
  obtain ⟨bob, h_bob, token, h_token, h⟩ := h
  have ⟨h_c, h_token⟩ := scan_notes_for_channel_props h
  refine ⟨?_, ⟨bob.1, bob.2, h_c⟩⟩

  unfold scan_notes_for_channel at h
  simp only [List.mem_flatMap, List.mem_range] at h
  obtain ⟨i₀, i₀_lt, h⟩ := h
  unfold scan_notes_for_channel_i₀ at h
  simp only [List.mem_map, List.mem_range, Nat.lt_find_iff] at h
  obtain ⟨i₁, h, h_note_id⟩ := h

  replace h := h i₁ (by rfl)
  rw [←h_note_id]
  exact h

theorem notes_are_discoverable_outgoing
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp.to_scanned_note crypto ∈ scan_outgoing_notes_for_recipient (.from rm) inp.addralice inp.kalice := by
  have := note_imp.subchannel.channel.scan

  simp only [scan_outgoing_notes_for_recipient, List.bind_eq_flatMap, List.mem_flatMap]
  refine ⟨⟨inp.addrbob, inp.Kbob⟩, ?_, inp.token, note_imp.subchannel.scan, note_imp.scan_for_channel⟩
  rw [note_imp.h_kalice]
  use outgoing_channels_are_discoverable note_imp.subchannel.channel.h_channel_exists
