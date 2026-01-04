import privacy.actions
import privacy.channels.channels
import privacy.utils

theorem subchannel_hash_exists_implies_hash
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addrbob Kbob token: ℕ}
    (h: rm.m .SubchannelHashes [crypto.hash [c, addrbob, Kbob, token]] ≠ 0) :
    ∃ (addralice kalice: ℕ), c = crypto.hash [addralice, kalice, addrbob, Kbob] := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success
  cases action
  case CreateSubchannel inp =>
    let info := create_subchannel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    intro h'

    by_cases h_is_same: crypto.hash [c, addrbob, Kbob, token] = crypto.hash [inp.c, inp.addrbob, inp.Kbob, inp.token]
    case pos =>
      obtain ⟨kalice, h_inp_c⟩ := (channel_exists_implies_hash info.channel_exists).1
      apply crypto.h_hash at h_is_same
      injections
      use inp.addralice, kalice
      simp [*]
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same]) (by simp) (by simp)] at h'
      exact ih h'

  repeat exact ih

def subchannel_exists (crypto: Crypto) (m: Memory) (c token: ℕ) : Prop :=
  ∃ (addrbob Kbob: ℕ),
    m .SubchannelHashes [crypto.hash [c, addrbob, Kbob, token]] ≠ 0

-- Once a subchannel exists, it stays this way.
theorem subchannel_exists_monotone
    {crypto: Crypto} {rm: ReachableMemory crypto} {action: Action}
    (success: (run_action crypto action rm.m).success)
    {c token: ℕ}
    (h : subchannel_exists crypto rm c token) :
    subchannel_exists crypto (rm.add action success) c token
:= by
  unfold subchannel_exists
  cases action
  case CreateSubchannel inp =>
    obtain ⟨addrbob, Kbob, h⟩ := h
    use addrbob, Kbob

    let info := create_subchannel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h_is_same : crypto.hash [c, addrbob, Kbob, token] = inp.subchannel_hash crypto
    case pos =>
      simp [h_is_same, info.memory_diff₂]
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same]) (by simp) (by simp)]
      exact h
  all_goals exact h
