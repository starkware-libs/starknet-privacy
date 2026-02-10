import privacy.actions
import privacy.utils

-- The k-s of subchannels for a given c form a contiguous range [0, k_bound).
theorem subchannels_contiguous
    {crypto: Crypto} (rm: ReachableMemory crypto) (c: ℕ) :
    ∃ k_bound, ∀ k, (k < k_bound) ↔ rm.m .SubchannelTokens [crypto.hash [c, k], 0] ≠ 0 := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => use 0; simp [ReachableMemory.m]

  intro action rm
  cases action
  case OpenSubchannel inp =>
    intro h success

    have info := open_subchannel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    obtain ⟨k_bound, h⟩ := h

    by_cases h_is_same: c = inp.c
    case pos =>
      use k_bound + 1
      intro k

      have h_inp_k_not_small : ¬inp.k < k_bound := by
        by_contra h'
        have := (h inp.k).1 h'
        simp only [h_is_same] at this
        have := info.old_token_was_zero
        contradiction

      have h_inp_k_not_big : ¬inp.k > k_bound := by
        cases info.prev_subchannel_exists
        case inl h_prev => omega
        case inr h_prev =>
          have := (h (inp.k - 1)).2 (by
            simp only [h_is_same]
            exact h_prev
          )
          omega

      have h_k : k_bound = inp.k := by omega

      have := info.memory_diff₁
      by_cases h_k': k = inp.k
      case pos =>
        rw [h_k, h_k', h_is_same, info.memory_diff₀]
        simp [info.r_ne_zero]
      case neg =>
        have : crypto.hash [c, k] ≠ inp.subchannel_id crypto := by
          by_contra h'
          have := crypto.h_hash h'
          injections
          omega
        rw [info.no_change _ _ (by simp) (by simp [this]) (by simp)]
        constructor
        · intro h₀; exact (h k).1 (by omega)
        · intro h₀; have := (h k).2 h₀; omega
    case neg =>
      use k_bound
      intro k
      have : crypto.hash [c, k] ≠ inp.subchannel_id crypto := by
        by_contra h'
        have := crypto.h_hash h'
        injections
        contradiction
      rw [info.no_change _ _ (by simp) (by simp [this]) (by simp)]
      exact h k
  all_goals intro h success; try exact h
