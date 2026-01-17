import privacy.utils
import privacy.actions
import privacy.notes.notes
import privacy.notes.scanned_note
import privacy.notes.create_note_actions

structure OpenDepositImplies
    {crypto: Crypto} (rm: ReachableMemory crypto) (inp: OpenDepositInput) where
  h_action: .OpenDeposit inp ∈ rm.actions
  inp_create: CreateNoteInput
  created: NoteImplies rm inp_create
  h_note_id: inp_create.note_id crypto = inp.note_id
  h_r : inp_create.r = 1
  h_token: inp_create.token = inp.token
  value: rm.m .Notes [inp_create.note_id crypto, 0] = crypto.pack 1 inp.amount
  amount_nz: inp.amount ≠ 0

theorem OpenDepositImplies.token_eq_sn
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp_deposit: OpenDepositInput}
    (open_deposit_imp: OpenDepositImplies rm inp_deposit)
    {sn: ScannedNote}
    (h_note_id: inp_deposit.note_id = sn.note_id crypto) :
    inp_deposit.token = sn.token := by
  rw [←open_deposit_imp.h_note_id] at h_note_id
  have := CreateNoteInput.to_scanned_note_eq h_note_id
  rw [←this, ←open_deposit_imp.h_token]

theorem OpenDepositImplies.next
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenDepositInput}
    {action: Action} (success: (run_action crypto action rm.m).success)
    (open_deposit_imp: OpenDepositImplies rm inp) :
    Nonempty (OpenDepositImplies (rm.add action success) inp) := by
  refine ⟨{
    h_action := by simp [open_deposit_imp.h_action],
    inp_create := open_deposit_imp.inp_create,
    created := open_deposit_imp.created.next success |>.some,
    h_note_id := open_deposit_imp.h_note_id,
    h_r := open_deposit_imp.h_r,
    h_token := open_deposit_imp.h_token,
    value := ?_,
    amount_nz := open_deposit_imp.amount_nz,
  }⟩

  cases action
  case CreateNote inp' =>
    let info := create_note_info crypto inp' rm success
    have : inp.note_id ≠ inp'.note_id crypto := by
      intro h_note_id
      have := open_deposit_imp.value
      rw [open_deposit_imp.h_note_id, h_note_id, info.old_value_was_zero] at this
      exact crypto.pack_nz (by simp) this.symm

    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    rw [info.no_change _ _ (by simp [open_deposit_imp.h_note_id ▸ this]) (by simp)]
    exact open_deposit_imp.value

  case OpenDeposit inp' =>
    let info := open_deposit_info crypto inp' rm success
    have : inp.note_id ≠ inp'.note_id := by
      intro h_note_id
      have := open_deposit_imp.value
      rw [open_deposit_imp.h_note_id, h_note_id, info.old_value] at this
      apply congrArg crypto.unpack at this
      simp only [crypto.unpack_pack, Prod.mk.injEq, true_and] at this
      exact open_deposit_imp.amount_nz this.symm

    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    rw [info.no_change _ _ (by simp [open_deposit_imp.h_note_id ▸ this])]
    exact open_deposit_imp.value

  all_goals exact open_deposit_imp.value

theorem OpenDepositImplies.from_action
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenDepositInput}
    (h: .OpenDeposit inp ∈ rm.actions) :
    Nonempty (OpenDepositImplies rm inp) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h
  cases h

  case head =>
    let info := open_deposit_info crypto inp rm success

    have h_note_exists : rm.m MemoryType.Notes [inp.note_id, 0] ≠ 0 := by
      rw [info.old_value]
      exact crypto.pack_nz (by simp)

    have ⟨create_inp, note_imp, h_note_id⟩ := NoteImplies.from_note_exists h_note_exists

    have h_r : create_inp.r = 1 := by
      have := note_imp.h_r.symm
      rw [h_note_id, info.old_value, crypto.unpack_pack] at this
      exact this

    exact ⟨{
      h_action := by simp,
      inp_create := create_inp,
      created := note_imp.next success |>.some,
      h_note_id := h_note_id,
      h_r := h_r,
      h_token := by
        rw [←info.open_note_token, ←h_note_id, (note_imp.h_open_note h_r).1]
      value := by
        rw [ReachableMemory.add_m, run_action, ←info.h_m']
        rw [h_note_id, info.memory_diff₀]
      amount_nz := info.amount_ne_zero
    }⟩

  case tail h =>
    have ⟨ih⟩ := ih h
    exact ih.next success

def open_deposit_actions (crypto: Crypto) (rm: ReachableMemory crypto) : List OpenDepositInput :=
  rm.actions.filterMap filter_OpenDeposit

-- Deposit action implies the note exists.
theorem OpenDepositImplies.from_open_deposit_actions
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenDepositInput}
    (h: inp ∈ open_deposit_actions crypto rm) :
    Nonempty (OpenDepositImplies rm inp) := by
  simp only [open_deposit_actions, List.mem_filterMap, filter_OpenDeposit_some, exists_eq_right] at h
  exact OpenDepositImplies.from_action h

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
  have ⟨open_deposit_imp⟩ := OpenDepositImplies.from_open_deposit_actions h'
  exact λ h'' ↦ h (h'' ▸ open_deposit_imp.h_note_id ▸ open_deposit_imp.created.h_note_exists)

theorem sum_deposits_for_note_id_eq_zero₁
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateNoteInput}
    (note_imp: NoteImplies rm inp)
    (h_r: inp.r ≠ 1) :
    sum_deposits_for_note_id crypto rm (inp.note_id crypto) = 0 := by
  unfold sum_deposits_for_note_id
  convert List.sum_nil
  simp only [List.map_eq_nil_iff, List.filter_eq_nil_iff, decide_eq_true_eq]
  intro inp_deposit h' h_note_id
  have ⟨open_deposit_imp⟩ := OpenDepositImplies.from_open_deposit_actions h'

  have := note_imp.h_r
  rw [←h_note_id, ←open_deposit_imp.h_note_id] at this
  rw [open_deposit_imp.value] at this
  rw [crypto.unpack_pack] at this
  simp [←this] at h_r

theorem sum_deposits_for_note_id_next
    {crypto: Crypto} {rm: ReachableMemory crypto} {note_id: ℕ}
    (success: (run_action crypto (.OpenDeposit inp) rm.m).success) :
    sum_deposits_for_note_id crypto (rm.add (.OpenDeposit inp) success) note_id =
    sum_deposits_for_note_id crypto rm note_id +
    (if inp.note_id = note_id then inp.amount else 0) := by
  simp only [sum_deposits_for_note_id, ReachableMemory.add, open_deposit_actions]
  simp only [List.filter_filterMap, List.map_filterMap]
  rw [←List.singleton_append, List.filterMap_append, List.sum_append]
  conv => lhs; rw [add_comm]
  simp only [Nat.add_left_cancel_iff]
  by_cases h : inp.note_id = note_id
  case pos => simp [h]
  case neg => simp [h]

def is_open_note (crypto: Crypto) (m: Memory) (note_id: ℕ) : Bool :=
  (crypto.unpack (m .Notes [note_id, 0])).1 = 1
