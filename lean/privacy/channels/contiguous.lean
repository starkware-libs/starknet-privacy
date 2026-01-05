import privacy.utils
import privacy.actions
import privacy.channels.channels

-- Once a channel exists, it stays this way.
theorem channel_exists_monotone (crypto: Crypto) (rm: ReachableMemory crypto) (action: Action)
  (c: ℕ)
  (success: (run_action crypto action rm.m).2)
  (h : channel_exists crypto rm c)
  : let rm' := rm.add action success
    channel_exists crypto rm' c
:= by
  unfold channel_exists ReachableMemory.add run_action
  cases action
  case CreateChannel inp =>
    simp only
    let info := create_channel_info crypto inp rm success
    obtain ⟨addralice, addrbob, Kbob, h⟩ := h
    use addralice, addrbob, Kbob
    rw [←info.h_m']
    by_cases h₀ : crypto.hash [c, addralice, addrbob, Kbob] = inp.channel_hash crypto
    case pos =>
      simp [h₀, info.memory_diff₂]
    case neg =>
      rwa [info.no_change _ _ (by simp) (by simp) (by simp [h₀])]
  all_goals exact h

-- The j-s of the channels for (addrbob, Kbob) form a contiguous range [0, j_bound) where j_bound
-- is recorded in ChannelsJ.
theorem channels_contiguous {crypto: Crypto} (rm: ReachableMemory crypto) (addrbob Kbob: ℕ) :
    ∀ j, (j ≥ rm.m .ChannelsJ [addrbob, Kbob]) ↔ rm.m .Channels [addrbob, Kbob, j] = 0 := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intros; simp

  intro action rm
  cases action
  case CreateChannel inp =>
    intro h success j
    unfold ReachableMemory.add run_action
    dsimp only

    have info := create_channel_info crypto inp rm success
    rw [←info.h_m']

    by_cases h_bob: addrbob = inp.addrbob ∧ Kbob = inp.Kbob
    case pos =>
      replace h := h j
      rw [h_bob.1, h_bob.2] at *
      rw [info.memory_diff₀]
      rw [←info.h_j] at *

      have := info.memory_diff₁
      by_cases h_j: j = info.j
      case pos =>
        rw [h_j]
        simp only [ge_iff_le, add_le_iff_nonpos_right, nonpos_iff_eq_zero, one_ne_zero, false_iff,
          ne_eq]
        rw [this]
        exact crypto.enc_is_not_zero _ _
      case neg =>
        rw [info.no_change _ _ (by simp) (by simp [h_j]) (by simp)]
        constructor
        · intro h₀; rw [h.1 (by omega)]
        · intro h₀
          have := h.2 h₀
          omega
    case neg =>
        rw [info.no_change _ _ (by simp [h_bob]) (by simp) (by simp)]
        rw [info.no_change _ _ (by simp) (by by_contra; injections; injections; simp [*] at h_bob) (by simp)]
        exact h j
  all_goals intro h success; exact h
