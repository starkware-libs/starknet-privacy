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

structure RegisterImplies
    {crypto: Crypto} (rm: ReachableMemory crypto) (inp: RegisterInput) where
  h_action: .Register inp ∈ rm.actions
  public_key: rm.m .PublicKeys [inp.addralice] = crypto.priv_to_pub inp.kalice
  h_kalice: inp.kalice ∈ crypto.PrivateKeys

theorem RegisterImplies.from_action
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: RegisterInput}
    (h: .Register inp ∈ rm.actions) :
    RegisterImplies rm inp := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => simp

  intro action rm ih success h
  rw [ReachableMemory.add] at h

  cases h
  case head =>
    let info := register_info crypto inp _ success

    exact {
      h_action := by simp,
      public_key := by
        rw [rm.add_m, run_action, ←info.h_m']
        rw [info.memory_diff₀]
      h_kalice := info.kalice_private_key
    }

  case tail h =>
    have ih := ih h

    cases action
    case Register inp' =>
      let info := register_info crypto inp' _ success

      have h_addralice : inp.addralice ≠ inp'.addralice := by
        by_contra h₀
        exact crypto.zero_not_public_key ⟨inp.kalice, ih.h_kalice⟩ (Eq.symm (info.alice_was_not_registered ▸ h₀ ▸ ih.public_key))

      exact {
        h_action := by simp [ih.h_action],
        public_key := by
          rw [rm.add_m, run_action, ←info.h_m']
          rw [info.no_change _ _ (by simp [h_addralice])]
          exact ih.public_key
        h_kalice := ih.h_kalice
      }

    all_goals
      refine ⟨?_, ?_, ?_⟩
      · simp [ih.h_action]
      · exact ih.public_key
      · exact ih.h_kalice

theorem RegisterImplies.next
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: RegisterInput}
    {action: Action} (success: (run_action crypto action rm.m).success)
    (h: RegisterImplies rm inp) :
    RegisterImplies (rm.add action success) inp :=
  RegisterImplies.from_action (by simp [h.h_action])

theorem RegisterImplies.from_public_key {crypto: Crypto} {rm: ReachableMemory crypto} {addralice: ℕ}
    (h: rm.m .PublicKeys [addralice] ≠ 0) :
    ∃ kalice: crypto.PrivateKeys,
      RegisterImplies rm ⟨addralice, kalice⟩ := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => simp [ReachableMemory.m]

  intro action rm ih success h
  cases action
  case Register inp =>
    let info := register_info crypto inp rm success

    by_cases h_is_same: addralice = inp.addralice
    case pos =>
      use ⟨inp.kalice, info.kalice_private_key⟩
      simp only [h_is_same]
      apply RegisterImplies.from_action
      simp
    case neg =>
      rw [rm.add_m, run_action, ←info.h_m'] at h
      rw [info.no_change _ _ (by simp [h_is_same])] at h
      have ⟨kalice, res⟩ := ih h
      exact ⟨kalice, res.next success⟩

  all_goals
    have ⟨kalice, res⟩ := ih h
    exact ⟨kalice, res.next success⟩
