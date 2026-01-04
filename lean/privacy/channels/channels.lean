import privacy.utils
import privacy.actions
import privacy.registration

--------------------
-- Channel exists --
--------------------

def channel_exists (crypto: Crypto) (m: Memory) (c: ℕ) : Prop :=
  ∃ (addralice addrbob Kbob: ℕ),
    m .ChannelHashes [crypto.hash [c, addralice, addrbob, Kbob]] ≠ 0

-- CreateChannel action → Kbob has a corresponding private key.
theorem exists_private_key
    {crypto: Crypto} {inp: CreateChannelInput} {rm: ReachableMemory crypto}
    (success: (create_channel crypto inp rm |> process_action crypto rm).2) :
    ∃ kbob ∈ crypto.PrivateKeys, inp.Kbob = crypto.priv_to_pub kbob := by
  let info := create_channel_info crypto inp rm success
  have bob_registered := info.bob_registered
  rw [←info.h_Kbob] at bob_registered

  have := public_keys bob_registered
  rw [info.h_Kbob] at this
  exact this

-- Channel hash entry implies c is a valid channel id and Kbob is a valid public key.
theorem channel_exists_implies_hash
    {crypto: Crypto} {c addralice addrbob Kbob: ℕ} :
    ∀ {rm: ReachableMemory crypto},
    rm.m .ChannelHashes [crypto.hash [c, addralice, addrbob, Kbob]] ≠ 0 →
    ∃ kalice, c = crypto.hash [addralice, kalice, addrbob, Kbob] ∧
    ∃ kbob: crypto.PrivateKeys, Kbob = crypto.priv_to_pub kbob := by
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success
  cases action
  case CreateChannel inp =>
    let info := create_channel_info crypto inp rm success
    dsimp only [ReachableMemory.add, run_action]
    rw [←info.h_m']
    intro h'

    by_cases h_is_same: c = inp.c crypto ∧ addralice = inp.addralice ∧ addrbob = inp.addrbob ∧ Kbob = inp.Kbob
    case pos =>
      simp [h_is_same]
      constructor
      · use inp.kalice
      · exact exists_private_key success
    case neg =>
      rw [info.no_change _ _ (by simp) (by simp) (by
        simp only [ne_eq, Prod.mk.injEq, List.cons.injEq, and_true, true_and]
        by_contra h'
        apply crypto.h_hash at h'
        repeat injection h' with _ h'
        simp [*] at h_is_same
      )] at h'
      exact ih h'
  all_goals exact ih
