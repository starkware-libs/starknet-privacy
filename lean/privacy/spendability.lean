import privacy.actions
import privacy.amounts
import privacy.notes.canceled_notes
import privacy.notes.discoverable
import privacy.utils

def spend_note (crypto: Crypto) (m: Memory) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (sn: ScannedNote)
     : CancelNoteInput :=
  {
    c := sn.c,
    token := sn.token,
    i₀ := sn.i₀,
    i₁ := sn.i₁,
    kbob := kbob,
    addrbob := addrbob,
    amount := note_amount crypto m (sn.note_id crypto) sn.c,
  }

-- A discoverable, uncanceled note with non-zero amount can be spent.
theorem spendable_note
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys} {sn: ScannedNote}
    (h_note_in_scan: sn ∈ scan_notes_for_recipient (.from rm) addrbob kbob)
    (h_not_canceled: ¬note_canceled crypto rm.m sn.c sn.token sn.i₀ sn.i₁ kbob)
    (h_amount_ne_zero: note_amount crypto rm (sn.note_id crypto) sn.c ≠ 0) :
    let inp := spend_note crypto rm addrbob kbob sn
    (cancel_note crypto inp rm |> process_action crypto rm).success := by
  have ⟨inp_create, h_inp_create, h_sn, h_addrbob, h_Kbob⟩ := (create_note_actions_iff_note_discoverable addrbob kbob sn).1 h_note_in_scan
  have ⟨h_note_exists, h_subchannel_exists⟩ := create_note_actions_implies h_inp_create

  have h_note_id : inp_create.note_id crypto = sn.note_id crypto := by rw [←h_sn]

  unfold CreateNoteInput.to_scanned_note at h_sn
  have h_sn := ScannedNote.ext_iff.1 h_sn
  simp only at h_sn

  have ⟨h_r, h_amount⟩ := note_amount_eq_amount h_inp_create

  unfold spend_note cancel_note
  intro inp

  simp only [ServerAction.run_all, ServerAction.run, List.foldl_cons, List.foldl_nil, Bool.true_and]
  simp only [ne_eq, Bool.decide_and, decide_not, Bool.and_eq_true, Bool.not_eq_eq_eq_not,
    Bool.not_true, decide_eq_false_iff_not, decide_eq_true_eq]

  refine ⟨⟨?_, ?_, ?_, ?_, ?_⟩, ?_⟩
  · rw [h_addrbob, h_Kbob] at h_subchannel_exists
    simp only [h_sn] at h_subchannel_exists
    exact h_subchannel_exists.1
  · rwa [h_note_id] at h_r
  · rw [h_note_id] at h_amount
  · exact kbob.prop
  · exact h_amount_ne_zero
  · unfold note_canceled at h_not_canceled
    simp at h_not_canceled
    exact h_not_canceled

def spend_notes
    (crypto: Crypto) (m: Memory) (addrbob: ℕ) (kbob: crypto.PrivateKeys)
    (sns: List ScannedNote) : List CancelNoteInput × Memory :=
  match sns with
  | [] => ⟨[], m⟩
  | sn :: sns =>
    let ⟨inps, m⟩ := spend_notes crypto m addrbob kbob sns
    let inp := spend_note crypto m addrbob kbob sn
    let m := (cancel_note crypto inp m |> process_action crypto m).1
    ⟨inp :: inps, m⟩

theorem in_spend_notes
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys} {sns: List ScannedNote} {inp: CancelNoteInput}
    (h: inp ∈ (spend_notes crypto rm addrbob kbob sns).1) :
    inp.note_id crypto ∈ sns.map (λ sn ↦ sn.note_id crypto) := by
  induction sns
  case nil => contradiction
  case cons sn sns ih =>
    rw [List.map_cons, List.mem_cons]
    rw [spend_notes, List.mem_cons] at h
    cases h
    case inl h =>
      apply Or.inl
      rw [h]
      rfl
    case inr h =>
      exact Or.inr (ih h)

-- A list of discoverable, uncanceled, non-zero notes can all be spent.
theorem spendable_notes
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys} {sns: List ScannedNote}
    (h_note_in_scan: sns ⊆ scan_notes_for_recipient (.from rm) addrbob kbob)
    (h_not_canceled: ∀ sn ∈ sns, ¬note_canceled crypto rm.m sn.c sn.token sn.i₀ sn.i₁ kbob)
    (h_amount_ne_zero: ∀ sn ∈ sns, note_amount crypto rm (sn.note_id crypto) sn.c ≠ 0)
    (h_nodup: sns.Nodup) :
    let res := spend_notes crypto rm addrbob kbob sns
    (∃ rm': ReachableMemory crypto,
      rm'.m = res.2 ∧
      scan_notes_for_recipient (.from rm') addrbob kbob = scan_notes_for_recipient (.from rm) addrbob kbob ∧
      rm'.actions = res.1.map (λ inp ↦ Action.CancelNote inp) ++ rm.actions ∧
      (∀ sn ∈ sns, note_canceled crypto rm'.m sn.c sn.token sn.i₀ sn.i₁ kbob) ∧
      (∀ note_id c, note_amount crypto rm' note_id c = note_amount crypto rm note_id c)
    ) := by
  induction sns
  case nil => use rm; simp [spend_notes]
  case cons sn sns ih =>
    simp only [List.cons_subset] at h_note_in_scan
    simp only [List.mem_cons, forall_eq_or_imp] at h_not_canceled h_amount_ne_zero
    simp only [List.nodup_cons] at h_nodup
    obtain ⟨rm', h_rm', h_scan, h_actions, h_canceled, h_amounts⟩ :=
      ih h_note_in_scan.2 h_not_canceled.2 h_amount_ne_zero.2 h_nodup.2

    let res₀ := spend_notes crypto rm.m addrbob kbob sns
    have h_extends : rm'.extends rm := by simp [ReachableMemory.extends, h_actions]

    have h_success : (run_action crypto (Action.CancelNote (spend_note crypto rm'.m addrbob kbob sn)) rm'.m).success := by
      unfold run_action
      dsimp only
      apply spendable_note
      case h_note_in_scan =>
        rw [h_scan]
        exact h_note_in_scan.1
      case h_amount_ne_zero =>
        apply note_amount_nz_immutable h_extends sn
        exact h_amount_ne_zero.1
      case h_not_canceled =>
        by_contra h_canceled
        have ⟨cancel_inp, h_cancel_inp, h_note_id⟩ := cancel_note_actions_iff_note_canceled.1 h_canceled

        have : cancel_note_actions crypto rm' = res₀.1 ++ (cancel_note_actions crypto rm) := by
          simp only [cancel_note_actions, h_actions, List.filterMap_append,
            res₀, List.filterMap_map]
          conv in _ ∘ _ => intro x; simp only [Function.comp_apply]
          rw [List.filterMap_some]

        rw [this] at h_cancel_inp
        simp only [List.mem_append] at h_cancel_inp

        cases h_cancel_inp
        case inl h_cancel_inp =>
          dsimp only [res₀] at h_cancel_inp
          apply in_spend_notes at h_cancel_inp
          simp only [h_note_id.1, List.mem_map] at h_cancel_inp
          have ⟨sn', h_sn', h_note_id'⟩ := h_cancel_inp
          apply ScannedNote.note_id_eq at h_note_id'
          rw [h_note_id'] at h_sn'
          exact h_nodup.1 h_sn'
        case inr h_cancel_inp =>
          have : note_canceled crypto rm.m sn.c sn.token sn.i₀ sn.i₁ ↑kbob := by
            apply cancel_note_actions_iff_note_canceled.2
            use cancel_inp

          exact h_not_canceled.1 this

    let rm'' := rm'.add (.CancelNote (spend_note crypto rm' addrbob kbob sn)) h_success
    use rm''
    refine ⟨?_, h_scan, ?_, ?_, h_amounts⟩
    · simp only [rm'', spend_notes, ReachableMemory.add_m, run_action, h_rm']
    · simp [rm'', ReachableMemory.add, spend_notes, h_actions, h_rm']
    · intro sn' h_sn'
      rw [List.mem_cons] at h_sn'
      cases h_sn'
      case inl h_sn' =>
        unfold rm''
        rw [note_canceled, ReachableMemory.add_m, run_action]
        let info := cancel_note_info crypto (spend_note crypto rm'.m addrbob kbob sn) rm' h_success
        have := info.memory_diff₀
        unfold spend_note CancelNoteInput.nullifier at this
        rw [h_sn', ←info.h_m', this]
        simp
      case inr h_sn' =>
        exact note_canceled_monotone_extends (by simp [rm'', ReachableMemory.extends]) (h_canceled sn' h_sn')

def spend_all (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) : List CancelNoteInput :=
  let sns := scan_notes_for_recipient (.from rm) addrbob kbob
    |>.filter (λ sn ↦ rm.m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁, kbob]] = 0)
    |>.dedup
  let res := spend_notes crypto rm addrbob kbob sns
  res.1

-- Bob can spend all his notes, leaving zero unspent balance.
theorem spend_all_props (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) :
    ∃ rm': ReachableMemory crypto,
    rm'.extends rm ∧
    ∀ token,
      sum_create_note_amounts crypto rm' addrbob kbob token
      + sum_deposit_amounts crypto rm' addrbob kbob token =
      sum_cancel_note_amounts crypto rm' addrbob kbob token := by
  let sns := scan_notes_for_recipient (.from rm) addrbob kbob
    |>.filter (λ sn ↦ rm.m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i₀, sn.i₁, kbob]] = 0)
    |>.filter (λ sn ↦ note_amount crypto rm (sn.note_id crypto) sn.c ≠ 0)
    |>.dedup
  let cancel_note_inps := spend_all crypto rm addrbob kbob

  have h_note_in_scan : sns ⊆ scan_notes_for_recipient (.from rm) addrbob kbob := by
    intro sn h_sn
    rw [List.mem_dedup, List.mem_filter, List.mem_filter] at h_sn
    exact h_sn.1.1

  have h_not_canceled: ∀ sn ∈ sns, ¬note_canceled crypto rm.m sn.c sn.token sn.i₀ sn.i₁ kbob := by
    intro sn h_sn
    rw [List.mem_dedup, List.mem_filter, List.mem_filter, decide_eq_true_eq] at h_sn
    unfold note_canceled
    simp only [ne_eq, Decidable.not_not]
    exact h_sn.1.2

  have h_amount_ne_zero: ∀ sn ∈ sns, note_amount crypto rm (sn.note_id crypto) sn.c ≠ 0 := by
    intro sn h_sn
    rw [List.mem_dedup, List.mem_filter, List.mem_filter, decide_eq_true_eq, decide_eq_true_eq] at h_sn
    simp only [ne_eq]
    exact h_sn.2

  have ⟨rm', _, h_scan_notes_for_recipient, h_actions, h_canceled, h_amounts⟩ := spendable_notes h_note_in_scan h_not_canceled h_amount_ne_zero (by apply List.nodup_dedup)
  use rm'

  have h_extends : rm'.extends rm := by simp [ReachableMemory.extends, h_actions]
  use h_extends

  intro token
  simp only [sum_create_note_cancel_note, Nat.add_eq_left]
  apply List.sum_eq_zero
  intro amount h
  have ⟨sn, h⟩ := List.mem_map.1 h
  rw [List.mem_filter, List.mem_dedup, List.mem_filter] at h
  simp only [decide_eq_true_eq] at h
  have ⟨⟨⟨h₀, h₁⟩, h₂⟩, h₃⟩ := h
  rw [←h₃, h_amounts]
  rw [h_scan_notes_for_recipient] at h₀

  have : rm'.m MemoryType.Nullifiers [crypto.hash [sn.c, token, sn.i₀, sn.i₁, ↑kbob]] = 0 := by
    by_contra h_nullifier_nz
    exact h_nullifier_nz (h₁ ▸ h₂)

  have : rm.m MemoryType.Nullifiers [crypto.hash [sn.c, token, sn.i₀, sn.i₁, ↑kbob]] = 0 := by
    rw [←h₁] at *
    by_contra h_nullifier_nz
    exact note_canceled_monotone_extends h_extends h_nullifier_nz this

  by_contra h_amount_ne_zero
  have h_sn_in_sns : sn ∈ sns := by
    rw [List.mem_dedup, List.mem_filter, List.mem_filter]
    simp [*]

  have := h_canceled sn h_sn_in_sns
  rw [h₁] at this
  contradiction
