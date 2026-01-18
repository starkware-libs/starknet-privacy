import privacy.actions
import privacy.utils

-- If a PublicKeys memory cell is non-zero, then it is a valid public key (private key exists).
theorem public_keys {crypto: Crypto} {addralice: ℕ} :
    ∀ {rm: ReachableMemory crypto},
    rm.m .PublicKeys [addralice] ≠ 0 →
    ∃ kalice: crypto.PrivateKeys,
      rm.m .PublicKeys [addralice] = crypto.priv_to_pub kalice := by
  apply ReachableMemory.induction
  case inv₀ => simp [ReachableMemory.m]

  intro action rm
  cases action
  case Register inp =>
    intro h success
    let info := register_info crypto inp rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']

    by_cases h_addralice: addralice = inp.addralice
    case pos =>
      rw [h_addralice, info.memory_diff₀]
      intro h
      refine ⟨⟨inp.kalice, info.kalice_private_key⟩, by rfl⟩
    case neg =>
      rw [info.no_change _ _ (by simp [h_addralice])]
      exact h
  repeat intro h success; exact h

theorem public_key_implies {crypto: Crypto} {rm: ReachableMemory crypto} {addralice: ℕ}
    (h: rm.m .PublicKeys [addralice] ≠ 0) :
    ∃ inp: RegisterInput,
      .Register inp ∈ rm.actions ∧
      inp.addralice = addralice ∧
      rm.m .PublicKeys [addralice] = crypto.priv_to_pub inp.kalice ∧
      inp.kalice ∈ crypto.PrivateKeys := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => simp [ReachableMemory.m]

  intro action rm ih success h
  cases action
  case Register inp =>
    let info := register_info crypto inp rm success
    rw [rm.add_m, run_action, ←info.h_m'] at ⊢ h
    by_cases h_is_same: addralice = inp.addralice
    case pos =>
      use inp
      simp only [h_is_same, info.memory_diff₀, info.kalice_private_key]
      simp
    case neg =>
      rw [info.no_change _ _ (by simp [h_is_same])] at ⊢ h
      have ⟨inp, h₀, h₁⟩ := ih h
      exact ⟨inp, by simp [ReachableMemory.add, h₀], h₁⟩

  all_goals
    have ⟨inp, h₀, h₁⟩ := ih h
    exact ⟨inp, by simp [ReachableMemory.add, h₀], h₁⟩
