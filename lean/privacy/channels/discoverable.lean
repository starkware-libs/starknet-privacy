import privacy.utils
import privacy.actions
import privacy.channels.channels
import privacy.channels.contiguous

def scan_channels (crypto: Crypto) (m: Memory) (addrbob: ℕ) (kbob: crypto.PrivateKeys) : List ℕ :=
  let num_channels := m .ChannelsJ [addrbob]
  List.range num_channels |>.map (λ j ↦ (crypto.dec kbob (m .Channels [addrbob, j])).headD 0)

theorem scan_channels_monotone
   {crypto: Crypto} {m: Memory} {addrbob c: ℕ} {kbob: crypto.PrivateKeys}
   {action: Action} (success: (run_action crypto action m).success)
   (h: c ∈ scan_channels crypto m addrbob kbob) :
   c ∈ scan_channels crypto (run_action crypto action m).m addrbob kbob := by
  cases action
  case CreateChannel inp =>
    simp only [scan_channels] at *
    let info := create_channel_info crypto inp m success
    rw [run_action, ←info.h_m']
    simp only [List.headD_eq_head?_getD, List.mem_map, List.mem_range] at *
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

-- If bob was not registered, then scan_channels will return an empty list.
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
theorem channels_are_discoverable {crypto: Crypto} {rm: ReachableMemory crypto} {c: ℕ}
    (c_exists: channel_exists crypto rm c) :
    ∃ addralice kalice addrbob, ∃ kbob: crypto.PrivateKeys,
      c = crypto.hash [addralice, kalice, addrbob, (crypto.priv_to_pub kbob)] ∧
      c ∈ scan_channels crypto rm addrbob kbob := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => unfold channel_exists; simp [ReachableMemory.m]

  intro action rm ih success c_exists
  cases action
  case CreateChannel inp =>
    obtain ⟨addralice, addrbob, Kbob, c_exists⟩ := c_exists
    let info := create_channel_info crypto inp rm success
    by_cases h₀ : crypto.hash [c, addralice, addrbob, Kbob] = inp.channel_hash crypto
    case pos =>
      have ⟨_, ⟨kbob, h_kbob, _⟩⟩ := channel_exists_implies_hash (rm:=rm.add (.CreateChannel inp) success) c_exists
      use inp.addralice, inp.kalice, inp.addrbob, kbob
      have h_Kbob : crypto.priv_to_pub kbob = inp.Kbob := by
        replace h₀ := crypto.h_hash h₀
        injections h₀
        rwa [←h_kbob]

      simp only [ReachableMemory.add_m, run_action, ←info.h_m'] at *

      constructor
      · rw [h_Kbob]
        replace h₀ := crypto.h_hash h₀
        injections h₀
      · simp only [scan_channels]
        simp only [List.headD_eq_head?_getD, List.mem_map, List.mem_range]
        use info.j
        constructor
        · rw [info.h_j, info.memory_diff₀]; omega
        · rw [info.memory_diff₁, CreateChannelInput.enc, ←h_Kbob, crypto.dec_enc]
          injection crypto.h_hash h₀ with h₀  _
          simp only [List.head?_cons, Option.getD_some, h₀]
    case neg =>
      simp only [ReachableMemory.add_m, run_action, ←info.h_m'] at c_exists
      rw [info.no_change _ _ (by simp [h₀])] at c_exists
      have ⟨addralice, kalice, addrbob, kbob, ih⟩ := ih ⟨addralice, addrbob, Kbob, c_exists⟩
      use addralice, kalice, addrbob, kbob, ih.1, scan_channels_monotone success ih.2

  all_goals exact ih c_exists

-- Discoverable channel → channel_exists and c is linked to (addrbob, kbob).
theorem discoverable_channel_implies_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {addrbob: ℕ} {kbob: crypto.PrivateKeys} {c: ℕ}
    (k_kbob: rm.m .PublicKeys [addrbob] = crypto.priv_to_pub kbob)
    (h: c ∈ scan_channels crypto rm addrbob kbob) :
    channel_exists crypto rm c ∧
    ∃ addralice kalice, c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob] := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h_kbob h; trivial

  intro action rm ih success

  cases action
  case CreateChannel inp =>
    let info := create_channel_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m'] at *
    intro h_kbob h_channel_discoverable
    simp only [scan_channels, List.headD_eq_head?_getD, List.mem_map, List.mem_range] at *
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
        have h_c : c = inp.c crypto := by
          rw [same_j, info.memory_diff₁, CreateChannelInput.enc, h_Kbob, crypto.dec_enc] at channel_decryption
          simp at channel_decryption
          simp [channel_decryption]
        constructor
        · unfold channel_exists
          use inp.addralice, inp.addrbob, inp.Kbob
          simp [h_c, info.memory_diff₂]
        · use inp.addralice, inp.kalice
          rw [h_c, ←h_Kbob, h_bob]
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
