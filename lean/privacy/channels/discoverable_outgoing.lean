import privacy.utils
import privacy.actions
import privacy.channels.channels
import privacy.channels.contiguous

structure ScanOutgoingChannelContext (crypto: Crypto) (m: Memory) where
  h_outgoing_channels: ∀ addralice kalice, ∃ q, m .OutgoingChannels [crypto.hash [addralice, kalice, q], 0] = 0

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
    (addralice kalice: ℕ) : List ℕ :=
  let bound := Nat.find (context.h_outgoing_channels addralice kalice)
  (List.range bound).map (λ q ↦
    let addrbob_enc := m .OutgoingChannels [crypto.hash [addralice, kalice, q], 1]
    let r := m .OutgoingChannels [crypto.hash [addralice, kalice, q], 0]
    let sym_key_addrbob := crypto.hash [addralice, kalice, q, r]

    addrbob_enc - sym_key_addrbob
  )

theorem scan_outgoing_channels_monotone
   {crypto: Crypto} {rm: ReachableMemory crypto} {addralice kalice: ℕ}
   {action: Action}
   {addrbob: ℕ}
   (success: (run_action crypto action rm).success)
   (h: addrbob ∈ scan_outgoing_channels (.from rm) addralice kalice) :
   addrbob ∈ scan_outgoing_channels (.from (rm.add action success)) addralice kalice := by
  cases action
  case OpenChannel inp =>
    let info := open_channel_info crypto inp rm success
    simp only [scan_outgoing_channels, List.mem_map, List.mem_range,
      Nat.lt_find_iff, ReachableMemory.add_m, run_action, ←info.h_m'] at h ⊢
    obtain ⟨q_bound, h₀, h₁⟩ := h
    use q_bound

    constructor
    · intro q h_q_le_q_bound
      have h_ne': crypto.hash [addralice, kalice, q] ≠ inp.outgoing_channel_id crypto := by
        by_contra h_is_same
        have := h₀ q h_q_le_q_bound
        have := info.outgoing_channel_didnt_exist
        rw [←h_is_same] at this
        contradiction
      rw [info.no_change _ _ (by simp [h_ne'])]
      exact h₀ q h_q_le_q_bound
    · have h_ne: crypto.hash [addralice, kalice, q_bound] ≠ inp.outgoing_channel_id crypto := by
        by_contra h_is_same
        have := h₀ q_bound (by rfl)
        have := info.outgoing_channel_didnt_exist
        rw [←h_is_same] at this
        contradiction

      rw [info.no_change _ _ (by simp [h_ne])]
      rw [info.no_change _ _ (by simp [h_ne])]
      exact h₁
  all_goals exact h

theorem scan_outgoing_channels_extends
    {crypto: Crypto} {rm rm': ReachableMemory crypto} {addralice kalice: ℕ}
    (h_extends: rm'.extends rm)
    {addrbob: ℕ}
    (h: addrbob ∈ scan_outgoing_channels (.from rm) addralice kalice) :
    addrbob ∈ scan_outgoing_channels (.from rm') addralice kalice := by
  revert rm'
  apply invariant_induction_for_extends
  case inv₀ => exact h

  intro action rm' h_extends h success
  apply scan_outgoing_channels_monotone success
  exact h

-----------------------------------------
-- Channel exists implies discoverable --
-----------------------------------------

-- Channel exists → it is discoverable by scanning the outgoing channels.
theorem outgoing_channels_are_discoverable {crypto: Crypto} {rm: ReachableMemory crypto}
    {addralice kalice addrbob Kbob: ℕ}
    (c_exists: channel_exists crypto rm (crypto.hash [addralice, kalice, addrbob, Kbob])) :
    addrbob ∈ scan_outgoing_channels (.from rm) addralice kalice := by
  have ⟨inp, channel_imp, h_c⟩ := ChannelImplies.from_channel_exists c_exists
  have ⟨rm₀, success, h_extends⟩ := channel_imp.success
  apply scan_outgoing_channels_extends h_extends
  let info := open_channel_info crypto inp rm₀ success
  simp only [scan_outgoing_channels, List.mem_map, List.mem_range,
    Nat.lt_find_iff, ReachableMemory.add_m, run_action, ←info.h_m']
  use inp.q

  simp only [channel_imp.same_c h_c]
  rw [info.memory_diff₃, info.memory_diff₄]
  refine ⟨?_, by simp⟩

  intro q'
  have ⟨sbound, h_contiguous⟩ := outgoing_channels_contiguous rm₀ addralice kalice

  by_cases h_q': q' = inp.q
  case pos =>
    intro _
    simp only [h_q', info.memory_diff₃]
    exact info.r_ne_zero
  case neg =>
    cases info.prev_outgoing_exists
    case inl h_prev => omega
    case inr h_prev =>
      intro h_q'_le
      have := (h_contiguous (inp.q - 1)).2 (by simp only [channel_imp.same_c h_c]; exact h_prev)
      have := (h_contiguous q').1 (by omega)

      have h_ne : crypto.hash [inp.addralice, inp.kalice, q'] ≠ inp.outgoing_channel_id crypto := by
        by_contra h_eq
        apply crypto.h_hash at h_eq
        injections h_eq
        contradiction

      rw [info.no_change _ _ (by simp [h_ne])]
      simp only [←channel_imp.same_c h_c]
      exact this
