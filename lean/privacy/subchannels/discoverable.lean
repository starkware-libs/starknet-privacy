import privacy.actions
import privacy.channels.channels
import privacy.channels.discoverable
import privacy.subchannels.contiguous
import privacy.subchannels.subchannels
import privacy.utils

structure ScanTokenContext (crypto: Crypto) (m: Memory) where
  h_subchannels: ∀ c, ∃ k, m .SubchannelTokens [crypto.hash [c, k], 0] = 0

theorem ScanTokenContext.from
    {crypto: Crypto} (rm: ReachableMemory crypto)
    : ScanTokenContext crypto rm := by
  constructor
  intro c
  have h_contiguous := subchannels_contiguous rm
  obtain ⟨bound, h_bound⟩ := h_contiguous c
  use bound
  have := (h_bound bound).not.mp (Nat.lt_irrefl bound)
  simp only [ne_eq, not_not] at this
  exact this

-----------------------------
-- Scan tokens for channel --
-----------------------------

def scan_tokens_for_channel
    {crypto: Crypto} {m: Memory} (context: ScanTokenContext crypto m)
    (c: ℕ) : List ℕ :=
  let bound := Nat.find (context.h_subchannels c)
  do
    let k ← (List.range bound)
    let enc_token := m .SubchannelTokens [crypto.hash [c, k], 1]
    let r := m .SubchannelTokens [crypto.hash [c, k], 0]
    let sym_key := crypto.hash [c, k, r]
    return enc_token - sym_key

theorem scan_tokens_for_channel_monotone
  (crypto: Crypto) (rm: ReachableMemory crypto) (action: Action)
  (c token: ℕ)
  (success: (run_action crypto action rm.m).success)
  (h : token ∈ scan_tokens_for_channel (.from rm) c)
  : let rm' := rm.add action success
    token ∈ scan_tokens_for_channel (.from rm') c
:= by
  unfold scan_tokens_for_channel
  cases action
  case OpenSubchannel inp =>
    simp only [List.pure_def, List.bind_eq_flatMap, List.mem_flatMap, List.mem_range,
      Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false]
    simp only [scan_tokens_for_channel, List.pure_def, List.bind_eq_flatMap, List.mem_flatMap,
      List.mem_range, Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false] at h
    obtain ⟨k, h⟩ := h
    use k

    let info := open_subchannel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    constructor
    ·
      intro k' h_k'_le_k

      have h_ne': crypto.hash [c, k'] ≠ inp.subchannel_id crypto := by
        by_contra h_is_same
        have := h.1 k' h_k'_le_k
        have := info.old_token_was_zero
        rw [←h_is_same] at this
        contradiction
      rw [info.no_change _ _ (by simp) (by simp [h_ne']) (by simp)]
      exact h.1 k' h_k'_le_k
    ·
      have h_ne: crypto.hash [c, k] ≠ inp.subchannel_id crypto := by
        by_contra h_is_same
        have := h.1 k (by rfl)
        have := info.old_token_was_zero
        rw [←h_is_same] at this
        contradiction

      rw [info.no_change _ _ (by simp) (by simp [h_ne]) (by simp [h_ne])]
      rw [info.no_change _ _ (by simp) (by simp [h_ne]) (by simp [h_ne])]
      exact h.2
  all_goals exact h

-- Subchannel existence implies that it's discoverable via `scan_tokens_for_channel`.
theorem SubchannelImplies.scan_for_channel
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addralice addrbob Kbob token: ℕ}
    (subchannel_imp: SubchannelImplies rm c addralice addrbob Kbob token) :
      token ∈ scan_tokens_for_channel (.from rm) c := by
  simp only [scan_tokens_for_channel, List.pure_def, List.bind_eq_flatMap, List.mem_flatMap,
    List.mem_range, Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false]
  use subchannel_imp.k
  constructor
  · intro k' h_k'_le
    by_cases h_k': k' = subchannel_imp.k
    case pos =>
      rw [h_k', subchannel_imp.subchannel_tokens₀]
      exact subchannel_imp.r_ne_zero
    case neg =>
      cases subchannel_imp.prev_subchannel_exists
      case inl h_prev => omega
      case inr h_prev =>
        obtain ⟨k'', h_contiguous⟩ := subchannels_contiguous rm c
        have := (h_contiguous (subchannel_imp.k - 1)).2 h_prev
        exact (h_contiguous k').1 (by omega)
  · rw [subchannel_imp.subchannel_tokens₀, subchannel_imp.subchannel_tokens₁]
    simp
