import privacy.utils
import privacy.actions
import privacy.notes.notes
import privacy.notes.note_implies
import privacy.subchannels.subchannels

def note_used (crypto: Crypto) (m: Memory) (c token i kbob: ℕ) : Prop :=
  m .Nullifiers [crypto.hash [c, token, i, kbob]] ≠ 0

structure UseImplies₀
    {crypto: Crypto} (rm: ReachableMemory crypto) (inp: UseNoteInput) where
  h_action: .UseNote inp ∈ rm.actions
  (addralice kalice r_create amount_create: ℕ)
  amount_nz: inp.amount ≠ 0
  kbob_priv: inp.kbob ∈ crypto.PrivateKeys

abbrev UseImplies₀.inp_create
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    (self: UseImplies₀ rm inp) : CreateNoteInput :=
  ⟨self.addralice, self.kalice, inp.addrbob, crypto.priv_to_pub inp.kbob, inp.token, inp.i, self.r_create, self.amount_create⟩

structure UseImplies
    {crypto: Crypto} (rm: ReachableMemory crypto) (inp: UseNoteInput)
    extends UseImplies₀ rm inp where
  h_note_used: note_used crypto rm.m inp.c inp.token inp.i inp.kbob
  note_created: NoteImplies rm (toUseImplies₀.inp_create)
  h_c: toUseImplies₀.inp_create.c crypto = inp.c

theorem UseImplies.h_note_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    (use_imp: UseImplies rm inp) :
    rm.m .Notes [inp.note_id crypto, 0] ≠ 0 := by
  have := use_imp.note_created.h_note_exists
  unfold note_exists CreateNoteInput.note_id at this
  simp only [use_imp.h_c] at this
  exact this

theorem UseImplies.h_kbob₀
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    (use_imp: UseImplies rm inp) :
    use_imp.note_created.subchannel.channel.kbob = inp.kbob := by
  apply crypto.priv_to_pub_inj use_imp.note_created.subchannel.channel.kbob.prop use_imp.kbob_priv
  rw [use_imp.note_created.h_Kbob]

theorem UseImplies.h_kbob₁
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    (use_imp: UseImplies rm inp) :
    rm.m .PublicKeys [inp.addrbob] = crypto.priv_to_pub inp.kbob := by
  rw [use_imp.note_created.subchannel.channel.bob_registered.public_key, ←h_kbob₀]

theorem UseImplies.next
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    {action: Action} (success: (run_action crypto action rm.m).success)
    (use_imp: UseImplies rm inp) :
    Nonempty (UseImplies (rm.add action success) inp) := by
  let res : UseImplies₀ (rm.add action success) inp := {
    h_action := by simp [use_imp.h_action]
    addralice := use_imp.addralice
    kalice := use_imp.kalice
    r_create := use_imp.r_create
    amount_create := use_imp.amount_create
    amount_nz := use_imp.amount_nz
    kbob_priv := use_imp.kbob_priv
  }

  cases action
  case UseNote inp' =>
    let info := use_note_info crypto inp' rm success
    have : inp.nullifier crypto ≠ inp'.nullifier crypto := by
      by_contra h
      have := use_imp.h_note_used
      rw [note_used, ←UseNoteInput.nullifier, h] at this
      exact this info.nullifier_didnt_exist
    exact ⟨{
      toUseImplies₀ := res,
      h_note_used := by
        rw [ReachableMemory.add_m, run_action, ←info.h_m', note_used]
        rw [info.no_change _ _ (by simp [this])]
        exact use_imp.h_note_used
      note_created := Nonempty.some (use_imp.note_created.next success)
      h_c := use_imp.h_c
    }⟩

  all_goals exact ⟨{
    toUseImplies₀ := res,
    h_note_used := use_imp.h_note_used
    note_created := Nonempty.some (use_imp.note_created.next success)
    h_c := use_imp.h_c
  }⟩

theorem UseImplies.from_action
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    (h: .UseNote inp ∈ rm.actions) :
    Nonempty (UseImplies rm inp) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h
  cases h

  case head =>
    let info := use_note_info crypto inp rm success
    have ⟨inp_create, note_imp, h_note_id⟩ := NoteImplies.from_note_exists info.r_ne_zero
    have ⟨addralice, ⟨subchannel_imp⟩⟩ := SubchannelImplies.from_subchannel_marker_exists info.subchannel_exists

    let res : UseImplies₀ (rm.add (.UseNote inp) success) inp := {
      h_action := by simp
      addralice := inp_create.addralice
      kalice := inp_create.kalice
      r_create := inp_create.r
      amount_create := inp_create.amount
      amount_nz := info.amount_ne_zero
      kbob_priv := info.kbob_private_key
    }

    have h_inp_create: inp.c = inp_create.c crypto ∧ inp_create = res.inp_create := by
      unfold UseImplies₀.inp_create
      have := crypto.h_hash (Eq.symm h_note_id)
      injections
      simp only [*, true_and]

      have := calc subchannel_imp.channel.c
        _ = inp.c := by simp [subchannel_imp.h_c]
        _ = inp_create.c crypto := by assumption
      have ⟨_, _, h_addrbob, h_kbob⟩ := subchannel_imp.channel.same_c this
      simp only [UseNoteInput.Kbob] at h_addrbob h_kbob
      rw [←h_addrbob, ←h_kbob]

    exact ⟨{
      toUseImplies₀ := res,
      h_note_used := by rw [rm.add_m, run_action, ←info.h_m', note_used, info.memory_diff₀]; simp
      note_created := h_inp_create.2 ▸ note_imp.next success |>.some
      h_c := by simp [h_inp_create]
    }⟩

  case tail h => exact (ih h |>.some).next success

theorem UseImplies.from_note_used
    {crypto: Crypto} {rm: ReachableMemory crypto} {c token i kbob: ℕ}
    (h: note_used crypto rm c token i kbob) :
    ∃ addrbob amount, Nonempty (UseImplies rm ⟨c, addrbob, kbob, token, i, amount⟩) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success h
  cases action
  case UseNote inp =>
    let info := use_note_info crypto inp rm success
    have ⟨kalice, ⟨subchannel_imp⟩⟩ := SubchannelImplies.from_subchannel_marker_exists info.subchannel_exists
    by_cases h_is_same : crypto.hash [c, token, i, kbob] = inp.nullifier crypto
    case pos =>
      use inp.addrbob, inp.amount
      have := crypto.h_hash h_is_same
      repeat injection this with _ this
      apply UseImplies.from_action
      simp [*]
    case neg =>
      rw [note_used, ReachableMemory.add_m, run_action, ←info.h_m'] at h
      rw [info.no_change _ _ (by simp [h_is_same])] at h
      have ⟨addrbob, amount, ⟨use_imp⟩⟩ := ih h
      exact ⟨addrbob, amount, use_imp.next success⟩

  all_goals
    have ⟨addrbob, amount, ⟨use_imp⟩⟩ := ih h
    exact ⟨addrbob, amount, use_imp.next success⟩

def used_note_actions (crypto: Crypto) (rm: ReachableMemory crypto) : List UseNoteInput :=
  rm.actions.filterMap filter_UseNote

theorem used_note_actions_add
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    (success: (run_action crypto (.UseNote inp) rm.m).success) :
    (used_note_actions crypto (rm.add (.UseNote inp) success)) =
    inp :: used_note_actions crypto rm := by
  simp [used_note_actions]

theorem UseImplies.in_used_note_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    (note_imp: UseImplies rm inp) :
    inp ∈ used_note_actions crypto rm := by
  simp [used_note_actions]
  use .UseNote inp
  simp [note_imp.h_action]

theorem UseImplies.from_used_note_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: UseNoteInput}
    (h: inp ∈ used_note_actions crypto rm) :
    Nonempty (UseImplies rm inp) := by
  simp only [used_note_actions, List.mem_filterMap, filter_UseNote_some, exists_eq_right] at h
  exact UseImplies.from_action h

theorem note_used_monotone_extend
    {crypto: Crypto} {rm rm': ReachableMemory crypto}
    (h_extends: rm'.extends rm)
    (h: note_used crypto rm c token i kbob) :
    note_used crypto rm' c token i kbob := by
  have ⟨addrbob, amount, ⟨use_imp⟩⟩ := UseImplies.from_note_used h
  have ⟨ℓ, h_extends⟩ := h_extends
  have := h_extends ▸ (List.mem_append (s:=ℓ)).2 (Or.inr use_imp.h_action)
  exact (UseImplies.from_action this |>.some).h_note_used
