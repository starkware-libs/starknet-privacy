import privacy.utils
import privacy.actions
import privacy.channels.channels

-- Once a channel exists, it stays this way.
theorem channel_exists_monotone (crypto: Crypto) (rm: ReachableMemory crypto) (action: Action)
  (c: ℕ)
  (success: (run_action crypto action rm.m).success)
  (h : channel_exists crypto rm c)
  : let rm' := rm.add action success
    channel_exists crypto rm' c
:= by
  unfold channel_exists
  cases action
  case CreateChannel inp =>
    simp only
    let info := create_channel_info crypto inp rm success
    obtain ⟨addralice, addrbob, Kbob, h⟩ := h
    use addralice, addrbob, Kbob
    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    by_cases h₀ : crypto.hash [c, addralice, addrbob, Kbob] = inp.channel_hash crypto
    case pos =>
      simp [h₀, info.memory_diff₂]
    case neg =>
      rwa [info.no_change _ _ (by simp [h₀])]
  all_goals exact h

-- The j-s of the channels for (addrbob, Kbob) form a contiguous range [0, j_bound) where j_bound
-- is recorded in ChannelsJ.
theorem channels_contiguous {crypto: Crypto} (rm: ReachableMemory crypto) (addrbob Kbob: ℕ) :
    ∀ j, (j ≥ rm.m .ChannelsJ [addrbob, Kbob]) ↔ rm.m .Channels [addrbob, Kbob, j] = 0 := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intros; simp [ReachableMemory.m]

  intro action rm
  cases action
  case CreateChannel inp =>
    intro h success j

    have info := create_channel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

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
        rw [info.no_change _ _ (by simp [h_j])]
        constructor
        · intro h₀; rw [h.1 (by omega)]
        · intro h₀
          have := h.2 h₀
          omega
    case neg =>
        rw [info.no_change _ _ (by simp [h_bob])]
        rw [info.no_change _ _ (by
          simp only [ne_eq, Prod.mk.injEq, true_and, List.cons.injEq, List.cons_ne_self, and_false,
            and_true, reduceCtorEq, not_false_eq_true]
          by_contra
          simp [*] at h_bob
        )]
        exact h j
  all_goals intro h success; exact h

-- The s of outgoing channels for given (addralice, kalice) form a contiguous range [0, s_bound).
theorem outgoing_channels_contiguous {crypto: Crypto} (rm: ReachableMemory crypto) (addralice kalice: ℕ) :
    ∃ s_bound, ∀ s, s < s_bound ↔ rm.m .OutgoingChannels [crypto.hash [addralice, kalice, s], 0] ≠ 0 := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => use 0; intros; simp [ReachableMemory.m]

  intro action rm ih success
  cases action
  case CreateChannel inp =>
    obtain ⟨s_bound, ih⟩ := ih
    let info := create_channel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h₀ : addralice = inp.addralice ∧ kalice = inp.kalice
    case pos =>
      use s_bound + 1
      intro s

      have h_inp_s_not_small : ¬inp.s < s_bound := by
        have := (ih inp.s).1
        simp [h₀, info.outgoing_channel_didnt_exist] at this
        omega

      have h_inp_s_not_big : ¬inp.s > s_bound := by
        cases info.prev_outgoing_exists
        case inl h_prev => omega
        case inr h_prev =>
          have := (ih (inp.s - 1)).2
          simp only [h₀, CreateChannelInput.prev_outgoing_channel_id] at h_prev this
          omega

      have h_s : s_bound = inp.s := by omega

      by_cases h₁ : s = inp.s
      case pos =>
        simp only [h₁, h_s, h₀.1, h₀.2, info.memory_diff₃, lt_add_iff_pos_right, Nat.lt_one_iff,
          ne_eq, true_iff]
        exact info.r_ne_zero
      case neg =>
        have h_hash_ne : crypto.hash [inp.addralice, inp.kalice, s] ≠ inp.outgoing_channel_id crypto := by
          simp only [CreateChannelInput.outgoing_channel_id, ne_eq]
          intro h
          apply crypto.h_hash at h
          injections h
          contradiction
        rw [h₀.1, h₀.2, info.no_change _ _ (by simp [h_hash_ne])]
        have := ih s
        simp only [h₀] at this
        rw [←this]
        omega
    case neg =>
      use s_bound
      intro s
      have h_hash_ne : crypto.hash [addralice, kalice, s] ≠ inp.outgoing_channel_id crypto := by
        simp only [CreateChannelInput.outgoing_channel_id, ne_eq]
        intro h
        apply crypto.h_hash at h
        injections h
        omega
      rw [info.no_change _ _ (by simp [h_hash_ne])]
      exact ih s

  all_goals exact ih
