import privacy.utils
import privacy.actions
import privacy.channels.channels
import privacy.channels.contiguous

def scan_channels (crypto: Crypto) (m: Memory) (addrbob: ℕ) (kbob: crypto.PrivateKeys) : List ℕ :=
  let Kbob := crypto.priv_to_pub kbob
  let num_channels := m .ChannelsJ [addrbob, Kbob]
  List.range num_channels |>.map (λ j ↦ (crypto.dec kbob (m .Channels [addrbob, Kbob, j])).headD 0)

theorem scan_channels_monotone
   {crypto: Crypto} {m: Memory} {addrbob c: ℕ} {kbob: crypto.PrivateKeys}
   {action: Action} (success: (run_action crypto action m).2)
   (h: c ∈ scan_channels crypto m addrbob kbob) :
   c ∈ scan_channels crypto (run_action crypto action m).1 addrbob kbob := by
  cases action
  case CreateChannel inp =>
    unfold run_action at *
    simp only [scan_channels] at *
    let info := create_channel_info crypto inp m success
    rw [←info.h_m']
    simp only [List.headD_eq_head?_getD, List.mem_map, List.mem_range] at *
    obtain ⟨j, h⟩ := h
    use j

    generalize h_Kbob: crypto.priv_to_pub kbob = Kbob at *

    by_cases h_bob: addrbob = inp.addrbob ∧ Kbob = inp.Kbob
    case pos =>
      rw [h_bob.1, h_bob.2] at h
      rw [h_bob.1, h_bob.2]
      constructor
      · rw [info.memory_diff₀]; omega
      · by_cases h_j': j = info.j
        case pos => rw [info.h_j] at h_j'; omega
        case neg =>
          rw [info.no_change _ _ (by simp) (by simp [h_j']) (by simp)]
          exact h.2
    case neg =>
      rw [info.no_change _ _ (by simp [h_bob]) (by simp) (by simp)]
      rw [info.no_change _ _ (by simp) (by by_contra; injections; injections; simp [*] at h_bob) (by simp)]
      exact h

  all_goals exact h

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
  case inv₀ => unfold channel_exists; simp

  intro action rm ih success c_exists
  cases action
  case CreateChannel inp =>
    obtain ⟨addralice, addrbob, Kbob, c_exists⟩ := c_exists
    let info := create_channel_info crypto inp rm success
    by_cases h₀ : crypto.hash [c, addralice, addrbob, Kbob] = inp.channel_hash crypto
    case pos =>
      have ⟨kalice', _, ⟨kbob, h_kbob⟩⟩ := channel_exists_implies_hash (rm:=rm.add (.CreateChannel inp) success) c_exists
      use inp.addralice, inp.kalice, inp.addrbob, kbob
      have h_Kbob : crypto.priv_to_pub kbob = inp.Kbob := by
        replace h₀ := crypto.h_hash h₀
        injections h₀
        rwa [←h_kbob]

      simp only [ReachableMemory.add, run_action, ←info.h_m'] at *

      constructor
      · rw [h_Kbob]
        replace h₀ := crypto.h_hash h₀
        injections h₀
      · simp only [scan_channels]
        simp only [List.headD_eq_head?_getD, List.mem_map, List.mem_range]
        rw [h_Kbob]
        use info.j
        constructor
        · rw [info.h_j, info.memory_diff₀]; omega
        · rw [info.memory_diff₁, CreateChannelInput.enc, ←h_Kbob , crypto.dec_enc]
          injection crypto.h_hash h₀ with h₀  _
          simp only [List.head?_cons, Option.getD_some, h₀]
    case neg =>
      simp only [ReachableMemory.add, run_action, ←info.h_m'] at c_exists
      rw [info.no_change _ _ (by simp) (by simp) (by simp [h₀])] at c_exists
      have ⟨addralice, kalice, addrbob, kbob, ih⟩ := ih ⟨addralice, addrbob, Kbob, c_exists⟩
      use addralice, kalice, addrbob, kbob, ih.1, scan_channels_monotone success ih.2

  all_goals exact ih c_exists

-- Discoverable channel → channel_exists and c is linked to (addrbob, kbob).
theorem discoverable_channel_implies_exists
    (crypto: Crypto) (rm: ReachableMemory crypto) (addrbob: ℕ) (kbob: crypto.PrivateKeys) (c: ℕ)
    (h: c ∈ scan_channels crypto rm addrbob kbob) :
    channel_exists crypto rm c ∧
    ∃ addralice kalice, c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob] := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success

  cases action
  case CreateChannel inp =>
    let info := create_channel_info crypto inp rm success
    unfold ReachableMemory.add run_action
    dsimp only
    rw [←info.h_m'] at *
    intro channel_discoverable_
    simp only [scan_channels, List.headD_eq_head?_getD, List.mem_map, List.mem_range] at *
    obtain ⟨j, j_lt, channel_decryption⟩ := channel_discoverable_
    by_cases h_bob: addrbob = inp.addrbob ∧ crypto.priv_to_pub kbob = inp.Kbob
    case pos =>
      rw [h_bob.1, h_bob.2] at j_lt ih channel_decryption
      rw [info.memory_diff₀] at j_lt
      rw [←info.h_j] at *
      by_cases same_j: j = info.j
      case pos =>
        have h_c : c = inp.c crypto := by
          rw [same_j, info.memory_diff₁, CreateChannelInput.enc, ←h_bob.2, crypto.dec_enc] at channel_decryption
          simp at channel_decryption
          simp [channel_decryption]
        constructor
        · unfold channel_exists
          use inp.addralice, inp.addrbob, inp.Kbob
          simp [h_c, info.memory_diff₂]
        · use inp.addralice, inp.kalice
          rw [h_c, h_bob.1, h_bob.2]
      case neg =>
        rw [info.no_change _ _ (by simp) (by simp [same_j]) (by simp)] at channel_decryption
        have ⟨h₀, h₁⟩ := ih ⟨j, (by omega), channel_decryption⟩
        rw [h_bob.1, h_bob.2, info.h_m']
        use channel_exists_monotone crypto rm (.CreateChannel inp) c success h₀
    case neg =>
      rw [info.no_change _ _ (by simp [h_bob]) (by simp) (by simp)] at j_lt
      rw [info.no_change _ _ (by simp) (by by_contra; injections; injections; simp [*] at h_bob) (by simp)] at channel_decryption
      have ⟨h₀, h₁⟩ := ih ⟨j, j_lt, channel_decryption⟩
      rw [info.h_m']
      use channel_exists_monotone crypto rm (.CreateChannel inp) c success h₀

  all_goals exact ih
