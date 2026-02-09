import privacy.actions
import privacy.channels.channels
import privacy.channels.discoverable
import privacy.subchannels.contiguous
import privacy.subchannels.subchannels
import privacy.utils

structure ScanTokenContext (crypto: Crypto) (m: Memory) where
  h_subchannels: ∀ c k₀, ∃ k₁, m .SubchannelTokens [crypto.hash [c, k₀, k₁], 0] = 0

theorem ScanTokenContext.from
    {crypto: Crypto} (rm: ReachableMemory crypto)
    : ScanTokenContext crypto rm := by
  constructor
  intro c k₀
  have h_contiguous := subchannels_contiguous rm
  obtain ⟨bound, h_bound⟩ := h_contiguous c k₀
  use bound
  have := (h_bound bound).not.mp (Nat.lt_irrefl bound)
  simp only [ne_eq, not_not] at this
  exact this

-----------------------------------
-- Scan tokens for (channel, k₀) --
-----------------------------------

def scan_tokens_for_channel_k₀
    {crypto: Crypto} {m: Memory} (context: ScanTokenContext crypto m)
    (c k₀: ℕ) : List ℕ :=
  let bound := Nat.find (context.h_subchannels c k₀)
  do
    let k₁ ← (List.range bound)
    let enc_token := m .SubchannelTokens [crypto.hash [c, k₀, k₁], 1]
    let r := m .SubchannelTokens [crypto.hash [c, k₀, k₁], 0]
    let sym_key := crypto.hash [c, k₀, k₁, r]
    return enc_token - sym_key

theorem scan_tokens_for_channel_k₀_monotone
  (crypto: Crypto) (rm: ReachableMemory crypto) (action: Action)
  (c k₀ token: ℕ)
  (success: (run_action crypto action rm.m).success)
  (h : token ∈ scan_tokens_for_channel_k₀ (.from rm) c k₀)
  : let rm' := rm.add action success
    token ∈ scan_tokens_for_channel_k₀ (.from rm') c k₀
:= by
  unfold scan_tokens_for_channel_k₀
  cases action
  case OpenSubchannel inp =>
    simp only [List.pure_def, List.bind_eq_flatMap, List.mem_flatMap, List.mem_range,
      Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false]
    simp only [scan_tokens_for_channel_k₀, List.pure_def, List.bind_eq_flatMap, List.mem_flatMap,
      List.mem_range, Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false] at h
    obtain ⟨k₁, h⟩ := h
    use k₁

    let info := open_subchannel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    constructor
    ·
      intro k₁' h_k₁'_le_k₁

      have h_ne': crypto.hash [c, k₀, k₁'] ≠ inp.subchannel_id crypto := by
        by_contra h_is_same
        have := h.1 k₁' h_k₁'_le_k₁
        have := info.old_token_was_zero
        rw [←h_is_same] at this
        contradiction
      rw [info.no_change _ _ (by simp) (by simp [h_ne']) (by simp)]
      exact h.1 k₁' h_k₁'_le_k₁
    ·
      have h_ne: crypto.hash [c, k₀, k₁] ≠ inp.subchannel_id crypto := by
        by_contra h_is_same
        have := h.1 k₁ (by rfl)
        have := info.old_token_was_zero
        rw [←h_is_same] at this
        contradiction

      rw [info.no_change _ _ (by simp) (by simp [h_ne]) (by simp [h_ne])]
      rw [info.no_change _ _ (by simp) (by simp [h_ne]) (by simp [h_ne])]
      exact h.2
  all_goals exact h

theorem SubchannelImplies.scan_k₀
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addralice addrbob Kbob token: ℕ}
    (subchannel_imp: SubchannelImplies rm c addralice addrbob Kbob token) :
      token ∈ scan_tokens_for_channel_k₀ (.from rm) c subchannel_imp.k₀ := by
  simp only [scan_tokens_for_channel_k₀, List.pure_def, List.bind_eq_flatMap, List.mem_flatMap,
    List.mem_range, Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false]
  use subchannel_imp.k₁
  constructor
  · intro k₁' h_k₁'_le
    by_cases h_k₁': k₁' = subchannel_imp.k₁
    case pos =>
      rw [h_k₁', subchannel_imp.subchannel_tokens₀]
      exact subchannel_imp.r_ne_zero
    case neg =>
      cases subchannel_imp.prev_subchannel_exists
      case inl h_prev => omega
      case inr h_prev =>
        obtain ⟨k₁'', h_contiguous⟩ := subchannels_contiguous rm c subchannel_imp.k₀
        have := (h_contiguous (subchannel_imp.k₁ - 1)).2 h_prev
        exact (h_contiguous k₁').1 (by omega)
  · rw [subchannel_imp.subchannel_tokens₀, subchannel_imp.subchannel_tokens₁]
    simp

-----------------------------
-- Scan tokens for channel --
-----------------------------

def scan_tokens_for_channel
    {crypto: Crypto} {m: Memory} (context: ScanTokenContext crypto m)
    (c: ℕ) : List ℕ := do
  let k₀ ← (List.range crypto.MAX_K₀)
  let token ← scan_tokens_for_channel_k₀ context c k₀
  return token

-- Subchannel existence implies that it's discoverable.
theorem SubchannelImplies.scan
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addralice addrbob Kbob token: ℕ}
    (subchannel_imp: SubchannelImplies rm c addralice addrbob Kbob token) :
    token ∈ scan_tokens_for_channel (.from rm) c
:= by
  simp only [scan_tokens_for_channel, List.pure_def, List.bind_eq_flatMap, List.mem_flatMap,
    List.mem_range, List.mem_cons, List.not_mem_nil, or_false]
  exact ⟨subchannel_imp.k₀, subchannel_imp.h_k₀, token, subchannel_imp.scan_k₀, by rfl⟩
