import privacy.actions
import privacy.subchannels.subchannels
import privacy.notes.notes
import privacy.utils

structure NoteImplies {crypto: Crypto} (rm: ReachableMemory crypto) (inp: CreateNoteInput) where
  h_action: .CreateNote inp ∈ rm.actions
  h_i₀: inp.i₀ < crypto.MAX_I₀
  subchannel: SubchannelImplies rm (inp.c crypto) inp.addralice inp.addrbob inp.Kbob inp.token
  h_note_exists: note_exists rm (inp.note_id crypto)
  h_open_note: inp.r = 1 → rm.m .OpenNoteToken [inp.note_id crypto] = inp.token ∧ inp.amount = 0
  h_r: (crypto.unpack (rm.m .Notes [inp.note_id crypto, 0])).1 = inp.r

theorem NoteImplies.h_kalice
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    inp.kalice = note_imp.subchannel.kalice := by
  simp [note_imp.subchannel.channel.same_c (Eq.symm note_imp.subchannel.h_c)]

theorem NoteImplies.h_Kbob
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp) :
    crypto.priv_to_pub note_imp.subchannel.channel.kbob = inp.Kbob := by
  rw [←note_imp.subchannel.channel.h_Kbob]

theorem NoteImplies.next
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    {action: Action} (success: (run_action crypto action rm.m).success)
    (note_imp: NoteImplies rm inp) :
    Nonempty (NoteImplies (rm.add action success) inp) := by
  cases action
  case CreateNote inp' =>
    let info := create_note_info crypto inp' rm success
    have h_note_id : inp.note_id crypto ≠ inp'.note_id crypto :=
        λ h_note_id ↦ absurd (h_note_id ▸ info.old_value_was_zero) note_imp.h_note_exists

    constructor; constructor
    case h_action => simp [note_imp.h_action]
    case h_i₀ => exact note_imp.h_i₀
    case subchannel => exact Nonempty.some (note_imp.subchannel.next success)
    case h_note_exists => exact note_exists_monotone success note_imp.h_note_exists

    all_goals
      rw [ReachableMemory.add_m, run_action, ←info.h_m']
      rw [info.no_change _ _ (by simp [h_note_id]) (by simp [h_note_id])]

    case h_open_note => exact note_imp.h_open_note
    case h_r => exact note_imp.h_r

  case OpenDeposit inp' =>
    let info := open_deposit_info crypto inp' rm success

    refine ⟨{
      h_action := by simp [note_imp.h_action],
      h_i₀ := note_imp.h_i₀,
      subchannel := Nonempty.some (note_imp.subchannel.next success),
      h_note_exists := note_exists_monotone success note_imp.h_note_exists,
      h_open_note := note_imp.h_open_note,
      h_r := ?_,
    }⟩

    have h_r := note_imp.h_r
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h_is_same: inp.note_id crypto = inp'.note_id
    case pos =>
      rw [h_is_same, info.old_value] at h_r
      rw [h_is_same, info.memory_diff₀, ←h_r, crypto.unpack_pack, crypto.unpack_pack]
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same])]
      exact h_r

  all_goals exact ⟨{
    h_action := by simp [note_imp.h_action],
    h_i₀ := note_imp.h_i₀,
    subchannel := Nonempty.some (note_imp.subchannel.next success),
    h_note_exists := note_exists_monotone success note_imp.h_note_exists,
    h_open_note := note_imp.h_open_note,
    h_r := note_imp.h_r,
  }⟩

theorem NoteImplies.from_action
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (h: .CreateNote inp ∈ rm.actions) :
    Nonempty (NoteImplies rm inp) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h
  cases h
  case head =>
    let info := create_note_info crypto inp rm success
    have ⟨addralice, ⟨subchannel_imp⟩⟩ := SubchannelImplies.from_subchannel_marker_exists info.subchannel_exists
    have h_addralice: inp.addralice = addralice := by
      simp [subchannel_imp.channel.same_c (Eq.symm subchannel_imp.h_c)]

    constructor; constructor

    case h_action => simp
    case h_i₀ => exact info.i₀_lt_MAX_I₀
    case subchannel => rw [h_addralice]; exact Nonempty.some (subchannel_imp.next success)
    case h_note_exists =>
      rw [ReachableMemory.add_m, run_action, ←info.h_m', note_exists, info.memory_diff₀]
      exact crypto.pack_nz info.r_ne_zero
    case h_open_note =>
      intro r_eq_one
      rw [ReachableMemory.add_m, run_action, ←info.h_m', info.memory_diff₁]
      simp [r_eq_one, info.h_open_note_amount_zero]
    case h_r =>
      rw [ReachableMemory.add_m, run_action, ←info.h_m', info.memory_diff₀]
      rw [crypto.unpack_pack]

  case tail h =>
    have ⟨ih⟩ := ih h
    exact ih.next success

theorem NoteImplies.from_note_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {note_id: ℕ}
    (h_note_exists: note_exists rm note_id) :
    ∃ (inp: CreateNoteInput) (_: NoteImplies rm inp), inp.note_id crypto = note_id := by
  suffices h' : ∃ inp: CreateNoteInput, .CreateNote inp ∈ rm.actions ∧ inp.note_id crypto = note_id from by
    obtain ⟨inp, h'⟩ := h'
    have ⟨note_imp⟩ := NoteImplies.from_action h'.1
    use inp, note_imp
    simp [h'.2]

  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success
  cases action
  case CreateNote inp =>
    let info := create_note_info crypto inp rm success
    by_cases h_note_id : note_id = inp.note_id crypto
    case pos => simp [h_note_id]
    case neg =>
      intro h_note_exists
      have : note_exists rm.m note_id := by
        unfold note_exists at *
        rw [ReachableMemory.add_m, run_action, ←info.h_m'] at h_note_exists
        rw [info.no_change _ _ (by simp [h_note_id]) (by simp)] at h_note_exists
        exact h_note_exists
      obtain ⟨inp, ih₀, ih₁⟩ := ih this
      exact ⟨inp, by simp [ih₀], ih₁⟩

  case OpenDeposit inp' =>
    rw [note_exists_open_deposit success]
    intro h
    obtain ⟨inp, ih₀, ih₁⟩ := ih h
    exact ⟨inp, by simp [ih₀], ih₁⟩

  all_goals
    intro h
    obtain ⟨inp, ih₀, ih₁⟩ := ih h
    exact ⟨inp, by simp [ih₀], ih₁⟩

theorem NoteImplies.from_open_note_event
    {crypto: Crypto} {rm: ReachableMemory crypto} {note_id user_enc: ℕ}
    (h_event: .CreateOpenNote note_id user_enc ∈ rm.events) :
    ∃ (inp: CreateNoteInput) (_: NoteImplies rm inp),
      inp.note_id crypto = note_id ∧
      inp.r = 1 ∧
      user_enc = crypto.enc crypto.council_pub_key [inp.addrbob] := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h_event
  rw [ReachableMemory.add_events, List.mem_append] at h_event
  cases h_event
  case inl h_event =>
    have ⟨inp, note_imp, h⟩ := ih h_event
    exact ⟨inp, note_imp.next success |>.some, h⟩
  case inr h_event =>
    cases action
    case CreateNote inp =>
      let info := create_note_info crypto inp rm success

      by_cases h_r: inp.r = 1
      case pos =>
        have ⟨note_imp⟩ := NoteImplies.from_action (rm:=rm.add (.CreateNote inp) success) (inp:=inp) (h:=by simp)
        simp only [run_action, info.events₁ h_r, List.mem_cons, Event.CreateOpenNote.injEq,
          List.not_mem_nil, or_false] at h_event
        refine ⟨inp, note_imp, by simp [h_event], h_r, h_event.2⟩
      case neg =>
        rw [run_action, info.events₀ h_r] at h_event
        contradiction

    all_goals contradiction
