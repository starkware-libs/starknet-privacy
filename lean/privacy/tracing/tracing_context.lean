import privacy.tracing.coin
import privacy.tracing.incoming_notes
import privacy.tracing.outgoing_notes
import privacy.tracing.withdrawals

structure TracingContext (crypto: Crypto) (m: Memory) (events: List (List Event))
    extends ScanOutgoingNoteContext crypto m where
  h_incoming_eq_outgoing: ∀ (user: UserPrivKey crypto m) (token: ℕ),
    (
      spent_notes_ex toScanNoteContext user.addr user.k token
      |>.map (λ sn ↦ sn.amount crypto m)
      |>.sum
    ) = (
      nonopen_created_notes toScanOutgoingNoteContext user.addr user.k token
      |>.map (λ sn ↦ sn.amount crypto m)
      |>.sum
    ) + (
      withdrawals_for_user_token toScanNoteContext events user token
      |>.map (λ evt ↦ evt.amount)
      |>.sum
    )
  h_coin_props_alice : ∀ coin: Coin crypto m,
    let kalice := get_priv_key crypto events.flatten coin.esn.addralice
    kalice ∈ crypto.PrivateKeys ∧
    m MemoryType.PublicKeys [coin.esn.addralice] = crypto.priv_to_pub kalice ∧
    coin.esn ∈ scan_outgoing_notes_for_sender toScanOutgoingNoteContext coin.esn.addralice kalice
  h_coin_props_bob : ∀ coin: Coin crypto m,
    let kbob := get_priv_key crypto events.flatten coin.esn.addrbob
    kbob ∈ crypto.PrivateKeys ∧
    m MemoryType.PublicKeys [coin.esn.addrbob] = crypto.priv_to_pub kbob ∧
    ∀ h, coin.esn ∈ scan_notes_for_recipient toScanNoteContext coin.esn.addrbob ⟨kbob, h⟩
  h_scan_outgoing_notes_for_sender: ∀ (addralice kalice: ℕ) (esn: ExScannedNote),
    esn ∈ scan_outgoing_notes_for_sender toScanOutgoingNoteContext addralice kalice →
    addralice = esn.addralice ∧
    ∃ Kbob, esn.c = crypto.hash [esn.addralice, kalice, esn.addrbob, Kbob]
  h_scan_notes_for_recipient: ∀ (bob: UserPrivKey crypto m) (esn: ExScannedNote),
    esn ∈ scan_notes_for_recipient toScanNoteContext bob.addr bob.k →
    bob.addr = esn.addrbob ∧
    ∃ kalice, esn.c = crypto.hash [esn.addralice, kalice, esn.addrbob, crypto.priv_to_pub bob.k]
  h_fintype_coin: Nonempty (Fintype (Coin crypto m))
  h_from_create_open_note_event: ∀ note_id user_enc: ℕ,
    .CreateOpenNote note_id user_enc ∈ events.flatten →
    is_open_note crypto m note_id ∧
    (
      let addr := (crypto.dec crypto.council_priv_key user_enc).headD 0
      let privkey := get_priv_key crypto events.flatten addr
      privkey ∈ crypto.PrivateKeys ∧
      m MemoryType.PublicKeys [addr] = crypto.priv_to_pub privkey
    )

theorem incoming_eq_outgoing
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto) (user: UserPrivKey crypto stxs.rm.m) (token: ℕ) :
    (
      spent_notes_ex (.from stxs.rm) user.addr user.k token
      |>.map (λ sn ↦ sn.amount crypto stxs.rm)
      |>.sum
    ) = (
      nonopen_created_notes (.from stxs.rm) user.addr user.k token
      |>.map (λ sn ↦ sn.amount crypto stxs.rm)
      |>.sum
    ) + (
      withdrawals_for_user_token (.from stxs.rm) stxs.events user token
      |>.map (λ evt ↦ evt.amount)
      |>.sum
    ) := by
  -- Simplify LHS:
  set f_amount := (λ sn: ExScannedNote ↦ sn.amount crypto stxs.rm)
  have : f_amount = (λ sn: ScannedNote ↦ sn.amount crypto stxs.rm) ∘ (λ sn: ExScannedNote ↦ ↑sn) := by rfl
  conv =>
    lhs
    rw [this, ←List.map_map]
    rw [spent_notes_ex_eq_spent_notes]

  -- Both hands:
  rw [incoming_notes, outgoing_notes, withdrawals_for_user_token_sum]
  rw [←List.sum_map_add]
  apply congrArg
  apply List.map_congr_left
  intro tx h_tx
  rw [List.mem_filter] at h_tx
  rw [←tx.sum_create_note_amounts_eq_nonopen _ h_tx.1, tx.h_balance]

theorem TracingContext.from {crypto: Crypto} (stxs: SuccessfulTransactions crypto) :
    TracingContext crypto stxs.rm.m stxs.events := {
  toScanOutgoingNoteContext := .from stxs.rm,
  h_incoming_eq_outgoing := λ user token ↦ incoming_eq_outgoing stxs user token
  h_coin_props_alice := by
    intro coin kalice
    have ⟨kalice', Kbob, h_c⟩ := coin.h_c
    have ⟨inp, note_imp, h_note_id⟩ := NoteImplies.from_coin coin

    have h_inp₀ := CreateNoteInput.to_scanned_note_eq h_note_id
    have h_inp₁ := ScannedNote.ext_iff.1 h_inp₀
    simp only [h_c] at h_inp₁
    have h_inp₂ := crypto.h_hash h_inp₁.1
    injections

    have h_addralice : coin.esn.addralice = inp.addralice := by simp [*]

    have h_public_keys: stxs.rm.m MemoryType.PublicKeys [coin.esn.addralice] = crypto.priv_to_pub inp.kalice := by
      rw [h_addralice]

      have := note_imp.subchannel.channel.alice_registered.public_key
      simp only at this
      exact note_imp.h_kalice ▸ this

    have kalice_priv : inp.kalice ∈ crypto.PrivateKeys :=
      note_imp.h_kalice ▸ note_imp.subchannel.channel.alice_registered.h_kalice

    have register_imp := RegisterImplies.for_get_priv_key stxs.rm coin.esn.addralice (
      by rw [h_public_keys]; apply crypto.zero_not_public_key ⟨inp.kalice, kalice_priv⟩)

    simp only [←SuccessfulTransactions.events.flatten_eq] at register_imp
    refine ⟨?_, ?_, ?_⟩
    · exact register_imp.h_kalice
    · rw [register_imp.public_key]
    · rw [h_addralice]

      have h_kalice : kalice = inp.kalice := by
        apply crypto.priv_to_pub_inj register_imp.h_kalice kalice_priv
        rw [←h_public_keys, register_imp.public_key]
      rw [h_kalice]

      have := note_imp.scan_outgoing
      simp only at this
      convert this
      apply ExScannedNote.ext
      · simp [h_inp₀]
      · simp only [h_addralice]
      · simp [*]
  h_coin_props_bob := by
    intro coin kbob

    have ⟨kalice, Kbob, h_c⟩ := coin.h_c

    have ⟨inp, note_imp, h_note_id⟩ := NoteImplies.from_coin coin
    have h_inp₀ := CreateNoteInput.to_scanned_note_eq h_note_id
    have h_inp₁ := ScannedNote.ext_iff.1 h_inp₀
    simp only [h_c] at h_inp₁
    have h_inp₂ := crypto.h_hash h_inp₁.1
    injections

    have h_addrbob : coin.esn.addrbob = inp.addrbob := by simp [*]

    have h_public_keys: stxs.rm.m MemoryType.PublicKeys [coin.esn.addrbob] = crypto.priv_to_pub note_imp.subchannel.channel.kbob := by
      rw [h_addrbob]

      have := note_imp.subchannel.channel.bob_registered.public_key
      simp only at this
      exact this

    have register_imp := RegisterImplies.for_get_priv_key stxs.rm coin.esn.addrbob (
      by rw [h_public_keys]; apply crypto.zero_not_public_key)

    simp only [←SuccessfulTransactions.events.flatten_eq] at register_imp
    refine ⟨?_, ?_, ?_⟩
    · exact register_imp.h_kalice
    · rw [register_imp.public_key]
    · rw [h_addrbob]
      intro h

      have h_kbob : ⟨kbob, h⟩ = note_imp.subchannel.channel.kbob := by
        apply Subtype.coe_inj.1
        apply crypto.priv_to_pub_inj h (by simp)
        rw [←h_public_keys, register_imp.public_key]
      rw [h_kbob]

      have := note_imp.scan_for_recipient
      simp only at this
      simp [h_inp₀] at this
      convert this
      simp [*]
  h_scan_outgoing_notes_for_sender := by
    intro addralice kalice esn h
    have ⟨inp, note_imp, h_esn, h_addralice, h_kalice⟩ := NoteImplies.from_scan_outgoing_notes_for_sender h
    rw [←h_esn]
    refine ⟨by rw [←h_addralice], inp.Kbob, ?_⟩
    simp only [note_imp.subchannel.h_c, ChannelImplies.c, OpenChannelInput.c, ←h_kalice]
  h_scan_notes_for_recipient := by
    intro bob esn h
    have ⟨inp, note_imp, h_esn, h_addrbob, _, _, _⟩ := NoteImplies.from_scan_notes_for_recipient bob.h_k h
    rw [←h_esn]
    refine ⟨by simp [*], inp.kalice, ?_⟩
    simp only [note_imp.subchannel.h_c, ChannelImplies.c, OpenChannelInput.c, note_imp.h_kalice]
    simp [*]
  h_fintype_coin := ⟨Coin.fintype⟩
  h_from_create_open_note_event := by
    intro note_id user_enc h
    simp only [SuccessfulTransactions.events.flatten_eq] at h
    have ⟨inp, note_imp, h_note_id, h_r, h_user_enc⟩ := NoteImplies.from_open_note_event h
    have h_addrbob : (crypto.dec (↑crypto.council_priv_key) user_enc).headD 0 = inp.addrbob:= by
      rw [h_user_enc, crypto.h_council_priv_key, crypto.dec_enc, List.headD]

    let register_imp₀ := note_imp.subchannel.channel.bob_registered
    have register_imp₁ := RegisterImplies.for_get_priv_key stxs.rm inp.addrbob (by
      simp [register_imp₀.public_key]
      exact crypto.zero_not_public_key ⟨_, register_imp₀.h_kalice⟩
    )
    have := register_imp₁.public_key ▸ register_imp₀.public_key
    apply crypto.priv_to_pub_inj register_imp₁.h_kalice register_imp₀.h_kalice at this
    simp only at this

    simp only [←SuccessfulTransactions.events.flatten_eq] at this
    refine ⟨?_, ?_, ?_⟩
    · have := h_note_id ▸ h_r ▸ note_imp.h_r
      rw [is_open_note, decide_eq_true_eq, this]
    · rw [h_addrbob, this]
      simp
    · rw [h_addrbob, this]
      exact register_imp₀.public_key
}
