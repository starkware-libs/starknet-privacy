import privacy.actions
import privacy.channels.channels
import privacy.utils

structure SubchannelImplies₀
    {crypto: Crypto} (rm: ReachableMemory crypto) (c addralice addrbob Kbob token: ℕ) where
  (k₀ k₁ r kalice channel_s channel_r: ℕ)
  h_k₀: k₀ < crypto.MAX_K₀
  r_ne_zero: r ≠ 0
  h_action: .CreateSubchannel ⟨c, addralice, addrbob, Kbob, token, k₀, k₁, r⟩ ∈ rm.actions
  channel: ChannelImplies rm ⟨addralice, kalice, addrbob, Kbob, channel_s, channel_r⟩
  h_c: c = channel.c

abbrev SubchannelImplies₀.subchannel_input
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addralice addrbob Kbob token: ℕ}
    (subchannel_imp: SubchannelImplies₀ rm c addralice addrbob Kbob token) : CreateSubchannelInput :=
  ⟨c, addralice, addrbob, Kbob, token, subchannel_imp.k₀, subchannel_imp.k₁, subchannel_imp.r⟩

structure SubchannelImplies
    {crypto: Crypto} (rm: ReachableMemory crypto) (c addralice addrbob Kbob token: ℕ)
    extends SubchannelImplies₀ rm c addralice addrbob Kbob token where
  subchannel_hash: rm.m .SubchannelHashes [toSubchannelImplies₀.subchannel_input.subchannel_hash crypto] ≠ 0
  subchannel_tokens₀ : rm.m .SubchannelTokens [toSubchannelImplies₀.subchannel_input.subchannel_id crypto, 0] = r
  subchannel_tokens₁ : rm.m .SubchannelTokens [toSubchannelImplies₀.subchannel_input.subchannel_id crypto, 1] = crypto.hash [c, k₀, k₁, r] + token
  prev_subchannel_exists: k₁ = 0 ∨ rm.m .SubchannelTokens [crypto.hash [c, k₀, k₁ - 1], 0] ≠ 0

theorem SubchannelImplies.h_channel_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addralice addrbob Kbob token: ℕ}
    (subchannel_imp: SubchannelImplies rm c addralice addrbob Kbob token) :
    channel_exists crypto rm c :=
  subchannel_imp.h_c ▸ subchannel_imp.channel.h_channel_exists

theorem SubchannelImplies.next
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addralice addrbob Kbob token: ℕ}
    {action: Action} (success: (run_action crypto action rm.m).success)
    (subchannel_imp: SubchannelImplies rm c addralice addrbob Kbob token) :
    Nonempty (SubchannelImplies (rm.add action success) c addralice addrbob Kbob token) := by
  let subchannel_imp₀ : SubchannelImplies₀ (rm.add action success) c addralice addrbob Kbob token := {
    k₀ := subchannel_imp.k₀,
    k₁ := subchannel_imp.k₁,
    r := subchannel_imp.r,
    kalice := subchannel_imp.kalice,
    channel_s := subchannel_imp.channel_s,
    channel_r := subchannel_imp.channel_r,
    h_k₀ := subchannel_imp.h_k₀,
    r_ne_zero := subchannel_imp.r_ne_zero,
    h_action := by simp [subchannel_imp.h_action],
    channel := Nonempty.some (subchannel_imp.channel.next success),
    h_c := by simp [subchannel_imp.h_c],
  }

  cases action
  case CreateSubchannel inp =>
    let info := create_subchannel_info crypto inp rm success
    have h_subchannel_id_ne : subchannel_imp₀.subchannel_input.subchannel_id crypto ≠ inp.subchannel_id crypto := by
      by_contra h'
      have := subchannel_imp.subchannel_tokens₀ ▸ h' ▸ info.old_token_was_zero
      exact subchannel_imp.r_ne_zero this

    have h_subchannel_hash : subchannel_imp₀.subchannel_input.subchannel_hash crypto ≠ inp.subchannel_hash crypto := by
      by_contra h'
      exact subchannel_imp.subchannel_hash (h' ▸ info.old_hash_was_zero)

    refine ⟨{
      toSubchannelImplies₀ := subchannel_imp₀,
      subchannel_hash := ?_,
      subchannel_tokens₀ := ?_,
      subchannel_tokens₁ := ?_,
      prev_subchannel_exists := ?_,
    }⟩
    · rw [rm.add_m, run_action, ←info.h_m', info.no_change _ _ (by simp [h_subchannel_hash]) (by simp) (by simp)]
      exact subchannel_imp.subchannel_hash
    · rw [rm.add_m, run_action, ←info.h_m', info.no_change _ _ (by simp) (by simp [h_subchannel_id_ne]) (by simp)]
      exact subchannel_imp.subchannel_tokens₀
    · rw [rm.add_m, run_action, ←info.h_m', info.no_change _ _ (by simp) (by simp) (by simp [h_subchannel_id_ne])]
      exact subchannel_imp.subchannel_tokens₁
    · by_cases h: subchannel_imp₀.k₁ = 0
      case pos => simp [h]
      case neg =>
        have prev_exists := Or.resolve_left subchannel_imp.prev_subchannel_exists h
        apply Or.inr
        have : crypto.hash [c, subchannel_imp₀.k₀, subchannel_imp₀.k₁ - 1] ≠ CreateSubchannelInput.subchannel_id crypto inp := by
          by_contra h'
          have := crypto.h_hash h'
          injections
          rename_i h₀ h₁ h₂
          have := info.old_token_was_zero
          simp only [CreateSubchannelInput.subchannel_id, ←h₀, ←h₁, ←h₂] at this
          exact prev_exists this
        rw [rm.add_m, run_action, ←info.h_m', info.no_change _ _ (by simp) (by simp [this]) (by simp)]
        exact prev_exists

  all_goals exact ⟨{
    toSubchannelImplies₀ := subchannel_imp₀,
    subchannel_hash := subchannel_imp.subchannel_hash,
    subchannel_tokens₀ := subchannel_imp.subchannel_tokens₀,
    subchannel_tokens₁ := subchannel_imp.subchannel_tokens₁,
    prev_subchannel_exists := subchannel_imp.prev_subchannel_exists,
  }⟩

theorem SubchannelImplies.from_subchannel_hash_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addrbob Kbob token: ℕ}
    (h: rm.m .SubchannelHashes [crypto.hash [c, addrbob, Kbob, token]] ≠ 0) :
    ∃ (addralice: ℕ), Nonempty (SubchannelImplies rm c addralice addrbob Kbob token) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success h'
  cases action
  case CreateSubchannel inp =>
    let info := create_subchannel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m'] at h'

    by_cases h_is_same: crypto.hash [c, addrbob, Kbob, token] = crypto.hash [inp.c, inp.addrbob, inp.Kbob, inp.token]
    case pos =>
      obtain ⟨kalice, channel_s, channel_r, ⟨channel_imp, h_c⟩⟩ := ChannelImplies.from_channel_hashes info.channel_exists
      use inp.addralice
      apply crypto.h_hash at h_is_same
      injections
      simp only [*]

      refine ⟨{
        k₀ := inp.k₀,
        k₁ := inp.k₁,
        r := inp.r,
        kalice := kalice,
        channel_s := channel_s,
        channel_r := channel_r,
        h_action := by simp,
        h_k₀ := info.k₀_lt_MAX_K₀,
        r_ne_zero := info.r_ne_zero,
        channel := Nonempty.some (channel_imp.next success),
        h_c := by simp [h_c],
        subchannel_hash := by rw [rm.add_m, run_action, ←info.h_m', info.memory_diff₂]; simp,
        subchannel_tokens₀ := by rw [rm.add_m, run_action, ←info.h_m', info.memory_diff₀],
        subchannel_tokens₁ := by rw [rm.add_m, run_action, ←info.h_m', info.memory_diff₁],
        prev_subchannel_exists := ?_,
      }⟩
      -- prev_subchannel_exists:
      · by_cases h: inp.k₁ = 0
        case pos => simp [h]
        case neg =>
          apply Or.inr
          have : crypto.hash [inp.c, inp.k₀, inp.k₁ - 1] ≠ CreateSubchannelInput.subchannel_id crypto inp := by
            by_contra h
            have := crypto.h_hash h
            injections
            omega
          rw [rm.add_m, run_action, ←info.h_m', info.no_change _ _ (by simp) (by simp [this]) (by simp)]
          exact Or.resolve_left info.prev_subchannel_exists h
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same]) (by simp) (by simp)] at h'
      have ⟨addralice, ⟨ih⟩⟩ := ih h'
      exact ⟨addralice, ih.next success⟩

  all_goals
    have ⟨addralice, ⟨ih⟩⟩ := ih h'
    exact ⟨addralice, ih.next success⟩

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
