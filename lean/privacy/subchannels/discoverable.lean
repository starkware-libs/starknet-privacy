import privacy.actions
import privacy.channels.channels
import privacy.channels.discoverable
import privacy.subchannels.contiguous
import privacy.subchannels.subchannels
import privacy.utils

-----------------------------------
-- Scan tokens for (channel, k₀) --
-----------------------------------

def scan_tokens_for_channel_k₀
    (crypto: Crypto) (rm: ReachableMemory crypto) (c k₀: ℕ) : List ℕ :=
  have h_exists : ∃ k₁, rm.m .Tokens [crypto.hash [c, k₀, k₁], 0] = 0 := by
    have h_contiguous := subchannels_contiguous rm
    obtain ⟨bound, h_bound⟩ := h_contiguous c k₀
    use bound
    have := (h_bound bound).not.mp (Nat.lt_irrefl bound)
    simp only [ne_eq, not_not] at this
    exact this
  let bound := Nat.find h_exists
  do
    let k₁ ← (List.range bound)
    let enc_token := rm.m .Tokens [crypto.hash [c, k₀, k₁], 1]
    let r := rm.m .Tokens [crypto.hash [c, k₀, k₁], 0]
    let sym_key := crypto.hash [c, r]
    return enc_token - sym_key

theorem scan_tokens_for_channel_k₀_monotone
  (crypto: Crypto) (rm: ReachableMemory crypto) (action: Action)
  (c k₀ token: ℕ)
  (success: (run_action crypto action rm.m).2)
  (h : token ∈ scan_tokens_for_channel_k₀ crypto rm c k₀)
  : let rm' := rm.add action success
    token ∈ scan_tokens_for_channel_k₀ crypto rm' c k₀
:= by
  unfold scan_tokens_for_channel_k₀ ReachableMemory.add run_action
  cases action
  case CreateSubchannel inp =>
    simp only [List.pure_def, List.bind_eq_flatMap, List.mem_flatMap, List.mem_range,
      Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false]
    simp only [scan_tokens_for_channel_k₀, List.pure_def, List.bind_eq_flatMap, List.mem_flatMap,
      List.mem_range, Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false] at h
    obtain ⟨k₁, h⟩ := h
    use k₁

    let info := create_subchannel_info crypto inp rm success
    rw [←info.h_m']

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

theorem subchannel_hash_exists_implies_k₀
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addrbob Kbob token: ℕ}
    (h_subchannel_hash_exists : rm.m .SubchannelHashes [crypto.hash [c, addrbob, Kbob, token]] ≠ 0):
    ∃ k₀,
      k₀ < crypto.MAX_K₀ ∧
      token ∈ scan_tokens_for_channel_k₀ crypto rm c k₀ ∧
      channel_exists crypto rm c := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => simp

  intro action rm ih success h_subchannel_hash_exists
  cases action
  case CreateChannel inp =>
    obtain ⟨k₀, k₀_lt_MAX_K₀, h⟩ := ih h_subchannel_hash_exists
    use k₀, k₀_lt_MAX_K₀, h.1
    apply channel_exists_monotone
    exact h.2
  case CreateSubchannel inp =>
    unfold ReachableMemory.add run_action at h_subchannel_hash_exists ⊢
    simp only at h_subchannel_hash_exists ⊢

    let info := create_subchannel_info crypto inp rm success
    rw [←info.h_m'] at h_subchannel_hash_exists

    by_cases h_is_same: crypto.hash [c, addrbob, Kbob, token] = inp.subchannel_hash crypto
    case pos =>
      use inp.k₀
      simp only [scan_tokens_for_channel_k₀, List.pure_def, List.bind_eq_flatMap, List.mem_flatMap,
        List.mem_range, Nat.lt_find_iff, List.mem_cons, List.not_mem_nil, or_false]

      have ⟨h_c, h_token⟩ : c = inp.c ∧ token = inp.token := by
        have := crypto.h_hash h_is_same
        injections
        omega

      refine ⟨info.k₀_lt_MAX_K₀, ⟨inp.k₁, ?_, ?_⟩, ?_⟩
      · intro k₁' h_k₁'_le_inpk₁
        rw [←info.h_m']

        by_cases h_k₁': k₁' = inp.k₁
        case pos =>
          rw [h_k₁', h_c, info.memory_diff₀]
          exact info.r_ne_zero
        case neg =>
          cases info.prev_subchannel_exists
          case inl h_prev => omega
          case inr h_prev =>
            obtain ⟨k₁'', h_contiguous⟩ := subchannels_contiguous rm c inp.k₀
            have := (h_contiguous (inp.k₁ - 1)).2 (by rw [h_c]; exact h_prev)
            have := (h_contiguous k₁').1 (by omega)
            rw [info.no_change _ _ (by simp) (by
              simp only [ne_eq, Prod.mk.injEq, List.cons.injEq, and_true, true_and]
              by_contra h'
              apply crypto.h_hash at h'
              injections
              omega
            ) (by simp)]
            exact this
      · rw [←info.h_m', h_c, info.memory_diff₀, info.memory_diff₁, h_token, add_tsub_cancel_left]
      · use inp.addralice, inp.addrbob, inp.Kbob
        rw [h_c]
        exact info.channel_exists
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same]) (by simp) (by simp)] at h_subchannel_hash_exists
      obtain ⟨k₀, k₀_lt_MAX_K₀, h⟩ := ih h_subchannel_hash_exists
      use k₀
      use k₀_lt_MAX_K₀

      use scan_tokens_for_channel_k₀_monotone crypto rm (.CreateSubchannel inp) c k₀ token success h.1
      exact h.2

  all_goals exact ih h_subchannel_hash_exists

-----------------------------
-- Scan tokens for channel --
-----------------------------

def scan_tokens_for_channel
    (crypto: Crypto)
    (rm: ReachableMemory crypto)
    (c: ℕ)
    : List ℕ := do
  let k₀ ← (List.range crypto.MAX_K₀)
  let token ← scan_tokens_for_channel_k₀ crypto rm c k₀
  return token

-- Subchannel existence implies that it's discoverable and the corresponding channel exists.
theorem subchannel_exists_implies
    {crypto: Crypto} {rm: ReachableMemory crypto} {c token: ℕ}
    (h : subchannel_exists crypto rm c token) :
    token ∈ scan_tokens_for_channel crypto rm c ∧
    channel_exists crypto rm c
:= by
  simp only [scan_tokens_for_channel, List.pure_def, List.bind_eq_flatMap, List.mem_flatMap,
    List.mem_range, List.mem_cons, List.not_mem_nil, or_false]
  obtain ⟨addrbob, Kbob, h⟩ := h
  obtain ⟨k₀, h_k₀_lt_MAX_K₀, h⟩ := subchannel_hash_exists_implies_k₀ h
  exact ⟨⟨k₀, h_k₀_lt_MAX_K₀, by simp [h.1]⟩, h.2⟩
