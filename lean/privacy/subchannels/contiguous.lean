import privacy.actions
import privacy.utils

-- The k₁-s of subchannels for (c, k₀) form a contiguous range [0, k₁_bound).
theorem subchannels_contiguous
    {crypto: Crypto} (rm: ReachableMemory crypto) (c k₀) :
    ∃ k₁_bound, ∀ k₁, (k₁ < k₁_bound) ↔ rm.m .Tokens [crypto.hash [c, k₀, k₁], 0] ≠ 0 := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => use 0; simp

  intro action rm
  cases action
  case CreateSubchannel inp =>
    intro h success

    unfold ReachableMemory.add run_action

    have info := create_subchannel_info crypto inp rm success
    simp only
    rw [←info.h_m']

    obtain ⟨k₁_bound, h⟩ := h

    by_cases h_is_same: c = inp.c ∧ k₀ = inp.k₀
    case pos =>
      use k₁_bound + 1
      intro k₁

      have h_inp_k₁_not_small : ¬inp.k₁ < k₁_bound := by
        by_contra h'
        have := (h inp.k₁).1 h'
        simp only [h_is_same] at this
        have := info.old_token_was_zero
        contradiction

      have h_inp_k₁_not_big : ¬inp.k₁ > k₁_bound := by
        cases info.prev_subchannel_exists
        case inl h_prev => omega
        case inr h_prev =>
          have := (h (inp.k₁ - 1)).2 (by
            simp only [h_is_same]
            exact h_prev
          )
          omega

      have h_k₁ : k₁_bound = inp.k₁ := by omega

      have := info.memory_diff₁
      by_cases h_k₁': k₁ = inp.k₁
      case pos =>
        rw [h_k₁, h_k₁', h_is_same.1, h_is_same.2, info.memory_diff₀]
        simp [info.r_ne_zero]
      case neg =>
        have : crypto.hash [c, k₀, k₁] ≠ inp.subchannel_id crypto := by
          by_contra h'
          have := crypto.h_hash h'
          injections
          omega
        rw [info.no_change _ _ (by simp) (by simp [this]) (by simp)]
        constructor
        · intro h₀; exact (h k₁).1 (by omega)
        · intro h₀; have := (h k₁).2 h₀; omega
    case neg =>
      use k₁_bound
      intro k₁
      have : crypto.hash [c, k₀, k₁] ≠ inp.subchannel_id crypto := by
        by_contra h'
        have := crypto.h_hash h'
        injections
        omega
      rw [info.no_change _ _ (by simp) (by simp [this]) (by simp)]
      exact h k₁
  all_goals intro h success; exact h
