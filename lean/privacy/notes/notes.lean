import privacy.actions
import privacy.utils
import privacy.transactions.immutability

def note_exists (m: Memory) (note_id: ℕ) : Prop :=
    m .Notes [note_id, 0] ≠ 0

-- OpenDeposit doesn't affect `note_exists`.
theorem note_exists_open_deposit {crypto: Crypto} {rm: ReachableMemory crypto}
    (success: (run_action crypto (.OpenDeposit inp) rm.m).success) (note_id: ℕ) :
    note_exists (rm.add (.OpenDeposit inp) success) note_id ↔ note_exists rm note_id := by
  unfold note_exists at *

  let info := open_deposit_info crypto inp rm success
  rw [ReachableMemory.add_m, run_action, ←info.h_m']
  by_cases h₀ : note_id = inp.note_id
  case pos =>
    have note_existed : rm.m MemoryType.Notes [inp.note_id, 0] ≠ 0 := by
      rw [info.old_value]
      apply crypto.pack_nz
      simp
    simp [h₀, info.memory_diff₀, note_existed, crypto.pack_nz]
  case neg =>
    rw [info.no_change _ _ (by simp [h₀])]

-- Once a note exists, it stays this way.
theorem note_exists_monotone {crypto: Crypto} {rm: ReachableMemory crypto} {action: Action}
    (success: (run_action crypto action rm.m).success)
    {note_id : ℕ}
    (h : note_exists rm note_id) :
    note_exists (rm.add action success) note_id := by
  cases action
  case CreateNote inp =>
    unfold note_exists at *
    let info := create_note_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    by_cases h₀ : note_id = inp.note_id crypto
    case pos =>
      rw [h₀, info.memory_diff₀]
      exact crypto.pack_nz info.r_ne_zero
    case neg => rwa [info.no_change _ _ (by simp [h₀]) (by simp)]

  case OpenDeposit inp => exact (note_exists_open_deposit success note_id).2 h

  all_goals exact h

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
