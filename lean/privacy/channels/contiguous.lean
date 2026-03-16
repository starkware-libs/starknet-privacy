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
  case OpenChannel inp =>
    simp only
    let info := open_channel_info crypto inp rm success
    obtain ⟨addralice, addrbob, Kbob, h⟩ := h
    use addralice, addrbob, Kbob
    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    by_cases h₀ : crypto.hash [c, addralice, addrbob, Kbob] = inp.channel_marker crypto
    case pos =>
      simp [h₀, info.memory_diff₂]
    case neg =>
      rwa [info.no_change _ _ (by simp [h₀])]
  all_goals exact h

-- The j-q of the channels for addrbob form a contiguous range [0, j_bound) where j_bound
-- is recorded in ChannelsJ.
theorem channels_contiguous {crypto: Crypto} (rm: ReachableMemory crypto) (addrbob: ℕ) :
    ∀ j, (j ≥ rm.m .ChannelsJ [addrbob]) ↔ rm.m .Channels [addrbob, j] = 0 := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intros; simp [ReachableMemory.m]

  intro action rm
  cases action
  case OpenChannel inp =>
    intro h success j

    have info := open_channel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h_bob: addrbob = inp.addrbob
    case pos =>
      replace h := h j
      rw [h_bob] at *
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
          simp only [ne_eq, Prod.mk.injEq, reduceCtorEq, List.cons.injEq, List.cons_ne_self,
            and_false, and_self, not_false_eq_true, and_true, true_and, not_and, false_and]
          intro h
          contradiction
        )]
        exact h j
  all_goals intro h success; exact h

-- The q of outgoing channels for given (addralice, kalice) form a contiguous range [0, q_bound).
theorem outgoing_channels_contiguous {crypto: Crypto} (rm: ReachableMemory crypto) (addralice kalice: ℕ) :
    ∃ q_bound, ∀ q, q < q_bound ↔ rm.m .OutgoingChannels [crypto.hash [addralice, kalice, q], 0] ≠ 0 := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => use 0; intros; simp [ReachableMemory.m]

  intro action rm ih success
  cases action
  case OpenChannel inp =>
    obtain ⟨q_bound, ih⟩ := ih
    let info := open_channel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h₀ : addralice = inp.addralice ∧ kalice = inp.kalice
    case pos =>
      use q_bound + 1
      intro q

      have h_inp_q_not_small : ¬inp.q < q_bound := by
        have := (ih inp.q).1
        simp [h₀, info.outgoing_channel_didnt_exist] at this
        omega

      have h_inp_q_not_big : ¬inp.q > q_bound := by
        cases info.prev_outgoing_exists
        case inl h_prev => omega
        case inr h_prev =>
          have := (ih (inp.q - 1)).2
          simp only [h₀, OpenChannelInput.prev_outgoing_channel_id] at h_prev this
          omega

      have h_q : q_bound = inp.q := by omega

      by_cases h₁ : q = inp.q
      case pos =>
        simp only [h₁, h_q, h₀.1, h₀.2, info.memory_diff₃, lt_add_iff_pos_right, Nat.lt_one_iff,
          ne_eq, true_iff]
        exact info.r_ne_zero
      case neg =>
        have h_hash_ne : crypto.hash [inp.addralice, inp.kalice, q] ≠ inp.outgoing_channel_id crypto := by
          simp only [OpenChannelInput.outgoing_channel_id, ne_eq]
          intro h
          apply crypto.h_hash at h
          injections h
          contradiction
        rw [h₀.1, h₀.2, info.no_change _ _ (by simp [h_hash_ne])]
        have := ih q
        simp only [h₀] at this
        rw [←this]
        omega
    case neg =>
      use q_bound
      intro q
      have h_hash_ne : crypto.hash [addralice, kalice, q] ≠ inp.outgoing_channel_id crypto := by
        simp only [OpenChannelInput.outgoing_channel_id, ne_eq]
        intro h
        apply crypto.h_hash at h
        injections h
        omega
      rw [info.no_change _ _ (by simp [h_hash_ne])]
      exact ih q

  all_goals exact ih
