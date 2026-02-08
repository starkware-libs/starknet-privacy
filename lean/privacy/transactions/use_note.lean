import privacy.notes
import privacy.transactions.transactions

-- Returns a list of booleans indicating whether each transaction emitted a UseNote event for any
-- of the given nullifiers.
def has_use_note_event (events: List (List Event)) (nullifiers: Finset ℕ) : List Bool :=
  events.map (λ tx_events ↦
    (nullifiers.image (λ nullifier ↦ .UseNote nullifier) ∩ tx_events.toFinset).Nonempty
  )

theorem has_use_note_event.length (events: List (List Event)) (nullifiers: Finset ℕ) :
  (has_use_note_event events nullifiers).length = events.length := by
  simp only [has_use_note_event, List.length_map]

theorem has_use_note_event.eq
    (stxs: SuccessfulTransactions crypto)
    (nullifiers: Finset ℕ) :
    has_use_note_event stxs.events nullifiers =
      stxs.txs.reverse.map (λ tx ↦ tx.actions.any (λ action ↦
        match action with
        | .UseNote inp => inp.nullifier crypto ∈ nullifiers
        | _ => false
      )
    ) := by
  revert stxs
  apply SuccessfulTransactions.induction
  case empty => trivial
  case succ =>
    intro h ih
    conv =>
      congr
      · rw [h.h_events, has_use_note_event, List.map_append, ←has_use_note_event, ih]
      · rw [h.h_txs, List.reverse_cons, List.map_append]
    apply congrArg
    simp only [List.map_singleton]
    apply congrArg (λ x ↦ [x])

    generalize h.tx.actions = actions
    induction actions
    case nil => simp
    case cons action actions ih' =>
      rw [List.any_cons, run_all_cons_events, List.toFinset_append, Finset.inter_union_distrib_left]
      conv => lhs; congr; rw [Finset.union_nonempty]
      rw [←ih', Bool.decide_or, Bool.or_comm]
      apply congrArg₂ _ _ (by rfl)
      cases action
      case UseNote inp =>
        simp only [run_action, run_action₀, use_note, get_events, List.filterMap_cons,
          List.filterMap_nil, List.toFinset_cons, List.toFinset_nil,
          insert_empty_eq, decide_eq_decide, Finset.inter_singleton]
        by_cases h_nullifier: UseNoteInput.nullifier crypto inp ∈ nullifiers
        all_goals simp [h_nullifier]

      all_goals
        simp only [decide_eq_false_iff_not, Finset.not_nonempty_iff_eq_empty]
        ext event
        simp only [Finset.mem_inter, Finset.mem_image, List.mem_toFinset, Finset.notMem_empty,
          iff_false, not_and, forall_exists_index, and_imp]
        intro nullifier h_nullifier h_use_note
        by_contra h'
        rw [←h_use_note] at h'
        try trivial

      case CreateNote inp =>
        simp only [run_action, get_events, run_action₀, create_note] at h'
        by_cases h_r : inp.r = 1
        all_goals simp [h_r] at h'

-- Returns all the nullifiers of the user's notes.
def nullifiers_for_user
    {crypto: Crypto} {m: Memory}
    (context: ScanNoteContext crypto m)
    (user: UserPrivKey crypto m) : Finset ℕ :=
  scan_notes_for_recipient context user.addr user.k
  |>.map (λ sn ↦ sn.nullifier crypto user.k)
  |>.toFinset

theorem nullifier_iff
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (context: ScanNoteContext crypto rm.m)
    (user: UserPrivKey crypto rm.m)
    (nullifier: ℕ) :
    nullifier ∈ nullifiers_for_user context user ↔
    ∃ (inp: CreateNoteInput) (_note_imp: NoteImplies rm inp) (kbob: crypto.PrivateKeys),
    inp.addrbob = user.addr ∧
    inp.Kbob = crypto.priv_to_pub kbob ∧
    (inp.to_scanned_note crypto).nullifier crypto kbob = nullifier := by
  constructor
  · intro h
    simp only [nullifiers_for_user, List.mem_toFinset, List.mem_map] at h
    have ⟨esn, h_esn, h_nullifier⟩ := h
    have ⟨inp, note_imp, h_esn, h_addrbob, h_inp_addralice, h_inp_addrbob, h_inp_Kbob⟩ :=
      NoteImplies.from_scan_notes_for_recipient user.h_k h_esn
    use inp, note_imp, user.k

    refine ⟨?_, h_inp_Kbob, ?_⟩
    · rw [←h_addrbob]
    · rw [←h_nullifier, ←h_esn]
  · intro h
    have ⟨inp, note_imp, kbob, h_addrbob, h_Kbob, h_nullifier⟩ := h

    simp only [nullifiers_for_user, List.mem_toFinset, List.mem_map]
    use inp.to_ex_scanned_note crypto
    have h_user_k: note_imp.subchannel.channel.kbob = user.k := by
      apply Subtype.ext
      apply crypto.priv_to_pub_inj (by simp) (by simp)
      have := note_imp.subchannel.channel.bob_registered.public_key ▸ h_addrbob ▸ user.h_k
      exact this
    constructor
    · rw [←h_addrbob, ←h_user_k]
      have := note_imp.scan_for_recipient
      exact this
    · rw [←h_nullifier]
      have : user.k.val = kbob.val := by
        apply crypto.priv_to_pub_inj (by simp) (by simp)
        rw [←h_Kbob, ←h_user_k, ←note_imp.subchannel.channel.h_Kbob]
      rw [←this]

theorem has_use_note_event.for_nullifiers_for_user
    (stxs: SuccessfulTransactions crypto)
    (user: UserPrivKey crypto stxs.rm) :
    has_use_note_event stxs.events (nullifiers_for_user (.from stxs.rm) user) =
      stxs.txs.reverse.map (λ tx ↦ tx.owner = user.addr && (tx.actions.filterMap filter_UseNote) ≠ []
    ) := by
  rw [has_use_note_event.eq]
  apply List.map_congr_left
  intro tx h_tx
  rw [List.mem_reverse] at h_tx
  rw [Bool.eq_iff_iff]

  constructor
  · intro h
    rw [List.any_eq_true] at h
    have ⟨action, h_action, h_use_note⟩ := h
    cases action
    case UseNote inp =>
      simp only at h_use_note
      rw [decide_eq_true_eq] at h_use_note
      rw [nullifier_iff] at h_use_note
      have ⟨inp', note_imp, kbob, h_addrbob, h_Kbob, h_nullifier⟩ := h_use_note
      simp only [Bool.and_eq_true, decide_eq_true_eq]
      constructor
      · have := tx.h_owner _ h_action
        rw [Action.check_owner] at this
        rw [←this, ←h_addrbob]

        have h_c : (inp'.to_scanned_note crypto).c = inp.c := by
          apply crypto.h_hash at h_nullifier
          injections

        have ⟨use_imp⟩ := UseImplies.from_action (stxs.in_rm_actions h_action h_tx)
        have : inp'.addrbob = inp.addrbob := by
          rw [←use_imp.h_c] at h_c
          apply crypto.h_hash at h_c
          injections

        rw [this]
      · apply List.ne_nil_of_mem (a:=inp)
        rw [List.mem_filterMap]
        exact ⟨.UseNote inp, h_action, by rfl⟩
    all_goals contradiction
  · intro h
    simp only [Bool.and_eq_true, decide_eq_true_eq] at h
    simp only [ne_eq, List.filterMap_eq_nil_iff, not_forall] at h
    have ⟨h_owner, action, h_action, h_use_note⟩ := h

    cases action
    case UseNote inp =>
      clear h_use_note

      have ⟨use_imp⟩ := UseImplies.from_action (stxs.in_rm_actions h_action h_tx)

      rw [List.any_eq_true]
      use Action.UseNote inp, h_action
      simp only [decide_eq_true_eq]
      rw [nullifier_iff]
      use use_imp.inp_create, use_imp.note_created, ⟨inp.kbob, use_imp.kbob_priv⟩

      have := tx.h_owner _ h_action
      rw [Action.check_owner] at this

      refine ⟨?_, ?_, ?_⟩
      · rw [←h_owner, ←this]
      · rfl
      · simp only [ScannedNote.nullifier, UseNoteInput.nullifier, use_imp.h_c]
    all_goals contradiction
