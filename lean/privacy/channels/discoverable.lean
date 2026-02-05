import privacy.utils
import privacy.actions
import privacy.channels.channels
import privacy.channels.contiguous

-- Scans the incoming channels for the given address `addrbob`.
-- Returns a list of `(c, addralice)`.
def scan_channels (crypto: Crypto) (m: Memory) (addrbob: ℕ) (kbob: crypto.PrivateKeys) : List (ℕ × ℕ) :=
  let num_channels := m .ChannelsJ [addrbob]
  List.range num_channels |>.map (λ j ↦
    let d := crypto.dec kbob (m .Channels [addrbob, j])
    (d.getD 0 0, d.getD 1 0)
  )

theorem scan_channels_monotone
   {crypto: Crypto} {m: Memory} {addrbob: ℕ} {kbob: crypto.PrivateKeys}
   {action: Action} (success: (run_action crypto action m).success)
   (h: elm ∈ scan_channels crypto m addrbob kbob) :
   elm ∈ scan_channels crypto (run_action crypto action m).m addrbob kbob := by
  cases action
  case CreateChannel inp =>
    simp only [scan_channels] at *
    let info := create_channel_info crypto inp m success
    rw [run_action, ←info.h_m']
    simp only [List.mem_map, List.mem_range] at *
    obtain ⟨j, h⟩ := h
    use j

    generalize h_Kbob: crypto.priv_to_pub kbob = Kbob at *

    by_cases h_bob: addrbob = inp.addrbob
    case pos =>
      rw [h_bob] at h
      rw [h_bob]
      constructor
      · rw [info.memory_diff₀]; omega
      · by_cases h_j': j = info.j
        case pos => rw [info.h_j] at h_j'; omega
        case neg =>
          rw [info.no_change _ _ (by simp [h_j'])]
          exact h.2
    case neg =>
      rw [info.no_change _ _ (by simp [h_bob])]
      have : ¬(addrbob = inp.addrbob ∧ j = info.j) := λ h ↦ h_bob h.1
      rw [info.no_change _ _ (by simp [this])]
      exact h

  all_goals exact h

-- If bob was not registered, then `scan_channels` returns an empty list.
theorem channels_j_zero
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ}
    (h: rm.m .PublicKeys [addrbob] = 0) :
    rm.m .ChannelsJ [addrbob] = 0  := by
  revert rm
  apply ReachableMemory.induction

  case inv₀ => intro h; trivial

  intro action rm ih success h
  cases action
  case CreateChannel inp =>
    let info := create_channel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m'] at h ⊢
    rw [info.no_change _ _ (by simp)] at h
    by_cases h_bob: addrbob = inp.addrbob
    case pos =>
      rw [h_bob] at h
      have := info.h_Kbob ▸ info.bob_registered
      contradiction
    case neg =>
      rw [info.no_change _ _ (by simp [h_bob])]
      exact ih h

  case Register inp =>
    let info := register_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m'] at h ⊢
    rw [info.no_change _ _ (by simp)]
    by_cases h_bob: addrbob = inp.addralice
    case pos =>
      rw [h_bob] at ih ⊢
      exact ih info.alice_was_not_registered
    case neg =>
      rw [info.no_change _ _ (by simp [h_bob])] at h
      exact ih h

  all_goals exact ih h

-----------------------------------------
-- Channel exists implies discoverable --
-----------------------------------------

-- Channel exists → it is discoverable by scanning.
theorem ChannelImplies.scan {crypto: Crypto} {rm: ReachableMemory crypto} {inp: CreateChannelInput}
    (channel_imp: ChannelImplies rm inp) :
    (inp.c crypto, inp.addralice) ∈ scan_channels crypto rm inp.addrbob channel_imp.kbob := by
  simp only [scan_channels, List.mem_map]

  use channel_imp.j
  constructor
  · rw [List.mem_range]; exact channel_imp.h_j_lt
  · rw [channel_imp.channel_enc]
    rw [CreateChannelInput.enc, channel_imp.h_Kbob, crypto.dec_enc]
    simp

-- Discoverable channel → channel exists.
theorem ChannelImplies.from_scan
    {crypto: Crypto} {rm: ReachableMemory crypto} {addralice addrbob: ℕ} {kbob: crypto.PrivateKeys} {c: ℕ}
    (k_kbob: rm.m .PublicKeys [addrbob] = crypto.priv_to_pub kbob)
    (h: (c, addralice) ∈ scan_channels crypto rm addrbob kbob) :
    ∃ (inp: CreateChannelInput) (channel_imp: ChannelImplies rm inp),
    inp.c crypto = c ∧ inp.addralice = addralice ∧ inp.addrbob = addrbob ∧ channel_imp.kbob = kbob := by
  suffices h' : channel_exists crypto rm c ∧ ∃ kalice, c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob] from by
    have ⟨h₀, ⟨kalice, h₁⟩⟩ := h'
    have ⟨inp, channel_imp, h_c⟩ := ChannelImplies.from_channel_exists h₀
    refine ⟨inp, channel_imp, by rw [←h_c], ?_⟩
    simp [channel_imp.same_c_priv (h_c ▸ h₁)]

  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h_kbob h; trivial

  intro action rm ih success

  cases action
  case CreateChannel inp =>
    let info := create_channel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m'] at *
    intro h_kbob h_channel_discoverable
    simp only [scan_channels, List.mem_map, List.mem_range] at *
    obtain ⟨j, j_lt, channel_decryption⟩ := h_channel_discoverable
    by_cases h_bob: addrbob = inp.addrbob
    case pos =>
      rw [h_bob] at j_lt ih channel_decryption
      rw [info.memory_diff₀] at j_lt
      rw [←info.h_j] at *
      rw [info.no_change _ _ (by simp), h_bob] at h_kbob
      have h_Kbob : inp.Kbob = crypto.priv_to_pub kbob := by
        rw [←info.h_Kbob, h_kbob]
      by_cases same_j: j = info.j
      case pos =>
        rw [same_j, info.memory_diff₁, CreateChannelInput.enc, h_Kbob, crypto.dec_enc] at channel_decryption
        have ⟨h_c, h_addralice⟩ : c = inp.c crypto ∧ addralice = inp.addralice := by
          simp at channel_decryption
          simp [channel_decryption]
        constructor
        · unfold channel_exists
          use inp.addralice, inp.addrbob, inp.Kbob
          simp [h_c, info.memory_diff₂]
        · use inp.kalice
          rw [h_c, ←h_Kbob, h_bob, h_addralice]
      case neg =>
        rw [info.no_change _ _ (by simp [same_j])] at channel_decryption
        have ⟨h₀, h₁⟩ := ih h_kbob ⟨j, (by omega), channel_decryption⟩
        rw [h_bob, info.h_m']
        use channel_exists_monotone crypto rm (.CreateChannel inp) c success h₀
    case neg =>
      rw [info.no_change _ _ (by simp [h_bob])] at j_lt
      have : ¬(addrbob = inp.addrbob ∧ j = info.j) := λ h ↦ h_bob h.1
      rw [info.no_change _ _ (by simp [this])] at channel_decryption
      rw [info.no_change _ _ (by simp)] at h_kbob
      have ⟨h₀, h₁⟩ := ih h_kbob ⟨j, j_lt, channel_decryption⟩
      rw [info.h_m']
      use channel_exists_monotone crypto rm (.CreateChannel inp) c success h₀

  case Register inp =>
    intro h_kbob h_channel_discoverable
    let info := register_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m'] at h_kbob
    by_cases same_addrbob: addrbob = inp.addralice
    case pos =>
      have : (rm.add (.Register inp) success).m MemoryType.ChannelsJ [inp.addralice] = 0 := by
        rw [ReachableMemory.add_m, run_action, ←info.h_m', info.no_change _ _ (by simp)]
        exact channels_j_zero info.alice_was_not_registered
      rw [scan_channels, same_addrbob, this] at h_channel_discoverable
      simp at h_channel_discoverable
    case neg =>
      rw [info.no_change _ _ (by simp [same_addrbob])] at h_kbob
      exact ih h_kbob h_channel_discoverable

  all_goals exact ih
