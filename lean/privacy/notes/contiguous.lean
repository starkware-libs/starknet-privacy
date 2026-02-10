import privacy.utils
import privacy.actions
import privacy.notes.notes

-- The i-s of notes for given (c, token) form a contiguous range [0, i_bound).
theorem notes_contiguous {crypto: Crypto} {rm: ReachableMemory crypto} (c token: ℕ) :
  ∃ i_bound, ∀ i, i < i_bound ↔ note_exists rm (crypto.hash [c, token, i]) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => use 0; intros; simp [ReachableMemory.m, note_exists]

  intro action rm ih success
  cases action
  case CreateNote inp =>
    obtain ⟨i_bound, ih⟩ := ih
    let info := create_note_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h₀ : c = inp.c crypto ∧ token = inp.token
    case pos =>
      use i_bound + 1
      intro i
      unfold note_exists

      have h_inp_i_not_small : ¬inp.i < i_bound := by
        by_contra h'
        have := (ih inp.i).1 h'
        unfold note_exists at this
        simp only [h₀] at this
        have := info.old_value_was_zero
        contradiction

      have h_inp_i_not_big : ¬inp.i > i_bound := by
        cases info.prev_note_exists
        case inl h_prev => omega
        case inr h_prev =>
          have := (ih (inp.i - 1)).2 (by
            unfold note_exists
            simp only [h₀]
            exact h_prev
          )
          omega

      have h_i : i_bound = inp.i := by omega

      by_cases h₁ : i = inp.i
      case pos =>
        rw [h₁, h_i, h₀.1, h₀.2, info.memory_diff₀]
        simp only [lt_add_iff_pos_right, Nat.lt_one_iff, pos_of_gt, ne_eq, true_iff]
        exact crypto.pack_nz info.r_ne_zero
      case neg =>
        rw [info.no_change _ _ (by
          simp only [h₀, ne_eq, Prod.mk.injEq, List.cons.injEq, and_true, true_and]
          by_contra h'
          apply crypto.h_hash at h'
          injections h'
          contradiction
        ) (by simp)]
        have := ih i
        simp only [note_exists] at this
        rw [←this]
        omega
    case neg =>
      use i_bound
      intro i
      replace h := ih i
      unfold note_exists
      have : crypto.hash [c, token, i] ≠
        crypto.hash [inp.c crypto, inp.token, inp.i] := by
        by_contra h₁
        apply crypto.h_hash at h₁
        injections h₁
        rename_i h₁₀ h₁₁
        exact h₀ ⟨h₁, h₁₀⟩
      rw [info.no_change _ _ (by simp [this]) (by simp)]
      exact h

  case OpenDeposit inp =>
    obtain ⟨i₁, ih⟩ := ih
    use i₁
    intro i₁
    rw [note_exists_open_deposit success]
    exact ih i₁

  all_goals exact ih
