import privacy.utils
import privacy.actions
import privacy.channels.channels
import privacy.channels.contiguous

structure ScanOutgoingChannelContext (crypto: Crypto) (m: Memory) where
  h_outgoing_channels: ∀ addralice kalice, ∃ s, m .OutgoingChannels [crypto.hash [addralice, kalice, s], 0] = 0

theorem ScanOutgoingChannelContext.from
    {crypto: Crypto} (rm: ReachableMemory crypto)
    : ScanOutgoingChannelContext crypto rm :=
  {
    h_outgoing_channels := by
      intro addralice kalice
      have ⟨bound, h_bound⟩ := outgoing_channels_contiguous rm addralice kalice
      use bound
      have := (h_bound bound).not.mp (Nat.lt_irrefl bound)
      simp only [ne_eq, not_not] at this
      exact this
  }

def scan_outgoing_channels
    {crypto: Crypto} {m: Memory} (context: ScanOutgoingChannelContext crypto m)
    (addralice kalice: ℕ) : List (ℕ × ℕ) :=
  let bound := Nat.find (context.h_outgoing_channels addralice kalice)
  (List.range bound).map (λ s ↦
    let addrbob_enc := m .OutgoingChannels [crypto.hash [addralice, kalice, s], 1]
    let Kbob_enc := m .OutgoingChannels [crypto.hash [addralice, kalice, s], 2]
    let r := m .OutgoingChannels [crypto.hash [addralice, kalice, s], 0]
    let sym_key_addrbob := crypto.hash [addralice, kalice, r, 0]
    let sym_key_Kbob := crypto.hash [addralice, kalice, r, 1]

    ⟨addrbob_enc - sym_key_addrbob, Kbob_enc - sym_key_Kbob⟩
  )

theorem scan_outgoing_channels_monotone
   {crypto: Crypto} {rm: ReachableMemory crypto} {addralice kalice: ℕ}
   {action: Action}
   {item: ℕ × ℕ}
   (success: (run_action crypto action rm).success)
   (h: item ∈ scan_outgoing_channels (.from rm) addralice kalice) :
   item ∈ scan_outgoing_channels (.from (rm.add action success)) addralice kalice := by
  cases action
  case CreateChannel inp =>
    let info := create_channel_info crypto inp rm success
    simp only [scan_outgoing_channels, List.mem_map, List.mem_range,
      Nat.lt_find_iff, ReachableMemory.add_m, run_action, ←info.h_m'] at h ⊢
    obtain ⟨s_bound, h₀, h₁⟩ := h
    use s_bound

    constructor
    · intro s h_s_le_s_bound
      have h_ne': crypto.hash [addralice, kalice, s] ≠ inp.outgoing_channel_id crypto := by
        by_contra h_is_same
        have := h₀ s h_s_le_s_bound
        have := info.outgoing_channel_didnt_exist
        rw [←h_is_same] at this
        contradiction
      rw [info.no_change _ _ (by simp [h_ne'])]
      exact h₀ s h_s_le_s_bound
    · have h_ne: crypto.hash [addralice, kalice, s_bound] ≠ inp.outgoing_channel_id crypto := by
        by_contra h_is_same
        have := h₀ s_bound (by rfl)
        have := info.outgoing_channel_didnt_exist
        rw [←h_is_same] at this
        contradiction

      rw [info.no_change _ _ (by simp [h_ne])]
      rw [info.no_change _ _ (by simp [h_ne])]
      rw [info.no_change _ _ (by simp [h_ne])]
      exact h₁
  all_goals exact h

-----------------------------------------
-- Channel exists implies discoverable --
-----------------------------------------

-- Channel exists → it is discoverable by scanning the outgoing channels.
theorem outgoing_channels_are_discoverable {crypto: Crypto} {rm: ReachableMemory crypto}
    {addralice kalice addrbob Kbob: ℕ}
    (c_exists: channel_exists crypto rm (crypto.hash [addralice, kalice, addrbob, Kbob])) :
    (addrbob, Kbob) ∈ scan_outgoing_channels (.from rm) addralice kalice := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => simp [channel_exists, ReachableMemory.m]

  intro action rm ih success c_exists
  cases action
  case CreateChannel inp =>
    by_cases h_channel_existed: channel_exists crypto rm (crypto.hash [addralice, kalice, addrbob, Kbob])
    case pos =>
      -- Channel existed before.
      exact scan_outgoing_channels_monotone success (ih h_channel_existed)
    case neg =>
      have ⟨inp, h_inp, h_c⟩ := channel_exists_iff_CreateChannel.1 c_exists

      cases h_inp
      case tail h_inp =>
        have := channel_exists_iff_CreateChannel.2 ⟨inp, h_inp, h_c⟩
        contradiction

      -- Channel was just added.
      let info := create_channel_info crypto inp rm success
      simp only [scan_outgoing_channels, List.mem_map, List.mem_range,
        Nat.lt_find_iff, ReachableMemory.add_m, run_action, ←info.h_m']
      use inp.s

      have : addralice = inp.addralice ∧ kalice = inp.kalice ∧ addrbob = inp.addrbob ∧ Kbob = inp.Kbob := by
        apply crypto.h_hash at h_c
        injections
        simp [*]

      constructor
      · intro s' h_s'
        have ⟨sbound, h_contiguous⟩ := outgoing_channels_contiguous rm addralice kalice

        by_cases h_s'': s' = inp.s
        case pos =>
          simp only [h_s'', this, info.memory_diff₃]
          exact info.r_ne_zero
        case neg =>
          cases info.prev_outgoing_exists
          case inl h_prev => omega
          case inr h_prev =>
            have := (h_contiguous (inp.s - 1)).2 (by simp only [this]; exact h_prev)
            have := (h_contiguous s').1 (by omega)

            have h_ne : crypto.hash [addralice, kalice, s'] ≠ inp.outgoing_channel_id crypto := by
              by_contra h_eq
              apply crypto.h_hash at h_eq
              injections h_eq
              contradiction

            rw [info.no_change _ _ (by simp [h_ne])]
            exact this

      · simp [this, info.memory_diff₃, info.memory_diff₄, info.memory_diff₅]

  all_goals exact ih c_exists
