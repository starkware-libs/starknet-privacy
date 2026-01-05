import privacy.actions
import privacy.notes.canceled_notes
import privacy.notes.open_deposits
import privacy.notes.create_note_actions
import privacy.notes.discoverable
import privacy.notes.note_owner
import privacy.utils

theorem filtered_scan_notes_eq_notes_from_actions
    (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) :
    (
      scan_notes_for_recipient crypto rm addrbob kbob
      |>.filter (λ sn ↦ sn.token = token)
      |>.toFinset
    ) = (
      create_note_actions crypto rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob ∧ inp.Kbob = crypto.priv_to_pub kbob)
      |>.map (λ inp ↦ inp.to_scanned_note crypto)
      |>.toFinset
    ) := by
  ext sn
  simp only [List.mem_toFinset, List.mem_map, List.mem_filter, Bool.decide_and, Bool.and_eq_true,
    decide_eq_true_eq]
  constructor
  · intro ⟨h₀, h_token⟩
    apply (create_note_actions_iff_note_discoverable addrbob kbob sn).1 at h₀
    obtain ⟨inp, h₀, h₁, h₂, h₃⟩ := h₀
    rw [←h₁] at h_token
    use inp, ⟨h₀, by omega, h₂, h₃⟩, h₁
  · intro h
    obtain ⟨inp, ⟨h₀₀, h₀₁, h₀₂, h₀₃⟩, h₁⟩ := h

    use (create_note_actions_iff_note_discoverable addrbob kbob sn).2
      ⟨inp, h₀₀, h₁, h₀₂, h₀₃⟩
    rwa [←h₁]

-- Non-zero note amount stays non-zero.
theorem note_amount_nz_immutable
    {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm)
    (sn: ScannedNote)
    (h_nonzero: note_amount crypto rm (sn.note_id crypto) sn.c ≠ 0) :
    note_amount crypto rm' (sn.note_id crypto) sn.c ≠ 0 := by
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
      simp only [note_amount, ReachableMemory.add, run_action, ←info.h_m']
      rw [info.no_change _ _ (by simp [h_note_id]) (by simp)]
      exact h

  case OpenDeposit inp' =>
    let info := open_deposit_info crypto inp' rm' success

    by_cases h_note_id: sn.note_id crypto = inp'.note_id
    case pos =>
      have := info.old_value
      simp [note_amount, h_note_id, this, crypto.unpack_pack] at h
    case neg =>
      simp only [note_amount, ReachableMemory.add, run_action, ←info.h_m']
      rw [info.no_change _ _ (by simp [h_note_id])]
      exact h

  all_goals try trivial

-- note_amount = initial amount + deposits.
-- Note that in practice at most one deposit is possible.
theorem note_amount_eq_amount
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (h: inp ∈ create_note_actions crypto rm) :
    rm.m .Notes [inp.note_id crypto, 0] ≠ 0 ∧
    note_amount crypto rm (inp.note_id crypto) (inp.c crypto) =
      inp.amount + sum_deposits_for_note_id crypto rm (inp.note_id crypto) := by
  revert rm
  apply ReachableMemory.induction

  case inv₀ => intro h; trivial
  intro action rm ih success h₀
  simp only [create_note_actions, ReachableMemory.add, List.flatMap_cons, List.mem_append,
    List.mem_flatMap] at h₀
  cases h₀
  case inl h₀ =>
    cases action
    case CreateNote inp' =>
      simp at h₀
      let info := create_note_info crypto inp' rm success
      have note_didnt_exist : ¬note_exists rm.m (inp'.note_id crypto) := by
        simp [note_exists, info.old_value_was_zero]
      unfold note_amount ReachableMemory.add run_action
      dsimp only
      refine ⟨?_, ?_⟩
      · rw [←info.h_m']
        simp [h₀, CreateNoteInput.note_id, CreateNoteInput.c, info.memory_diff₀]
        exact crypto.pack_nz info.r_ne_zero
      · conv => lhs; rw [←info.h_m']
        rw [h₀, CreateNoteInput.note_id, CreateNoteInput.c, info.memory_diff₀]
        rw [crypto.unpack_pack]
        simp only [add_tsub_cancel_left, Nat.left_eq_add]
        apply Eq.trans (by
          show _ = sum_deposits_for_note_id crypto rm (inp'.note_id crypto)
          simp [sum_deposits_for_note_id, open_deposit_actions]
        )

        rw [sum_deposits_for_note_id_eq_zero note_didnt_exist]

    repeat trivial
  case inr h₀ =>
    have ⟨h₀, h₁⟩ := ih (by simp [create_note_actions, h₀])
    cases action
    case CreateNote inp' =>
      let info := create_note_info crypto inp' rm success
      unfold note_amount ReachableMemory.add run_action
      dsimp only
      have h_note_id : inp.note_id crypto ≠ inp'.note_id crypto :=
          λ h' ↦ h₀ (h' ▸ info.old_value_was_zero)

      refine ⟨?_, ?_⟩
      · rw [←info.h_m', info.no_change _ _ (by simp [h_note_id]) (by simp)]
        exact h₀
      · conv => lhs; rw [←info.h_m']
        rw [info.no_change _ _ (by simp [h_note_id]) (by simp)]
        exact h₁

    case OpenDeposit inp' =>
      let info := open_deposit_info crypto inp' rm success
      use note_exists_monotone _ h₀

      rw [sum_deposits_for_note_id_next success]

      dsimp only [note_amount, ReachableMemory.add, run_action] at h₁ ⊢

      by_cases h_note_id: inp.note_id crypto = inp'.note_id
      case pos =>
        simp only [h_note_id, ↓reduceIte] at h₁ ⊢
        conv => lhs; rw [←info.h_m']
        rw [info.memory_diff₀]
        rw [info.old_value] at h₁
        rw [crypto.unpack_pack] at h₁ ⊢
        simp only [↓reduceIte, tsub_zero] at h₁ ⊢
        rw [←add_assoc, ←h₁]
        simp
      case neg =>
        conv => lhs; rw [←info.h_m']
        rw [info.no_change _ _ (by simp [h_note_id])]
        simp [Ne.symm h_note_id]
        exact h₁

    repeat trivial

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
      have := (create_note_actions_iff_note_exists).2 ⟨inp', h₀⟩
      unfold note_exists at this
      rw [←h_note_id, CreateNoteInput.note_id, CreateNoteInput.c] at this
      have := info.old_value_was_zero
      contradiction
    case neg =>
      simpa only [List.map_cons, ne_eq, h_note_id, not_false_eq_true, List.count_cons_of_ne,
        ge_iff_le];
  repeat exact ih

abbrev sum_create_note_amounts (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) : ℕ :=
  create_note_actions crypto rm
  |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob ∧ inp.Kbob = crypto.priv_to_pub kbob)
  |>.map (λ inp ↦ inp.amount)
  |>.sum

abbrev sum_deposits_for_create_note_amounts (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) : ℕ :=
  create_note_actions crypto rm
  |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob ∧ inp.Kbob = crypto.priv_to_pub kbob)
  |>.map (λ inp ↦ sum_deposits_for_note_id crypto rm (inp.note_id crypto))
  |>.sum

theorem sum_of_created_notes_to_scanned_notes₀
    (crypto: Crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) (rm: ReachableMemory crypto) :
    sum_create_note_amounts crypto rm addrbob kbob token +
    sum_deposits_for_create_note_amounts crypto rm addrbob kbob token =
    (
      scan_notes_for_recipient crypto rm addrbob kbob
      |>.filter (λ sn ↦ sn.token = token)
      |>.dedup
      |>.map (λ sn ↦ note_amount crypto rm (sn.note_id crypto) sn.c)
      |>.sum
    ) := by

  have : ∀ ℓ: List ScannedNote, ℓ.dedup.toFinset = ℓ.toFinset := by
    intro ℓ; ext x; simp [List.mem_toFinset, List.mem_dedup]

  rw [←List.sum_toFinset _ (List.nodup_dedup _), this, filtered_scan_notes_eq_notes_from_actions]

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
  intro inp h₀ h₁ h₂ h₃
  simp [(note_amount_eq_amount h₀).2]

-------------------------------

noncomputable def sum_deposit_amounts
    (crypto: Crypto) (rm: ReachableMemory crypto)
    (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) : ℕ :=
  open_deposit_actions crypto rm
  |>.filter (λ inp ↦ inp.token = token ∧ (note_owner crypto inp.note_id addrbob kbob = true))
  |>.map (λ inp ↦ inp.amount)
  |>.sum

theorem sum_deposit_amounts_eq
    (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) :
    sum_deposit_amounts crypto rm addrbob kbob token =
    sum_deposits_for_create_note_amounts crypto rm addrbob kbob token := by
  rw [sum_deposit_amounts]
  rw [fiber_sum (f:=OpenDepositInput.note_id)
    (img:=create_note_actions crypto rm |>.map (λ inp ↦ inp.note_id crypto))
    (h_img:=by
      intro a h_a
      rw [List.mem_filter] at h_a
      rw [List.mem_map]
      have note_exists := deposit_action_implies h_a.1
      have ⟨inp_create, h_inp_create⟩ := create_note_actions_iff_note_exists.1 note_exists
      use inp_create
    )
    (h_nodup:=by
      apply List.nodup_iff_count_le_one.2
      intro note_id
      apply create_note_actions_note_id_nodup
    )
  ]

  set ℓ := create_note_actions crypto rm
  set f_note_id := λ inp: CreateNoteInput ↦ inp.note_id crypto
  set f_token_bob := λ inp: CreateNoteInput ↦ inp.token = token ∧ inp.addrbob = addrbob ∧ inp.Kbob = crypto.priv_to_pub ↑kbob
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
    rw [←Bool.decide_and, ←Bool.decide_and, decide_eq_decide]
    constructor
    · intro h
      exact h.1
    · intro h
      refine ⟨h, ?_, ?_⟩
      · rw [deposit_action_token h_inp_deposit (sn:=inp.to_scanned_note crypto) (by rw [h])]
        exact h_inp.2.1
      · simp only [eq_iff_iff, iff_true]
        use inp.to_scanned_note crypto, inp.addralice, inp.kalice
        constructor
        · rw [h]
        · rw [←h_inp.2.2.1, ←h_inp.2.2.2]

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
    have ⟨kbob', h_note_owner', h_kbob'⟩ := note_owner_of_create_note h_inp.1
    have h_addrbob_kbob := unique_note_owner h_note_owner h_note_owner'

    have h_inp_token : inp.token = token := by
      have := deposit_action_token h_inp_deposit (sn:=inp.to_scanned_note crypto) (by rw [h_note_id])
      rw [←h_token]
      exact Eq.symm this

    have := h_inp.2
    unfold f_token_bob at this
    simp [h_addrbob_kbob, h_inp_token, h_kbob'] at this

theorem sum_of_created_notes_to_scanned_notes
    (crypto: Crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) (rm: ReachableMemory crypto) :
    sum_create_note_amounts crypto rm addrbob kbob token +
    sum_deposit_amounts crypto rm addrbob kbob token =
    (
      scan_notes_for_recipient crypto rm addrbob kbob
      |>.filter (λ sn ↦ sn.token = token)
      |>.dedup
      |>.map (λ sn ↦ note_amount crypto rm (sn.note_id crypto) sn.c)
      |>.sum
    ) := by
  rw [sum_deposit_amounts_eq, sum_of_created_notes_to_scanned_notes₀]

-------------------------------

theorem create_cancel_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} (inp_create: CreateNoteInput) (inp_cancel: CancelNoteInput)
    (inp_cancel_action: inp_cancel ∈ cancel_note_actions crypto rm)
    (h_note_id: inp_create.note_id crypto = inp_cancel.note_id crypto) :
    inp_create.c crypto = inp_cancel.c ∧
    inp_create.token = inp_cancel.token ∧
    inp_create.addrbob = inp_cancel.addrbob ∧
    inp_create.Kbob = inp_cancel.Kbob crypto ∧
    inp_create.i₀ = inp_cancel.i₀ ∧
    inp_create.i₁ = inp_cancel.i₁ := by
  apply crypto.h_hash at h_note_id
  repeat injection h_note_id with _ h_note_id

  have h_inp_create_c : inp_create.c crypto = inp_cancel.c := by assumption
  have ⟨addralice, kalice, inp_cancel_c⟩ := (note_cancel_action_implies inp_cancel_action).1

  rw [inp_cancel_c] at h_inp_create_c
  apply crypto.h_hash at h_inp_create_c
  repeat injection h_inp_create_c with _ h_inp_create_c
  simp [*]

noncomputable def spent_notes_from_scan (crypto: Crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) (rm: ReachableMemory crypto) : Finset ScannedNote :=
  scan_notes_for_recipient crypto rm addrbob kbob
  |>.filter (λ sn ↦ sn.token = token)
  |>.filter (λ sn ↦ note_canceled_by_id crypto rm.m (sn.note_id crypto) = true)
  |>.toFinset

theorem spent_notes_from_scan' (crypto: Crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) (rm: ReachableMemory crypto) :
    spent_notes_from_scan crypto addrbob kbob token rm =
    (
       cancel_note_actions crypto rm
       |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob ∧ inp.kbob = ↑kbob)
       |>.map (λ inp ↦ inp.to_scanned_note)
       |>.toFinset
    ) := by
  rw [spent_notes_from_scan, List.toFinset_filter, filtered_scan_notes_eq_notes_from_actions]

  ext sn
  simp only [eq_iff_iff, iff_true, Bool.decide_and, Finset.mem_filter, List.mem_toFinset,
    List.mem_map, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq]
  constructor
  ·
    intro h
    obtain ⟨⟨inp_create, ⟨h₀₀, h₀₁, h₀₂, h₀₃⟩ , h₁, h₂, h₃⟩, h_canceled⟩ := h

    obtain ⟨c', token', i₀, i₁, kbob', h_note_id, h_note_canceled⟩ := h_canceled
    have ⟨inp_cancel, h₀, h₁, h₂⟩ := cancel_note_actions_iff_note_canceled.1 h_note_canceled
    use inp_cancel
    have : (inp_cancel.kbob = ↑kbob) ↔ (crypto.priv_to_pub inp_cancel.kbob = crypto.priv_to_pub kbob) := by
      constructor
      · intro h; simp [h]
      · intro h
        exact crypto.priv_to_pub_inj (by
          simp [h₂, canceled_note_implies_kbob_private_key h_note_canceled]
        ) (by simp) h
    rw [←h₀₁, ←h₀₂, this, ←h₀₃]

    have h_note_ids : inp_create.note_id crypto = inp_cancel.note_id crypto := by simp [*]
    have := create_cancel_actions inp_create inp_cancel h₀ h_note_ids

    simp [h₀, this]
  ·
    intro ⟨inp_cancel, ⟨h₀₀, h₀₁, h₀₂, h₀₃⟩, h₁⟩
    have h_note_canceled := cancel_note_actions_iff_note_canceled.2 ⟨inp_cancel, h₀₀, by rfl, by rfl⟩
    have h_note_exists := canceled_note_implies_exists h_note_canceled

    have ⟨inp_create, h₀, h₁'⟩ := create_note_actions_iff_note_exists.1 h_note_exists

    have h_note_ids : inp_create.note_id crypto = inp_cancel.note_id crypto := by rw [h₁']
    have := create_cancel_actions inp_create inp_cancel h₀₀ h_note_ids

    have : CancelNoteInput.Kbob crypto inp_cancel = crypto.priv_to_pub ↑kbob := by
      unfold CancelNoteInput.Kbob
      apply congrArg
      assumption

    have : inp_create.to_scanned_note crypto = sn := by rw [←h₁]; ext; repeat simp [*]
    use ⟨inp_create, by simp [*]⟩
    use inp_cancel.c, inp_cancel.token, inp_cancel.i₀, inp_cancel.i₁, inp_cancel.kbob
    constructor
    · rw [←h₁]
    · exact h_note_canceled

theorem cancel_note_actions_note_id_nodup (crypto: Crypto) (note_id: ℕ) :
    ∀ rm, (cancel_note_actions crypto rm |>.map (λ inp ↦ inp.note_id crypto) |>.count note_id) ≤ 1 := by
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
      have h_nullifiers : inp'.nullifier crypto = inp.nullifier crypto := by
        have h_note_id : inp'.note_id crypto = inp.note_id crypto := by simp [*]
        apply crypto.h_hash at h_note_id
        repeat injection h_note_id with _ h_note_id

        have h_same_c : inp'.c = inp.c := by assumption

        have ⟨⟨addralice, kalice, h_c⟩, h_kbob_private_key, _⟩ := note_cancel_action_implies h₀.1
        have ⟨addralice', kalice', h_c'⟩ := subchannel_hash_exists_implies_hash info.subchannel_exists
        rw [h_same_c,  h_c'] at h_c
        apply crypto.h_hash at h_c
        repeat injection h_c with _ h_c

        unfold CancelNoteInput.nullifier
        have : inp.kbob = inp'.kbob := by
          apply crypto.priv_to_pub_inj
          exact info.kbob_private_key
          exact h_kbob_private_key
          assumption
        simp [*]
      have := info.nullifier_didnt_exist
      rw [←h_nullifiers] at this
      have : ¬note_canceled crypto rm.m inp'.c inp'.token inp'.i₀ inp'.i₁ inp'.kbob := by
        unfold note_canceled
        unfold CancelNoteInput.nullifier at this
        simp [this]
      have : note_canceled crypto rm.m inp'.c inp'.token inp'.i₀ inp'.i₁ inp'.kbob := by
        apply cancel_note_actions_iff_note_canceled.2
        use inp'
        simp [h₀]
      contradiction
    case neg =>
      simpa only [List.map_cons, ne_eq, h_note_id, not_false_eq_true, List.count_cons_of_ne,
        ge_iff_le]
  repeat exact ih

theorem canceled_note_amount_eq_amount (crypto: Crypto) (inp: CancelNoteInput) :
    ∀ (rm: ReachableMemory crypto),
    (h: inp ∈ cancel_note_actions crypto rm) →
    rm.m .Notes [inp.note_id crypto, 0] ≠ 0 ∧
    note_amount crypto rm (inp.note_id crypto) inp.c = inp.amount := by
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success h₀
  have h_amount_ne_zero := (note_cancel_action_implies h₀).2.2

  simp only [cancel_note_actions, ReachableMemory.add, List.flatMap_cons, List.mem_append,
    List.mem_flatMap] at h₀
  cases h₀
  case inl h₀ =>
    cases action
    case CancelNote inp' =>
      simp at h₀
      let info := cancel_note_info crypto inp' rm success
      unfold note_amount ReachableMemory.add run_action
      dsimp only
      rw [←info.h_m']
      rw [h₀, CancelNoteInput.note_id]
      rw [info.no_change _ _ (by simp)]

      constructor
      · exact info.r_ne_zero
      · have := info.h_amount
        unfold note_amount at this
        rw [this]

    repeat trivial
  case inr h₀ =>
    replace ih := ih (by simp [cancel_note_actions, h₀])
    cases action
    case CancelNote inp' =>
      let info := cancel_note_info crypto inp' rm success
      unfold note_amount ReachableMemory.add run_action
      dsimp only
      rw [←info.h_m']
      rw [info.no_change _ _ (by simp)]
      exact ih

    case CreateNote inp' =>
      let info := create_note_info crypto inp' rm success
      unfold note_amount ReachableMemory.add run_action
      dsimp only
      rw [←info.h_m']
      have h_note_id : inp.note_id crypto ≠ inp'.note_id crypto := by
        by_contra h_note_id
        have := info.old_value_was_zero
        rw [←h_note_id] at this
        omega

      rw [info.no_change _ _ (by simp [h_note_id]) (by simp)]
      exact ih

    case OpenDeposit inp' =>
      let info := open_deposit_info crypto inp' rm success

      unfold note_amount ReachableMemory.add run_action
      dsimp only
      rw [←info.h_m']
      have h_note_id : inp.note_id crypto ≠ inp'.note_id := by
        by_contra h_note_id
        have h_amount := ih.2
        simp only [note_amount, h_note_id, info.old_value, crypto.unpack_pack, reduceIte, tsub_self] at h_amount
        rw [h_amount] at h_amount_ne_zero
        contradiction

      rw [info.no_change _ _ (by simp [h_note_id])]
      exact ih

    repeat trivial

abbrev sum_cancel_note_amounts (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) : ℕ :=
  cancel_note_actions crypto rm
  |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob ∧ inp.kbob = ↑kbob)
  |>.map (λ inp ↦ inp.amount)
  |>.sum

theorem sum_of_canceled_notes_to_scanned_notes
    (crypto: Crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) (rm: ReachableMemory crypto) :
    sum_cancel_note_amounts crypto rm addrbob kbob token =
    (
      scan_notes_for_recipient crypto rm addrbob kbob
      |>.filter (λ sn ↦ sn.token = token)
      |>.dedup
      |>.filter (λ sn ↦ note_canceled_by_id crypto rm.m (sn.note_id crypto) = true)
      |>.map (λ sn ↦ note_amount crypto rm (sn.note_id crypto) sn.c)
      |>.sum
    ) := by

  have : ∀ ℓ: List ScannedNote, ∀ f, (ℓ.dedup |>.filter f |>.toFinset) = (ℓ |>.filter f |>.toFinset) := by
    intro ℓ f; ext x; simp [List.mem_toFinset, List.mem_dedup]

  rw [←List.sum_toFinset _ (by
    apply List.Nodup.filter
    apply List.nodup_dedup
  )]

  rw [this, ←spent_notes_from_scan, spent_notes_from_scan']

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

  intro inp h₀ h₁ h₂ h₃
  simp [(canceled_note_amount_eq_amount crypto inp rm h₀).2]

-- For any recipient (addrbob, kbob) and token:
--   created notes + deposited notes = canceled notes + unspent notes.
theorem sum_create_note_cancel_note
    (crypto: Crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) (rm: ReachableMemory crypto) :
    sum_create_note_amounts crypto rm addrbob kbob token +
    sum_deposit_amounts crypto rm addrbob kbob token =
    sum_cancel_note_amounts crypto rm addrbob kbob token +
    (
      scan_notes_for_recipient crypto rm addrbob kbob
      |>.filter (λ sn ↦ sn.token = token)
      |>.dedup
      |>.filter (λ sn ↦ note_canceled_by_id crypto rm.m (sn.note_id crypto) = false)
      |>.map (λ sn ↦ note_amount crypto rm (sn.note_id crypto) sn.c)
      |>.sum
    ) := by
  -- Define abbreviations for readability
  set ℓ := scan_notes_for_recipient crypto rm addrbob kbob
  set f_token := λ sn: ScannedNote ↦ sn.token = token
  set amount := λ sn: ScannedNote ↦ note_amount crypto rm (sn.note_id crypto) sn.c
  let f_spent := λ sn: ScannedNote ↦ (note_canceled_by_id crypto rm.m (sn.note_id crypto) = true)
  let f_unspent := λ sn: ScannedNote ↦ (note_canceled_by_id crypto rm.m (sn.note_id crypto) = false)

  have neg_f_spent : (λ sn ↦ decide ¬f_spent sn) = (λ sn ↦ decide (f_unspent sn)) := by
    ext x; classical simp [f_spent, f_unspent]

  calc sum_create_note_amounts crypto rm addrbob kbob token +
       sum_deposit_amounts crypto rm addrbob kbob token
    _ = (ℓ |>.filter f_token |>.dedup |>.map amount |>.sum) :=
        sum_of_created_notes_to_scanned_notes crypto addrbob kbob token rm
    -- Split sum into spent + unspent.
    _ = (ℓ |>.filter f_token |>.dedup |>.filter f_spent |>.map amount |>.sum) +
        (ℓ |>.filter f_token |>.dedup |>.filter (¬f_spent ·) |>.map amount |>.sum) := by
        rw [←List.sum_map_filter_add_sum_map_filter_not f_spent]
    _ = sum_cancel_note_amounts crypto rm addrbob kbob token +
        (ℓ |>.filter f_token |>.dedup |>.filter (¬f_spent ·) |>.map amount |>.sum) := by
        rw [sum_of_canceled_notes_to_scanned_notes]
    _ = _ := by rw [neg_f_spent]

-- Can't spend more than created + deposited.
theorem sum_cancel_note_le_sum_create_note
    (crypto: Crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (token: ℕ) (rm: ReachableMemory crypto) :
    sum_cancel_note_amounts crypto rm addrbob kbob token ≤
    sum_create_note_amounts crypto rm addrbob kbob token +
    sum_deposit_amounts crypto rm addrbob kbob token := by
  simp [sum_create_note_cancel_note]
