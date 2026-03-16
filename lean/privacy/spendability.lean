import privacy.actions
import privacy.amounts
import privacy.notes.used_notes
import privacy.notes.discoverable
import privacy.utils
import privacy.transactions.immutability

def spend_note (crypto: Crypto) (m: Memory) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (sn: ScannedNote)
     : UseNoteInput :=
  {
    c := sn.c,
    token := sn.token,
    i := sn.i,
    kbob := kbob,
    addrbob := addrbob,
    amount := sn.amount crypto m,
  }

-- A discoverable, unused note with non-zero amount can be spent.
theorem spendable_note
    {crypto: Crypto} {rm: ReachableMemory crypto} {sn: ScannedNote}
    (bob: UserPrivKey crypto rm.m)
    (h_note_in_scan: sn ∈ scan_notes_for_recipient₀ (.from rm) bob.addr bob.k)
    (h_not_used: ¬note_used crypto rm.m sn.c sn.token sn.i bob.k)
    (h_amount_ne_zero: sn.amount crypto rm.m ≠ 0) :
    let inp := spend_note crypto rm bob.addr bob.k sn
    (use_note crypto inp rm |> process_action crypto rm).success := by
  have ⟨inp_create, note_imp, h_sn, h_addrbob, h_Kbob⟩ := NoteImplies.from_scan_notes_for_recipient₀ bob.h_k h_note_in_scan

  have h_note_id : inp_create.note_id crypto = sn.note_id crypto := by rw [←h_sn]

  unfold CreateNoteInput.to_scanned_note at h_sn
  have h_sn := ScannedNote.ext_iff.1 h_sn
  simp only at h_sn

  have ⟨h_r, h_amount⟩ := note_amount_eq_amount note_imp.in_create_note_actions

  unfold spend_note use_note
  intro inp

  simp only [ServerAction.run_all, ServerAction.run, List.foldl_cons, List.foldl_nil, Bool.true_and]
  simp only [ne_eq, Bool.decide_and, decide_not, Bool.and_eq_true, Bool.not_eq_eq_eq_not,
    Bool.not_true, decide_eq_false_iff_not, decide_eq_true_eq]

  refine ⟨⟨?_, ?_, ?_, ?_, ?_⟩, ?_⟩
  · have := note_imp.subchannel.subchannel_marker
    simp only [OpenSubchannelInput.subchannel_marker] at this
    rw [h_addrbob, h_Kbob] at this
    simp only [h_sn] at this
    exact this
  · rwa [h_note_id] at h_r
  · rw [h_note_id] at h_amount
  · exact bob.k.prop
  · exact h_amount_ne_zero
  · unfold note_used at h_not_used
    simp at h_not_used
    exact ⟨h_not_used, by trivial⟩

def spend_notes
    (crypto: Crypto) (m: Memory) (addrbob: ℕ) (kbob: crypto.PrivateKeys)
    (sns: List ScannedNote) : List UseNoteInput × Memory :=
  match sns with
  | [] => ⟨[], m⟩
  | sn :: sns =>
    let ⟨inps, m⟩ := spend_notes crypto m addrbob kbob sns
    let inp := spend_note crypto m addrbob kbob sn
    let m := (use_note crypto inp m |> process_action crypto m).1
    ⟨inp :: inps, m⟩

theorem in_spend_notes
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys} {sns: List ScannedNote} {inp: UseNoteInput}
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

-- A list of discoverable, unused, non-zero notes can all be spent.
theorem spendable_notes
    {crypto: Crypto} {rm: ReachableMemory crypto} {sns: List ScannedNote}
    (bob: UserPrivKey crypto rm.m)
    (h_note_in_scan: sns ⊆ scan_notes_for_recipient₀ (.from rm) bob.addr bob.k)
    (h_not_used: ∀ sn ∈ sns, ¬note_used crypto rm.m sn.c sn.token sn.i bob.k)
    (h_amount_ne_zero: ∀ sn ∈ sns, sn.amount crypto rm ≠ 0)
    (h_nodup: sns.Nodup) :
    let res := spend_notes crypto rm bob.addr bob.k sns
    (∃ rm': ReachableMemory crypto,
      rm'.m = res.2 ∧
      scan_notes_for_recipient₀ (.from rm') bob.addr bob.k = scan_notes_for_recipient₀ (.from rm) bob.addr bob.k ∧
      rm'.actions = res.1.map (λ inp ↦ Action.UseNote inp) ++ rm.actions ∧
      (∀ sn ∈ sns, note_used crypto rm'.m sn.c sn.token sn.i bob.k) ∧
      (∀ sn: ScannedNote, sn.amount crypto rm' = sn.amount crypto rm)
    ) := by
  induction sns
  case nil => use rm; simp [spend_notes]
  case cons sn sns ih =>
    simp only [List.cons_subset] at h_note_in_scan
    simp only [List.mem_cons, forall_eq_or_imp] at h_not_used h_amount_ne_zero
    simp only [List.nodup_cons] at h_nodup
    obtain ⟨rm', h_rm', h_scan, h_actions, h_used, h_amounts⟩ :=
      ih h_note_in_scan.2 h_not_used.2 h_amount_ne_zero.2 h_nodup.2

    let res₀ := spend_notes crypto rm.m bob.addr bob.k sns
    have h_extends : rm'.extends rm := by simp [ReachableMemory.extends, h_actions]

    have h_success : (run_action crypto (Action.UseNote (spend_note crypto rm'.m bob.addr bob.k sn)) rm'.m).success := by
      unfold run_action
      apply spendable_note (bob:=bob.extend h_extends)
      case h_note_in_scan =>
        rw [h_scan]
        exact h_note_in_scan.1
      case h_amount_ne_zero =>
        apply note_amount_nz_immutable h_extends sn
        exact h_amount_ne_zero.1
      case h_not_used =>
        by_contra h_used
        have ⟨addrbob, amount, ⟨use_imp⟩⟩ := UseImplies.from_note_used h_used

        have : used_note_actions crypto rm' = res₀.1 ++ (used_note_actions crypto rm) := by
          simp only [used_note_actions, h_actions, List.filterMap_append,
            res₀, List.filterMap_map]
          conv in _ ∘ _ => intro x; simp only [Function.comp_apply]
          rw [List.filterMap_some]

        have h_used_imp := use_imp.in_used_note_actions
        rw [this] at h_used_imp
        simp only [List.mem_append] at h_used_imp

        cases h_used_imp
        case inl h_used_imp =>
          dsimp only [res₀] at h_used_imp
          apply in_spend_notes at h_used_imp
          simp only [List.mem_map] at h_used_imp
          have ⟨sn', h_sn', h_note_id'⟩ := h_used_imp
          apply ScannedNote.note_id_eq at h_note_id'
          rw [h_note_id'] at h_sn'
          exact h_nodup.1 h_sn'
        case inr h_used_imp =>
          have := (UseImplies.from_used_note_actions h_used_imp |>.some).h_note_used
          exact h_not_used.1 this

    let rm'' := rm'.add (.UseNote (spend_note crypto rm' bob.addr bob.k sn)) h_success
    use rm''
    refine ⟨?_, h_scan, ?_, ?_, h_amounts⟩
    · simp only [rm'', spend_notes, ReachableMemory.add_m, run_action, h_rm']
    · simp [rm'', ReachableMemory.add, spend_notes, h_actions, h_rm']
    · intro sn' h_sn'
      rw [List.mem_cons] at h_sn'
      cases h_sn'
      case inl h_sn' =>
        unfold rm''
        rw [note_used, ReachableMemory.add_m, run_action]
        let info := use_note_info crypto (spend_note crypto rm'.m bob.addr bob.k sn) rm' h_success
        have := info.memory_diff₀
        unfold spend_note UseNoteInput.nullifier at this
        rw [h_sn', ←info.h_m', this]
        simp
      case inr h_sn' =>
        exact note_used_monotone_extend (by simp [rm'', ReachableMemory.extends]) (h_used sn' h_sn')

def spend_all (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) : List UseNoteInput :=
  let sns := scan_notes_for_recipient₀ (.from rm) addrbob kbob
    |>.filter (λ sn ↦ rm.m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i, kbob]] = 0)
  let res := spend_notes crypto rm addrbob kbob sns
  res.1

-- Bob can spend all his notes, leaving zero unspent balance.
theorem spend_all_props
    (crypto: Crypto) (rm: ReachableMemory crypto)
    (bob: UserPrivKey crypto rm.m) :
    ∃ rm': ReachableMemory crypto,
    rm'.extends rm ∧
    ∀ token,
      sum_create_note_amounts crypto rm' bob.addr token
      + sum_deposit_amounts crypto rm' bob.addr token =
      sum_use_note_amounts crypto rm' bob.addr token := by
  let sns := scan_notes_for_recipient₀ (.from rm) bob.addr bob.k
    |>.filter (λ sn ↦ rm.m .Nullifiers [crypto.hash [sn.c, sn.token, sn.i, bob.k]] = 0)
    |>.filter (λ sn ↦ sn.amount crypto rm.m ≠ 0)
  let used_note_inps := spend_all crypto rm bob.addr bob.k

  have h_note_in_scan : sns ⊆ scan_notes_for_recipient₀ (.from rm) bob.addr bob.k := by
    intro sn h_sn
    rw [List.mem_filter, List.mem_filter] at h_sn
    exact h_sn.1.1

  have h_not_used: ∀ sn ∈ sns, ¬note_used crypto rm.m sn.c sn.token sn.i bob.k := by
    intro sn h_sn
    rw [List.mem_filter, List.mem_filter, decide_eq_true_eq] at h_sn
    unfold note_used
    simp only [ne_eq, Decidable.not_not]
    exact h_sn.1.2

  have h_amount_ne_zero: ∀ sn ∈ sns, sn.amount crypto rm.m ≠ 0 := by
    intro sn h_sn
    rw [List.mem_filter, List.mem_filter, decide_eq_true_eq, decide_eq_true_eq] at h_sn
    simp only [ne_eq]
    exact h_sn.2

  have ⟨rm', _, h_scan_notes_for_recipient, h_actions, h_used, h_amounts⟩ :=
    spendable_notes bob h_note_in_scan h_not_used h_amount_ne_zero (by
      apply List.Nodup.filter
      apply List.Nodup.filter
      apply scan_notes_for_recipient₀.nodup bob.h_k
    )
  use rm'

  have h_extends : rm'.extends rm := by simp [ReachableMemory.extends, h_actions]
  use h_extends

  intro token
  simp only [sum_create_note_use_note (bob:=bob.extend h_extends), Nat.add_eq_left]
  apply List.sum_eq_zero
  intro amount h
  have ⟨sn, h⟩ := List.mem_map.1 h
  rw [List.mem_filter, List.mem_filter] at h
  simp only [decide_eq_true_eq] at h
  have ⟨⟨⟨h₀, h₁⟩, h₂⟩, h₃⟩ := h
  rw [←h₃, h_amounts]
  rw [h_scan_notes_for_recipient] at h₀

  have : rm'.m MemoryType.Nullifiers [crypto.hash [sn.c, token, sn.i, bob.k]] = 0 := by
    by_contra h_nullifier_nz
    exact h_nullifier_nz (h₁ ▸ h₂)

  have : rm.m MemoryType.Nullifiers [crypto.hash [sn.c, token, sn.i, bob.k]] = 0 := by
    rw [←h₁] at *
    by_contra h_nullifier_nz
    exact note_used_monotone_extend h_extends h_nullifier_nz this

  by_contra h_amount_ne_zero
  have h_sn_in_sns : sn ∈ sns := by
    rw [List.mem_filter, List.mem_filter]
    simp [*]

  have := h_used sn h_sn_in_sns
  rw [h₁] at this
  contradiction
