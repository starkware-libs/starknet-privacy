import privacy.utils
import privacy.actions
import privacy.notes.notes
import privacy.notes.scanned_note
import privacy.notes.create_note_actions

def open_deposit_actions (crypto: Crypto) (rm: ReachableMemory crypto) : List OpenDepositInput :=
  rm.actions.flatMap (λ action ↦ match action with
    | .OpenDeposit inp => [inp]
    | _ => []
  )

-- Deposit action implies the note exists.
theorem deposit_action_implies
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenDepositInput}
    (h_inp: inp ∈ open_deposit_actions crypto rm) :
    note_exists rm inp.note_id := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h_inp
  cases action
  all_goals simp only [open_deposit_actions, ReachableMemory.add, List.flatMap_cons, List.cons_append,
      List.nil_append, List.mem_cons, List.mem_flatMap] at h_inp ih
  case OpenDeposit inp' =>
    let info := open_deposit_info crypto inp' rm success
    cases h_inp

    case inl h_inp =>
      -- inp is the new action
      dsimp only [note_exists]
      rw [ReachableMemory.add_m, run_action, ←info.h_m', h_inp, info.memory_diff₀]
      exact crypto.pack_nz (by simp)

    case inr h_inp =>
      -- inp is an old action
      exact note_exists_monotone success (ih h_inp)

  case CreateNote inp' =>
    exact note_exists_monotone success (ih h_inp)

  all_goals exact ih h_inp

def sum_deposits_for_note_id (crypto: Crypto) (rm: ReachableMemory crypto) (note_id: ℕ): ℕ :=
  open_deposit_actions crypto rm
  |>.filter (λ inp ↦ inp.note_id = note_id)
  |>.map (λ inp ↦ inp.amount)
  |>.sum

theorem sum_deposits_for_note_id_eq_zero
    {crypto: Crypto} {rm: ReachableMemory crypto} {note_id: ℕ}
    (h: ¬note_exists rm note_id) :
    sum_deposits_for_note_id crypto rm note_id = 0 := by
  unfold sum_deposits_for_note_id
  convert List.sum_nil
  simp only [List.map_eq_nil_iff, List.filter_eq_nil_iff, decide_eq_true_eq]
  intro inp_deposit h'
  exact λ h'' ↦ h (h'' ▸ deposit_action_implies h')

theorem sum_deposits_for_note_id_next
    {crypto: Crypto} {rm: ReachableMemory crypto} {note_id: ℕ}
    (success: (run_action crypto (.OpenDeposit inp) rm.m).success) :
    sum_deposits_for_note_id crypto (rm.add (.OpenDeposit inp) success) note_id =
    sum_deposits_for_note_id crypto rm note_id +
    (if inp.note_id = note_id then inp.amount else 0) := by
  simp only [sum_deposits_for_note_id, ReachableMemory.add, open_deposit_actions, List.flatMap_cons,
    List.filter_append, List.map_append, List.sum_append]
  conv => lhs; rw [add_comm]
  simp only [Nat.add_left_cancel_iff]
  by_cases h : inp.note_id = note_id
  case pos => simp [h]
  case neg => simp [h]

theorem deposit_action_token
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp_deposit: OpenDepositInput}
    (h_inp_deposit: inp_deposit ∈ open_deposit_actions crypto rm)
    {sn: ScannedNote}
    (h_note_id: inp_deposit.note_id = sn.note_id crypto) :
    inp_deposit.token = sn.token := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h_inp_deposit; contradiction

  intro action rm ih success h_inp_deposit
  cases action
  case OpenDeposit inp_deposit' =>
    let info := open_deposit_info crypto inp_deposit' rm success

    simp only [open_deposit_actions, ReachableMemory.add, List.flatMap_cons, List.cons_append,
      List.nil_append, List.mem_cons, List.mem_flatMap] at h_inp_deposit ih

    cases h_inp_deposit
    case inl h_inp_deposit =>
      rw [h_inp_deposit, ←info.open_note_token]
      have h_note_exists : note_exists rm inp_deposit'.note_id := by
        simp [note_exists, info.old_value, crypto.pack_nz]
      have ⟨inp_create_note, note_imp, h_note_id'⟩ := NoteImplies.from_note_exists h_note_exists
      rw [←h_note_id']
      have h_r := note_imp.h_r
      rw [h_note_id', info.old_value, crypto.unpack_pack] at h_r
      rw [note_imp.h_open_note (by simp [←h_r])]
      rw [←h_inp_deposit, h_note_id] at h_note_id'
      rw [←CreateNoteInput.to_scanned_note_eq h_note_id']

    case inr h_inp_deposit =>
      exact ih h_inp_deposit

  all_goals exact ih h_inp_deposit
