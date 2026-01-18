import privacy.utils
import privacy.actions
import privacy.notes.notes
import privacy.notes.note_implies
import privacy.subchannels.subchannels

def note_canceled (crypto: Crypto) (m: Memory) (c token i₀ i₁ kbob: ℕ) : Prop :=
  m .Nullifiers [crypto.hash [c, token, i₀, i₁, kbob]] ≠ 0

structure CancelImplies₀
    {crypto: Crypto} (rm: ReachableMemory crypto) (inp: CancelNoteInput) where
  h_action: .CancelNote inp ∈ rm.actions
  (addralice kalice r_create amount_create: ℕ)
  amount_nz: inp.amount ≠ 0
  h_kbob: inp.kbob ∈ crypto.PrivateKeys

abbrev CancelImplies₀.inp_create
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (self: CancelImplies₀ rm inp) : CreateNoteInput :=
  ⟨self.addralice, self.kalice, inp.addrbob, crypto.priv_to_pub inp.kbob, inp.token, inp.i₀, inp.i₁, self.r_create, self.amount_create⟩

structure CancelImplies
    {crypto: Crypto} (rm: ReachableMemory crypto) (inp: CancelNoteInput)
    extends CancelImplies₀ rm inp where
  h_note_canceled: note_canceled crypto rm.m inp.c inp.token inp.i₀ inp.i₁ inp.kbob
  note_created: NoteImplies rm (toCancelImplies₀.inp_create)
  h_c: toCancelImplies₀.inp_create.c crypto = inp.c

theorem CancelImplies.h_note_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (cancel_imp: CancelImplies rm inp) :
    rm.m .Notes [inp.note_id crypto, 0] ≠ 0 := by
  have := cancel_imp.note_created.h_note_exists
  unfold note_exists CreateNoteInput.note_id at this
  simp only [cancel_imp.h_c] at this
  exact this

theorem CancelImplies.h_kbob'
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (cancel_imp: CancelImplies rm inp) :
    cancel_imp.note_created.subchannel.channel.kbob = inp.kbob := by
  apply crypto.priv_to_pub_inj cancel_imp.note_created.subchannel.channel.kbob.prop cancel_imp.h_kbob
  rw [cancel_imp.note_created.h_Kbob]

theorem CancelImplies.next
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    {action: Action} (success: (run_action crypto action rm.m).success)
    (cancel_imp: CancelImplies rm inp) :
    Nonempty (CancelImplies (rm.add action success) inp) := by
  let res : CancelImplies₀ (rm.add action success) inp := {
    h_action := by simp [cancel_imp.h_action]
    addralice := cancel_imp.addralice
    kalice := cancel_imp.kalice
    r_create := cancel_imp.r_create
    amount_create := cancel_imp.amount_create
    amount_nz := cancel_imp.amount_nz
    h_kbob := cancel_imp.h_kbob
  }

  cases action
  case CancelNote inp' =>
    let info := cancel_note_info crypto inp' rm success
    have : inp.nullifier crypto ≠ inp'.nullifier crypto := by
      by_contra h
      have := cancel_imp.h_note_canceled
      rw [note_canceled, ←CancelNoteInput.nullifier, h] at this
      exact this info.nullifier_didnt_exist
    exact ⟨{
      toCancelImplies₀ := res,
      h_note_canceled := by
        rw [ReachableMemory.add_m, run_action, ←info.h_m', note_canceled]
        rw [info.no_change _ _ (by simp [this])]
        exact cancel_imp.h_note_canceled
      note_created := Nonempty.some (cancel_imp.note_created.next success)
      h_c := cancel_imp.h_c
    }⟩

  all_goals exact ⟨{
    toCancelImplies₀ := res,
    h_note_canceled := cancel_imp.h_note_canceled
    note_created := Nonempty.some (cancel_imp.note_created.next success)
    h_c := cancel_imp.h_c
  }⟩

theorem CancelImplies.from_action
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (h: .CancelNote inp ∈ rm.actions) :
    Nonempty (CancelImplies rm inp) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h
  cases h

  case head =>
    let info := cancel_note_info crypto inp rm success
    have ⟨inp_create, note_imp, h_note_id⟩ := NoteImplies.from_note_exists info.r_ne_zero
    have ⟨addralice, ⟨subchannel_imp⟩⟩ := SubchannelImplies.from_subchannel_hash_exists info.subchannel_exists

    let res : CancelImplies₀ (rm.add (.CancelNote inp) success) inp := {
      h_action := by simp
      addralice := inp_create.addralice
      kalice := inp_create.kalice
      r_create := inp_create.r
      amount_create := inp_create.amount
      amount_nz := info.amount_ne_zero
      h_kbob := info.kbob_private_key
    }

    have h_inp_create: inp.c = inp_create.c crypto ∧ inp_create = res.inp_create := by
      unfold CancelImplies₀.inp_create
      have := crypto.h_hash (Eq.symm h_note_id)
      injections
      simp only [*, true_and]

      have := calc subchannel_imp.channel.c
        _ = inp.c := by simp [subchannel_imp.h_c]
        _ = inp_create.c crypto := by assumption
      have ⟨_, _, h_addrbob, h_kbob⟩ := subchannel_imp.channel.same_c this
      simp only [CancelNoteInput.Kbob] at h_addrbob h_kbob
      rw [←h_addrbob, ←h_kbob]

    exact ⟨{
      toCancelImplies₀ := res,
      h_note_canceled := by rw [rm.add_m, run_action, ←info.h_m', note_canceled, info.memory_diff₀]; simp
      note_created := h_inp_create.2 ▸ note_imp.next success |>.some
      h_c := by simp [h_inp_create]
    }⟩

  case tail h => exact (ih h |>.some).next success

theorem CancelImplies.from_note_canceled
    {crypto: Crypto} {rm: ReachableMemory crypto} {c token i₀ i₁ kbob: ℕ}
    (h: note_canceled crypto rm c token i₀ i₁ kbob) :
    ∃ addrbob amount, Nonempty (CancelImplies rm ⟨c, addrbob, kbob, token, i₀, i₁, amount⟩) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success h
  cases action
  case CancelNote inp =>
    let info := cancel_note_info crypto inp rm success
    have ⟨kalice, ⟨subchannel_imp⟩⟩ := SubchannelImplies.from_subchannel_hash_exists info.subchannel_exists
    by_cases h_is_same : crypto.hash [c, token, i₀, i₁, kbob] = inp.nullifier crypto
    case pos =>
      use inp.addrbob, inp.amount
      have := crypto.h_hash h_is_same
      repeat injection this with _ this
      apply CancelImplies.from_action
      simp [*]
    case neg =>
      rw [note_canceled, ReachableMemory.add_m, run_action, ←info.h_m'] at h
      rw [info.no_change _ _ (by simp [h_is_same])] at h
      have ⟨addrbob, amount, ⟨cancel_imp⟩⟩ := ih h
      exact ⟨addrbob, amount, cancel_imp.next success⟩

  all_goals
    have ⟨addrbob, amount, ⟨cancel_imp⟩⟩ := ih h
    exact ⟨addrbob, amount, cancel_imp.next success⟩

def cancel_note_actions (crypto: Crypto) (rm: ReachableMemory crypto) : List CancelNoteInput :=
  rm.actions.filterMap filter_CancelNote

theorem cancel_note_actions_add
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (success: (run_action crypto (.CancelNote inp) rm.m).success) :
    (cancel_note_actions crypto (rm.add (.CancelNote inp) success)) =
    inp :: cancel_note_actions crypto rm := by
  simp [cancel_note_actions]

theorem CancelImplies.in_cancel_note_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (note_imp: CancelImplies rm inp) :
    inp ∈ cancel_note_actions crypto rm := by
  simp [cancel_note_actions]
  use .CancelNote inp
  simp [note_imp.h_action]

theorem CancelImplies.from_cancel_note_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CancelNoteInput}
    (h: inp ∈ cancel_note_actions crypto rm) :
    Nonempty (CancelImplies rm inp) := by
  simp only [cancel_note_actions, List.mem_filterMap, filter_CancelNote_some, exists_eq_right] at h
  exact CancelImplies.from_action h

theorem note_canceled_monotone_extends
    {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm)
    (h: note_canceled crypto rm c token i₀ i₁ kbob) :
    note_canceled crypto rm' c token i₀ i₁ kbob := by
  have ⟨addrbob, amount, ⟨cancel_imp⟩⟩ := CancelImplies.from_note_canceled h
  have ⟨ℓ, h_extends⟩ := h_extends
  have := h_extends ▸ (List.mem_append (s:=ℓ)).2 (Or.inr cancel_imp.h_action)
  exact (CancelImplies.from_action this |>.some).h_note_canceled
