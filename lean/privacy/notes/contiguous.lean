import privacy.utils
import privacy.actions
import privacy.notes.notes

-- The i₁-s of notes for given (c, token, i₀) form a contiguous range [0, i₁_bound).
theorem notes_contiguous {crypto: Crypto} {rm: ReachableMemory crypto} (c token i₀: ℕ) :
  ∃ i₁_bound, ∀ i₁, i₁ < i₁_bound ↔ note_exists rm (crypto.hash [c, token, i₀, i₁]) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => use 0; intros; simp [note_exists]

  intro action rm ih success
  cases action
  case CreateNote inp =>
    obtain ⟨i₁_bound, ih⟩ := ih
    let info := create_note_info crypto inp rm success
    unfold ReachableMemory.add run_action
    dsimp only
    rw [←info.h_m']

    by_cases h₀ : c = inp.c crypto ∧ token = inp.token ∧ i₀ = inp.i₀
    case pos =>
      use i₁_bound + 1
      intro i₁
      unfold note_exists

      have h_inp_i₁_not_small : ¬inp.i₁ < i₁_bound := by
        by_contra h'
        have := (ih inp.i₁).1 h'
        unfold note_exists at this
        simp only [h₀] at this
        have := info.old_value_was_zero
        contradiction

      have h_inp_i₁_not_big : ¬inp.i₁ > i₁_bound := by
        cases info.prev_note_exists
        case inl h_prev => omega
        case inr h_prev =>
          have := (ih (inp.i₁ - 1)).2 (by
            unfold note_exists
            simp only [h₀]
            exact h_prev
          )
          omega

      have h_i₁ : i₁_bound = inp.i₁ := by omega

      by_cases h₁ : i₁ = inp.i₁
      case pos =>
        rw [h₁, h_i₁, h₀.1, h₀.2.1, h₀.2.2, info.memory_diff₀]
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
        have := ih i₁
        simp only [note_exists] at this
        rw [←this]
        omega
    case neg =>
      use i₁_bound
      intro i₁
      replace h := ih i₁
      unfold note_exists
      have : crypto.hash [c, token, i₀, i₁] ≠
        crypto.hash [inp.c crypto, inp.token, inp.i₀, inp.i₁] := by
        by_contra h₁
        apply crypto.h_hash at h₁
        injections h₁
        rename_i h₁₀ h₁₁ h₁₂ h₁₃
        exact h₀ ⟨h₁, h₁₀, h₁₁⟩
      rw [info.no_change _ _ (by simp [this]) (by simp)]
      exact h

  case OpenDeposit inp =>
    obtain ⟨i₁, ih⟩ := ih
    use i₁
    intro i₁
    rw [note_exists_open_deposit success]
    exact ih i₁

  all_goals exact ih
