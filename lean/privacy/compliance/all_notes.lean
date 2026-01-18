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
theorem all_notes_are_discoverable {crypto: Crypto} {rm: ReachableMemory crypto} {note_id: ℕ}
  (h: note_exists rm note_id) :
  ∃ sn ∈ scan_all_notes (.from rm),
    note_id = sn.note_id crypto ∧
    ∃ (addralice kalice addrbob: ℕ) (kbob: crypto.PrivateKeys),
      sn.c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob] ∧
      (addralice, kalice) ∈ scan_users crypto rm.events ∧
      (addrbob, ↑kbob) ∈ scan_users crypto rm.events := by
  obtain ⟨addrbob, kbob, sn, h₀, h₁, h_channel_exists, ⟨addralice, kalice, h₃⟩⟩ := note_exists_implies_for_recipient h

  have ⟨addralice', addrbob', Kbob, h_channel_exists⟩ := h_channel_exists
  have ⟨⟨kalice', h_sn_c, h_private_key_hashes_alice⟩, ⟨kbob', _, h_private_key_hashes_bob⟩⟩ := channel_exists_implies_hash h_channel_exists

  have ⟨h_addrbob, h_kbob⟩ : addrbob = addrbob' ∧ kbob = kbob' := by
    rw [h₃] at h_sn_c
    have := crypto.h_hash h_sn_c
    injections
    simp only [true_and, *]
    apply Subtype.coe_inj.1
    apply crypto.priv_to_pub_inj (by simp) (by simp)
    simp [*]

  replace h_private_key_hashes_bob := calc _
    _ = _ := h_private_key_hashes_bob
    _ ≠ 0 := by simp

  have ⟨inp_alice, h_inp_in_actions_alice, h_inp_alice⟩ := private_key_hash_implies h_private_key_hashes_alice
  have ⟨inp_bob, h_inp_in_actions_bob, h_inp_bob⟩ := private_key_hash_implies h_private_key_hashes_bob

  refine ⟨sn, ?_, h₁, ?_⟩

  · rw [scan_all_notes_iff]
    refine ⟨addrbob, kbob, ?_, h₀⟩
    rw [h_addrbob, h_kbob]
    rw [←h_inp_bob.1, ←h_inp_bob.2]

    exact register_implies_scan_users h_inp_in_actions_bob
  · use addralice, kalice, addrbob, kbob
    rw [h_addrbob, h_kbob]
    rw [←h_inp_bob.1, ←h_inp_bob.2]
    refine ⟨?_, ?_, ?_⟩
    · simp [*]
    · have : addralice = addralice' ∧ kalice = kalice' := by
        rw [h₃] at h_sn_c
        apply crypto.h_hash at h_sn_c
        injections
        simp [*]
      simp only [this, ←h_inp_alice]
      exact register_implies_scan_users h_inp_in_actions_alice
    · exact register_implies_scan_users h_inp_in_actions_bob
