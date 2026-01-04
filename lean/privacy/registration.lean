import privacy.actions
import privacy.utils

-- If a PublicKeys memory cell is non-zero, then it is a valid public key (private key exists).
theorem public_keys {crypto: Crypto} {addrbob: ℕ} :
    ∀ {rm: ReachableMemory crypto},
    rm.m .PublicKeys [addrbob] ≠ 0 →
    ∃ kbob ∈ crypto.PrivateKeys,
    rm.m .PublicKeys [addrbob] = crypto.priv_to_pub kbob := by
  apply ReachableMemory.induction
  case inv₀ => simp

  intro action rm
  cases action
  case Register inp =>
    intro h success
    let info := register_info crypto inp rm success
    dsimp only [ReachableMemory.add, run_action]
    rw [←info.h_m']

    by_cases h_addrbob: addrbob = inp.addrbob
    case pos =>
      rw [h_addrbob, info.memory_diff₀]
      intro h
      use inp.kbob
      use info.kbob_private_key
    case neg =>
      rw [info.no_change _ _ (by simp [h_addrbob])]
      intro h_public_key_ne_zero
      exact h h_public_key_ne_zero
  repeat intro h success; exact h
