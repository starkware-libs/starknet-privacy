import privacy.actions
import privacy.notes.canceled_notes
import privacy.notes.create_note_actions
import privacy.notes.discoverable
import privacy.notes.note_owner
import privacy.notes.open_deposits
import privacy.transactions.immutability
import privacy.utils

structure UserPrivKey (crypto: Crypto) (m: Memory) where
  addr: ℕ
  k: crypto.PrivateKeys
  h_k: m MemoryType.PublicKeys [addr] = crypto.priv_to_pub k

abbrev UserPrivKey.extend
    {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (bob: UserPrivKey crypto rm)
    (h_extends: rm'.extends rm) :
    UserPrivKey crypto rm' :=
  {
    addr := bob.addr,
    k := bob.k,
    h_k := by
      rw [←bob.h_k]
      apply immutability h_extends _ (by simp)
      rw [bob.h_k]
      apply crypto.zero_not_public_key
  }

theorem filtered_scan_notes_eq_notes_from_actions
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (bob: UserPrivKey crypto rm.m)
    (token: ℕ):
    (
      scan_notes_for_recipient₀ (.from rm) bob.addr bob.k
      |>.filter (λ sn ↦ sn.token = token)
      |>.toFinset
    ) = (
      create_note_actions crypto rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = bob.addr)
      |>.map (λ inp ↦ inp.to_scanned_note crypto)
      |>.toFinset
    ) := by
  ext sn
  conv =>
    congr
    · rw [List.mem_toFinset, List.mem_filter, decide_eq_true_eq]
    · simp only [List.mem_toFinset, List.mem_filter, List.mem_map, decide_eq_true_eq]
  constructor
  · intro ⟨h₀, h_token⟩
    have ⟨inp, note_imp, h_sn, h_addrbob, h_kbob⟩ := NoteImplies.from_scan_notes_for_recipient₀ bob.h_k h₀
    rw [←h_sn] at h_token
    use inp, ⟨note_imp.in_create_note_actions, by omega, h_addrbob⟩, h_sn
  · intro h
    obtain ⟨inp, ⟨h₀₀, h₀₁, h₀₂⟩, h₁⟩ := h
    have ⟨note_imp⟩ := NoteImplies.from_create_note_actions h₀₀

    have : note_imp.subchannel.channel.kbob = bob.k := by
      apply Subtype.coe_inj.1
      apply crypto.priv_to_pub_inj (by simp) (by simp)
      rw [←note_imp.subchannel.channel.bob_registered.public_key, ←bob.h_k, ←h₀₂]

    have h_scan := note_imp.scan_for_recipient₀
    simp only [*] at h_scan
    refine ⟨h_scan, by rw [←h₁]; omega⟩

-- Non-zero note amount stays non-zero.
theorem note_amount_nz_immutable
    {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm)
    (sn: ScannedNote)
    (h_nonzero: sn.amount crypto rm ≠ 0) :
    sn.amount crypto rm' ≠ 0 := by
  revert rm'
  apply invariant_induction_for_extends rm

  case inv₀ => trivial

  intro action rm' h_extends h success

  cases action

  case CreateNote inp' =>
    let info := create_note_info crypto inp' rm' success

    by_cases h_note_id: sn.note_id crypto = inp'.note_id crypto
    case pos =>
      simp [note_amount, h_note_id, info.old_value_was_zero, crypto.unpack_zero] at h
    case neg =>
      simp only [note_amount, ReachableMemory.add_m, run_action, ←info.h_m']
      rw [info.no_change _ _ (by simp [h_note_id]) (by simp)]
      exact h

  case OpenDeposit inp' =>
    let info := open_deposit_info crypto inp' rm' success

    by_cases h_note_id: sn.note_id crypto = inp'.note_id
    case pos =>
      have := info.old_value
      simp [note_amount, h_note_id, this, crypto.unpack_pack] at h
    case neg =>
      simp only [note_amount, ReachableMemory.add_m, run_action, ←info.h_m']
      rw [info.no_change _ _ (by simp [h_note_id])]
      exact h

  all_goals try trivial

-- note_amount = initial amount + deposits.
-- Note that in practice at most one deposit is possible.
theorem note_amount_eq_amount
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (h: inp ∈ create_note_actions crypto rm) :
    rm.m .Notes [inp.note_id crypto, 0] ≠ 0 ∧
    (inp.to_scanned_note crypto).amount crypto rm =
      inp.amount + sum_deposits_for_note_id crypto rm (inp.note_id crypto) := by
  revert rm
  apply ReachableMemory.induction

  case inv₀ => intro h; trivial
  intro action rm ih success h₀

  cases action
  case CreateNote inp' =>
    rw [create_note_actions_add] at h₀
    cases h₀
    case head =>
      let info := create_note_info crypto inp rm success
      have note_didnt_exist : ¬note_exists rm.m (inp.note_id crypto) := by
        simp [note_exists, info.old_value_was_zero]
      unfold CreateNoteInput.to_scanned_note ScannedNote.amount note_amount
      dsimp only
      refine ⟨?_, ?_⟩
      · rw [ReachableMemory.add_m, run_action, ←info.h_m']
        simp [CreateNoteInput.note_id, CreateNoteInput.c, info.memory_diff₀]
        exact crypto.pack_nz info.r_ne_zero
      · conv => lhs; rw [ReachableMemory.add_m, run_action, ←info.h_m']
        rw [CreateNoteInput.note_id, CreateNoteInput.c, info.memory_diff₀]
        rw [crypto.unpack_pack]
        simp only [add_tsub_cancel_left, Nat.left_eq_add]
        apply Eq.trans (by
          show _ = sum_deposits_for_note_id crypto rm (inp.note_id crypto)
          simp [sum_deposits_for_note_id, open_deposit_actions]
        )

        rw [sum_deposits_for_note_id_eq_zero note_didnt_exist]

    case tail h₀ =>
      have ⟨h₀, h₁⟩ := ih h₀
      let info := create_note_info crypto inp' rm success
      rw [CreateNoteInput.to_scanned_note, ScannedNote.amount, note_amount,
        ReachableMemory.add_m, run_action, ←info.h_m']
      have h_note_id : inp.note_id crypto ≠ inp'.note_id crypto :=
          λ h' ↦ h₀ (h' ▸ info.old_value_was_zero)

      refine ⟨?_, ?_⟩
      · rw [info.no_change _ _ (by simp [h_note_id]) (by simp)]
        exact h₀
      · rw [info.no_change _ _ (by simp [h_note_id]) (by simp)]
        exact h₁

  case OpenDeposit inp' =>
    let info := open_deposit_info crypto inp' rm success
    rw [create_note_actions_add' _ (by trivial)] at h₀
    have ⟨h₀, h₁⟩ := ih h₀

    use note_exists_monotone _ h₀

    rw [sum_deposits_for_note_id_next success]
    rw [CreateNoteInput.to_scanned_note, ScannedNote.amount, note_amount,
      ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h_note_id: inp.note_id crypto = inp'.note_id
    case pos =>
      simp only [ScannedNote.amount, ScannedNote.note_id] at h₁
      simp only [h_note_id, ↓reduceIte] at h₁ ⊢

      rw [info.memory_diff₀]
      rw [note_amount, info.old_value] at h₁
      rw [crypto.unpack_pack] at h₁ ⊢
      simp only [↓reduceIte, tsub_zero] at h₁ ⊢
      rw [←add_assoc, ←h₁]
      simp
    case neg =>
      rw [info.no_change _ _ (by simp [h_note_id])]
      simp [Ne.symm h_note_id]
      exact h₁

  repeat exact ih h₀

theorem create_note_actions_note_id_nodup (crypto: Crypto) (note_id: ℕ) :
    ∀ rm, (create_note_actions crypto rm |>.map (λ inp ↦ inp.note_id crypto) |>.count note_id) ≤ 1 := by
  apply ReachableMemory.induction

  case inv₀ => show List.count _ [] ≤ 1; simp

  intro action rm ih success
  cases action
  case CreateNote inp =>
    let info := create_note_info crypto inp rm success
    rw [create_note_actions_add]
    by_cases h_note_id: inp.note_id crypto = note_id
    case pos =>
      simp only [List.map_cons, List.count_cons, h_note_id, reduceIte,
        add_le_iff_nonpos_left, nonpos_iff_eq_zero, List.count_eq_zero, BEq.rfl]
      simp only [List.mem_map]
      by_contra h₀
      obtain ⟨inp', h₀⟩ := h₀
      have ⟨note_imp⟩ := NoteImplies.from_create_note_actions h₀.1
      exact note_imp.h_note_exists (h₀.2 ▸ h_note_id ▸ info.old_value_was_zero)
    case neg =>
      simpa only [List.map_cons, ne_eq, h_note_id, not_false_eq_true, List.count_cons_of_ne,
        ge_iff_le];
  repeat exact ih

abbrev sum_create_note_amounts (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (token: ℕ) : ℕ :=
  create_note_actions crypto rm
  |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob)
  |>.map (λ inp ↦ inp.amount)
  |>.sum

theorem create_note_actions_not_registered
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} (token: ℕ)
    (h: rm.m .PublicKeys [addrbob] = 0) :
    (
      create_note_actions crypto rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob)
    ) = [] := by
  simp only [Bool.decide_and, List.filter_eq_nil_iff, Bool.and_eq_true, decide_eq_true_eq, not_and]
  intro inp h_inp h_token h_addrbob
  have := (NoteImplies.from_create_note_actions h_inp |>.some).subchannel.channel.bob_registered.public_key
  conv at this => lhs; simp only [h_addrbob, h]
  exact crypto.zero_not_public_key _ this.symm

theorem sum_create_note_amounts_zero
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} (token: ℕ)
    (h: rm.m .PublicKeys [addrbob] = 0) :
    sum_create_note_amounts crypto rm addrbob token = 0 := by
  rw [sum_create_note_amounts, create_note_actions_not_registered token h]
  simp

abbrev sum_deposits_for_create_note_amounts (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (token: ℕ) : ℕ :=
  create_note_actions crypto rm
  |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob)
  |>.map (λ inp ↦ sum_deposits_for_note_id crypto rm (inp.note_id crypto))
  |>.sum

theorem sum_of_created_notes_to_scanned_notes₀
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (bob: UserPrivKey crypto rm.m)
    (token: ℕ) :
    sum_create_note_amounts crypto rm bob.addr token +
    sum_deposits_for_create_note_amounts crypto rm bob.addr token =
    (
      scan_notes_for_recipient₀ (.from rm) bob.addr bob.k
      |>.filter (λ sn ↦ sn.token = token)
      |>.map (λ sn ↦ sn.amount crypto rm)
      |>.sum
    ) := by
  rw [←List.sum_toFinset _ (by
    apply List.Nodup.filter
    apply scan_notes_for_recipient₀.nodup bob.h_k
  )]
  rw [filtered_scan_notes_eq_notes_from_actions bob]

  rw [List.sum_toFinset _ (by
    apply filter_map_nodup
    apply List.Nodup.of_map (λ x ↦ x.note_id crypto)
    rw [List.map_map]
    have : ((λ x ↦ x.note_id crypto) ∘ λ inp ↦ inp.to_scanned_note crypto) =
        (λ inp ↦ CreateNoteInput.note_id crypto inp) := by
      ext x; simp
    rw [this]
    apply List.nodup_iff_count_le_one.2
    intro x
    apply create_note_actions_note_id_nodup
  )]

  unfold sum_create_note_amounts sum_deposits_for_create_note_amounts
  rw [←List.sum_map_add]
  apply congrArg
  simp only [Bool.decide_and, List.map_map, List.map_inj_left, List.mem_filter, Bool.and_eq_true,
    decide_eq_true_eq, Function.comp_apply, and_imp]
  intro inp h₀ h₁ h₂
  simp [(note_amount_eq_amount h₀).2]

-------------------------------

noncomputable def sum_deposit_amounts
    (crypto: Crypto) (rm: ReachableMemory crypto)
    (addrbob: ℕ) (token: ℕ) : ℕ :=
  open_deposit_actions crypto rm
  |>.filter (λ inp ↦ inp.token = token ∧ (note_owner crypto inp.note_id addrbob = true))
  |>.map (λ inp ↦ inp.amount)
  |>.sum

theorem sum_deposit_amounts_eq
    (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (token: ℕ) :
    sum_deposit_amounts crypto rm addrbob token =
    sum_deposits_for_create_note_amounts crypto rm addrbob token := by
  rw [sum_deposit_amounts]
  rw [fiber_sum (f:=OpenDepositInput.note_id)
    (img:=create_note_actions crypto rm |>.map (λ inp ↦ inp.note_id crypto))
    (h_img:=by
      intro a h_a
      rw [List.mem_filter] at h_a
      rw [List.mem_map]
      have ⟨open_deposit_imp⟩ := OpenDepositImplies.from_open_deposit_actions h_a.1
      exact ⟨
        open_deposit_imp.inp_create,
        open_deposit_imp.created.in_create_note_actions,
        open_deposit_imp.h_note_id
      ⟩
    )
    (h_nodup:=by
      apply List.nodup_iff_count_le_one.2
      intro note_id
      apply create_note_actions_note_id_nodup
    )
  ]

  set ℓ := create_note_actions crypto rm
  set f_note_id := λ inp: CreateNoteInput ↦ inp.note_id crypto
  set f_token_bob := λ inp: CreateNoteInput ↦ inp.token = token ∧ inp.addrbob = addrbob
  show  (ℓ |>.map f_note_id |>.map _ |>.sum) = (ℓ |>.filter f_token_bob |>.map _ |>.sum)

  rw [List.map_map]
  rw [←List.sum_map_filter_add_sum_map_filter_not (p:=f_token_bob)]
  have : ∀ x y z, x = z → y = 0 → x + y = z := by intro x y; simp
  apply this

  · apply congrArg
    apply List.map_congr_left
    intro inp h_inp
    rw [List.mem_filter, decide_eq_true_eq] at h_inp
    simp only [eq_iff_iff, iff_true, Bool.decide_and, List.filter_filter, Function.comp_apply]

    rw [sum_deposits_for_note_id]
    apply congrArg
    apply congrArg
    apply List.filter_congr
    intro inp_deposit h_inp_deposit
    have ⟨open_deposit_imp⟩ := OpenDepositImplies.from_open_deposit_actions h_inp_deposit
    rw [←Bool.decide_and, ←Bool.decide_and, decide_eq_decide]
    constructor
    · intro h
      exact h.1
    · intro h
      refine ⟨h, ?_, ?_⟩
      · rw [open_deposit_imp.token_eq_sn (sn:=inp.to_scanned_note crypto) (by rw [h])]
        exact h_inp.2.1
      · simp only [eq_iff_iff, iff_true]
        use inp.to_scanned_note crypto, inp.addralice, inp.kalice, inp.Kbob
        constructor
        · rw [h]
        · rw [←h_inp.2.2]

  · apply List.sum_eq_zero
    intro amount h_amount
    obtain ⟨inp, h_inp, h⟩ := List.mem_map.1 h_amount
    rw [List.mem_filter, decide_eq_true_eq] at h_inp
    rw [Function.comp_apply] at h
    rw [←h]

    apply List.sum_eq_zero
    intro amount' h_amount'
    obtain ⟨inp_deposit, h_inp_deposit, _⟩ := List.mem_map.1 h_amount'
    rw [List.mem_filter, List.mem_filter, decide_eq_true_eq, decide_eq_true_eq, eq_iff_iff] at h_inp_deposit
    simp only [iff_true] at h_inp_deposit
    replace ⟨⟨h_inp_deposit, h_token, h_note_owner⟩, h_note_id⟩ := h_inp_deposit

    simp only [h_note_id, f_note_id] at h_note_owner
    have ⟨note_imp⟩ := NoteImplies.from_create_note_actions h_inp.1
    have h_note_owner' := note_owner_of_create_note crypto inp
    have h_addrbob_kbob := unique_note_owner h_note_owner h_note_owner'
    have ⟨open_deposit_imp⟩ := OpenDepositImplies.from_open_deposit_actions h_inp_deposit

    have h_inp_token : inp.token = token := by
      have := open_deposit_imp.token_eq_sn (sn:=inp.to_scanned_note crypto) (by rw [h_note_id])
      rw [←h_token]
      exact Eq.symm this

    have := h_inp.2
    unfold f_token_bob at this
    simp [h_addrbob_kbob, h_inp_token] at this

theorem sum_deposit_amounts_zero
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} (token: ℕ)
    (h: rm.m .PublicKeys [addrbob] = 0) :
    sum_deposit_amounts crypto rm addrbob token = 0 := by
  rw [sum_deposit_amounts_eq, sum_deposits_for_create_note_amounts]
  rw [create_note_actions_not_registered token h]
  simp

theorem sum_of_created_notes_to_scanned_notes
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (bob: UserPrivKey crypto rm.m)
    (token: ℕ) :
    sum_create_note_amounts crypto rm bob.addr token +
    sum_deposit_amounts crypto rm bob.addr token =
    (
      scan_notes_for_recipient₀ (.from rm) bob.addr bob.k
      |>.filter (λ sn ↦ sn.token = token)
      |>.map (λ sn ↦ sn.amount crypto rm)
      |>.sum
    ) := by
  rw [sum_deposit_amounts_eq, sum_of_created_notes_to_scanned_notes₀ bob]

-------------------------------

def spent_notes_from_scan
  {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
  (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) : Finset ScannedNote :=
  scan_notes_for_recipient₀ context addrbob kbob
  |>.filter (λ sn ↦ sn.token = token)
  |>.filter (λ sn ↦ m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁, kbob]] ≠ 0)
  |>.toFinset

theorem spent_notes_from_scan' {crypto: Crypto} {rm: ReachableMemory crypto}
    (bob: UserPrivKey crypto rm.m)
    (token: ℕ) :
    spent_notes_from_scan (.from rm) bob.addr bob.k token =
    (
       cancel_note_actions crypto rm
       |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = bob.addr)
       |>.map (λ inp ↦ inp.to_scanned_note)
       |>.toFinset
    ) := by
  rw [spent_notes_from_scan, List.toFinset_filter, filtered_scan_notes_eq_notes_from_actions bob]

  ext sn
  simp only [Bool.decide_and, Finset.mem_filter, List.mem_toFinset,
    List.mem_map, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq]
  constructor
  · intro h
    obtain ⟨⟨inp_create, ⟨h₀₀, h₀₁, h₀₂⟩, h₁⟩, h_canceled⟩ := h

    have ⟨addrbob', amount, ⟨cancel_imp⟩⟩ := CancelImplies.from_note_canceled h_canceled
    refine ⟨_, ⟨cancel_imp.in_cancel_note_actions, h₁ ▸ h₀₁, ?_⟩, by rfl⟩
    dsimp only

    have : cancel_imp.note_created.subchannel.channel.c = inp_create.c crypto := by
      rw [←cancel_imp.note_created.subchannel.h_c, cancel_imp.h_c, ←h₁]
    have ⟨_, _, h_addrbob, h_kbob⟩ := cancel_imp.note_created.subchannel.channel.same_c this
    simp only at h_addrbob h_kbob
    rw [←h_addrbob, h₀₂]
  · intro ⟨inp_cancel, ⟨h₀₀, h₀₁, h₀₂⟩, h₁⟩
    have ⟨cancel_imp⟩ := CancelImplies.from_cancel_note_actions h₀₀

    refine ⟨⟨cancel_imp.inp_create, ⟨⟨cancel_imp.note_created.in_create_note_actions, ?_⟩, ?_⟩⟩, ?_⟩
    · simp only [*, true_and]
    · rw [←h₁]
      ext
      · exact cancel_imp.h_c
      all_goals simp
    · have h_kbob' : inp_cancel.kbob = bob.k := by
        apply crypto.priv_to_pub_inj cancel_imp.kbob_priv (by simp)
        rw [←bob.h_k, ←cancel_imp.h_kbob₁, h₀₂]
      have := cancel_imp.h_note_canceled
      rw [←h₁, ←h_kbob']
      simp only [note_canceled, *] at this ⊢
      exact this

theorem cancel_note_actions_note_id_nodup
    {crypto: Crypto} (rm: ReachableMemory crypto) (note_id: ℕ) :
    (cancel_note_actions crypto rm |>.map (λ inp ↦ inp.note_id crypto) |>.count note_id) ≤ 1 := by
  revert rm
  apply ReachableMemory.induction

  case inv₀ => show List.count _ [] ≤ 1; simp

  intro action rm ih success
  cases action
  case CancelNote inp =>
    let info := cancel_note_info crypto inp rm success
    rw [cancel_note_actions_add]
    by_cases h_note_id: inp.note_id crypto = note_id
    case pos =>
      simp only [List.map_cons, List.count_cons, h_note_id, reduceIte,
        add_le_iff_nonpos_left, nonpos_iff_eq_zero, List.count_eq_zero, BEq.rfl, List.mem_map]
      by_contra h₀
      obtain ⟨inp', h₀⟩ := h₀

      have cancel_imp: CancelImplies (rm.add (.CancelNote inp) success) inp :=
        (CancelImplies.from_action (by simp) |>.some)
      have ⟨cancel_imp'⟩ := CancelImplies.from_cancel_note_actions h₀.1

      have h_nullifiers : inp'.nullifier crypto = inp.nullifier crypto := by
        have h_note_id : inp'.note_id crypto = inp.note_id crypto := by simp [*]
        apply crypto.h_hash at h_note_id
        repeat injection h_note_id with _ h_note_id

        have h_same_c : inp'.c = inp.c := by assumption

        have := cancel_imp.h_c
        rw [←h_same_c, ←cancel_imp'.h_c, cancel_imp.note_created.subchannel.h_c] at this
        have := crypto.priv_to_pub_inj
          cancel_imp'.kbob_priv
          cancel_imp.kbob_priv
          (cancel_imp.note_created.subchannel.channel.same_c this).2.2.2

        unfold CancelNoteInput.nullifier
        simp [*]

      have := h_nullifiers ▸ info.nullifier_didnt_exist
      exact cancel_imp'.h_note_canceled this
    case neg =>
      simpa only [List.map_cons, ne_eq, h_note_id, not_false_eq_true, List.count_cons_of_ne,
        ge_iff_le]
  all_goals exact ih

theorem CancelImplies.amount_eq
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (cancel_imp: CancelImplies rm inp) :
    inp.to_scanned_note.amount crypto rm = inp.amount := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; have := h.h_action; contradiction

  intro action rm ih success cancel_imp

  cases cancel_imp.h_action
  case head =>
    let info := cancel_note_info crypto inp rm success
    rw [CancelNoteInput.to_scanned_note, ScannedNote.amount, note_amount,
      ReachableMemory.add_m, run_action, ←info.h_m']
    rw [info.no_change _ _ (by simp)]
    rw [←note_amount, info.h_amount]
  case tail h =>
    have ⟨cancel_imp₀⟩ := CancelImplies.from_action h
    have ih := ih cancel_imp₀
    cases action
    case CreateNote inp' =>
      let info := create_note_info crypto inp' rm success
      have : inp.note_id crypto ≠ inp'.note_id crypto :=
        λ h' ↦ (h' ▸ cancel_imp₀.h_note_exists) info.old_value_was_zero
      rw [CancelNoteInput.to_scanned_note, ScannedNote.amount, note_amount,
        ReachableMemory.add_m, run_action, ←info.h_m']
      rw [info.no_change _ _ (by simp [this]) (by simp)]
      exact ih
    case OpenDeposit inp' =>
      let info := open_deposit_info crypto inp' rm success
      have : inp.note_id crypto ≠ inp'.note_id := by
        by_contra h'
        have note_amount_zero : inp.to_scanned_note.amount crypto rm = 0 := by
          simp [note_amount, h' ▸ info.old_value, crypto.unpack_pack]
        exact cancel_imp₀.amount_nz (ih ▸ note_amount_zero)
      rw [CancelNoteInput.to_scanned_note, ScannedNote.amount, note_amount,
        ReachableMemory.add_m, run_action, ←info.h_m']
      rw [info.no_change _ _ (by simp [this])]
      exact ih

    all_goals try exact ih

abbrev sum_cancel_note_amounts (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob token: ℕ) : ℕ :=
  cancel_note_actions crypto rm
  |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob)
  |>.map (λ inp ↦ inp.amount)
  |>.sum

theorem sum_cancel_note_amounts_zero
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} (token: ℕ)
    (h: rm.m .PublicKeys [addrbob] = 0) :
    sum_cancel_note_amounts crypto rm addrbob token = 0 := by
  convert List.sum_nil
  convert List.map_nil
  simp only [Bool.decide_and, List.filter_eq_nil_iff, Bool.and_eq_true, decide_eq_true_eq, not_and]
  intro inp h_inp h_token h_addrbob
  have := (CancelImplies.from_cancel_note_actions h_inp |>.some).note_created.subchannel.channel.bob_registered.public_key
  conv at this => lhs; simp only [h_addrbob, h]
  exact crypto.zero_not_public_key _ this.symm

def spent_notes
  {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
  (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) : List ScannedNote :=
  (
    scan_notes_for_recipient₀ context addrbob kbob
    |>.filter (λ sn ↦ sn.token = token)
    |>.filter (λ sn ↦ m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁, kbob]] ≠ 0)
  )

def spent_notes_ex
  {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
  (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) : List ExScannedNote :=
  (
    scan_notes_for_recipient context addrbob kbob
    |>.filter (λ sn ↦ sn.token = token)
    |>.filter (λ sn ↦ m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁, kbob]] ≠ 0)
  )

theorem spent_notes_ex_eq_spent_notes
  {crypto: Crypto} {m: Memory} (context: ScanNoteContext crypto m)
  (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) :
  (spent_notes_ex context addrbob kbob token).map (λ sn ↦ ↑sn) =
  spent_notes context addrbob kbob token := by
  rw [spent_notes_ex, spent_notes, scan_notes_for_recipient₀]
  simp only [List.filter_map]
  apply congrArg
  simp only [List.filter_filter]
  apply List.filter_congr
  intro esn h_esn
  rfl

theorem sum_of_canceled_notes_to_scanned_notes
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (bob: UserPrivKey crypto rm.m)
    (token: ℕ) :
    sum_cancel_note_amounts crypto rm bob.addr token =
    (
      spent_notes (.from rm) bob.addr bob.k token
      |>.map (λ sn ↦ sn.amount crypto rm)
      |>.sum
    ) := by
  rw [←List.sum_toFinset _ (by
    apply List.Nodup.filter
    apply List.Nodup.filter
    apply scan_notes_for_recipient₀.nodup bob.h_k
  )]

  rw [spent_notes, ←spent_notes_from_scan, spent_notes_from_scan' bob]

  rw [List.sum_toFinset _ (by
    apply filter_map_nodup
    apply List.Nodup.of_map (λ x ↦ x.note_id crypto)
    rw [List.map_map]
    have : ((λ x ↦ x.note_id crypto) ∘ λ inp ↦ inp.to_scanned_note) =
        (λ inp ↦ CancelNoteInput.note_id crypto inp) := by
      ext x; simp
    rw [this]
    apply List.nodup_iff_count_le_one.2
    intro x
    apply cancel_note_actions_note_id_nodup
  )]

  unfold sum_cancel_note_amounts

  apply congrArg
  simp only [Bool.decide_and, List.map_map, List.map_inj_left, List.mem_filter, Bool.and_eq_true,
    decide_eq_true_eq, Function.comp_apply, and_imp]

  intro inp h₀ h₁ h₂
  simp [(CancelImplies.from_cancel_note_actions h₀ |>.some).amount_eq]

-- For any recipient `addrbob` and token `token`:
--   created notes + deposited notes = canceled notes + unspent notes.
theorem sum_create_note_cancel_note
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (bob: UserPrivKey crypto rm.m)
    (token: ℕ) :
    sum_create_note_amounts crypto rm bob.addr token +
    sum_deposit_amounts crypto rm bob.addr token =
    sum_cancel_note_amounts crypto rm bob.addr token +
    (
      scan_notes_for_recipient₀ (.from rm) bob.addr bob.k
      |>.filter (λ sn ↦ sn.token = token)
      |>.filter (λ sn ↦ rm.m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁, bob.k]] = 0)
      |>.map (λ sn ↦ sn.amount crypto rm)
      |>.sum
    ) := by
  -- Define abbreviations for readability
  set ℓ := scan_notes_for_recipient₀ (.from rm) bob.addr bob.k
  set f_token := λ sn: ScannedNote ↦ sn.token = token
  set amount := λ sn: ScannedNote ↦ sn.amount crypto rm
  let f_spent := λ sn: ScannedNote ↦ (rm.m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁, bob.k]] ≠ 0)
  let f_unspent := λ sn: ScannedNote ↦ (rm.m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁, bob.k]] = 0)

  have neg_f_spent : (λ sn ↦ decide ¬f_spent sn) = (λ sn ↦ decide (f_unspent sn)) := by
    ext x; classical simp [f_spent, f_unspent]

  calc sum_create_note_amounts crypto rm bob.addr token +
       sum_deposit_amounts crypto rm bob.addr token
    _ = (ℓ |>.filter f_token |>.map amount |>.sum) :=
        sum_of_created_notes_to_scanned_notes bob token
    -- Split sum into spent + unspent.
    _ = (ℓ |>.filter f_token |>.filter f_spent |>.map amount |>.sum) +
        (ℓ |>.filter f_token |>.filter (¬f_spent ·) |>.map amount |>.sum) := by
        rw [←List.sum_map_filter_add_sum_map_filter_not f_spent]
    _ = sum_cancel_note_amounts crypto rm bob.addr token +
        (ℓ |>.filter f_token |>.filter (¬f_spent ·) |>.map amount |>.sum) := by
        rw [sum_of_canceled_notes_to_scanned_notes bob, spent_notes]
    _ = _ := by rw [neg_f_spent]

-- Can't spend more than created + deposited.
theorem sum_cancel_note_le_sum_create_note
    {crypto: Crypto} (rm: ReachableMemory crypto) (addrbob: ℕ) (token: ℕ) :
    sum_cancel_note_amounts crypto rm addrbob token ≤
    sum_create_note_amounts crypto rm addrbob token +
    sum_deposit_amounts crypto rm addrbob token := by
  by_cases h: rm.m .PublicKeys [addrbob] = 0
  case pos =>
    rw [sum_create_note_amounts_zero token h, sum_deposit_amounts_zero token h,
      sum_cancel_note_amounts_zero token h]
  case neg =>
    have ⟨kbob, h_kbob⟩ := public_keys h
    simp [sum_create_note_cancel_note ⟨_, _, h_kbob⟩]
