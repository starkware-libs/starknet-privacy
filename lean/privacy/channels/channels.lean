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
    (success: (create_channel crypto inp rm |> process_action crypto rm).success) :
    ∃ kbob: crypto.PrivateKeys,
      inp.Kbob = crypto.priv_to_pub kbob ∧
      rm.m .PublicKeys [inp.addrbob] = inp.Kbob := by
  let info := create_channel_info crypto inp rm success
  have bob_registered := info.bob_registered
  rw [←info.h_Kbob] at bob_registered

  have ⟨kalice, h⟩ := public_keys bob_registered
  exact ⟨kalice, by rw [←info.h_Kbob, h], by rw [info.h_Kbob]⟩

-- Channel hash entry implies c is a valid channel id and Kbob is a valid public key.
theorem channel_exists_implies_hash
    {crypto: Crypto} {c addralice addrbob Kbob: ℕ} :
    ∀ {rm: ReachableMemory crypto},
    rm.m .ChannelHashes [crypto.hash [c, addralice, addrbob, Kbob]] ≠ 0 →
    (∃ kalice: crypto.PrivateKeys,
      c = crypto.hash [addralice, kalice, addrbob, Kbob] ∧
      rm.m .PublicKeys [addralice] = crypto.priv_to_pub kalice
    ) ∧
    (∃ kbob: crypto.PrivateKeys,
      Kbob = crypto.priv_to_pub kbob ∧
      rm.m .PublicKeys [addrbob] = Kbob
    ) := by
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success
  cases action
  case CreateChannel inp =>
    let info := create_channel_info crypto inp rm success
    dsimp only [ReachableMemory.add, ReachableMemory.m]
    rw [run_all_cons₁, run_action, ←info.h_m']
    intro h'

    by_cases h_is_same: c = inp.c crypto ∧ addralice = inp.addralice ∧ addrbob = inp.addrbob ∧ Kbob = inp.Kbob
    case pos =>
      simp only [h_is_same]
      constructor
      · use ⟨inp.kalice, info.kalice_valid⟩
        constructor
        · trivial
        · rw [info.no_change _ _ (by simp)]
          exact info.alice_registered
      · conv => rhs; intro kbob; rw [info.no_change _ _ (by simp)]
        exact exists_private_key success
    case neg =>
      rw [info.no_change _ _  (by
        simp only [ne_eq, Prod.mk.injEq, reduceCtorEq, List.cons.injEq, and_true, false_and,
          not_false_eq_true, List.ne_cons_self, and_false, and_self, true_and]
        by_contra h'
        apply crypto.h_hash at h'
        repeat injection h' with _ h'
        simp [*] at h_is_same
      )] at h'
      conv => rhs; rhs; intro m'; rw [info.no_change _ _ (by simp)]
      conv => lhs; rhs; intro m'; rw [info.no_change _ _ (by simp)]
      exact ih h'

  case Register inp =>
    intro h
    let info := register_info crypto inp rm success
    rw [rm.add_m, run_action, ←info.h_m']

    have ⟨⟨kalice, h₀, h₁⟩, ⟨kbob, h₂, h₃⟩⟩ := ih h
    refine ⟨⟨kalice, h₀, ?_⟩, ⟨kbob, h₂, ?_⟩⟩
    · by_cases h_is_same: addralice = inp.addralice
      case pos =>
        rw [h_is_same, info.alice_was_not_registered] at h₁
        have := crypto.zero_not_public_key kalice
        simp [h₁] at this
      case neg => rwa [info.no_change _ _ (by simp [h_is_same])]
    · by_cases h_is_same: addrbob = inp.addralice
      case pos =>
        rw [h_is_same, info.alice_was_not_registered] at h₃
        have := crypto.zero_not_public_key kbob
        simp [h₃, h₂] at this
      case neg => rwa [info.no_change _ _ (by simp [h_is_same])]

  all_goals exact ih

theorem channel_exists_iff_CreateChannel {crypto: Crypto} {rm: ReachableMemory crypto} {c: ℕ} :
    channel_exists crypto rm c ↔
    (∃ inp: CreateChannelInput, .CreateChannel inp ∈ rm.actions ∧ inp.c crypto = c) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ =>
    constructor
    · intro h
      have ⟨addralice, addrbob, Kbob, h⟩ := h
      simp [ReachableMemory.m] at h
    · intro h; simp at h

  intro action rm ih success
  cases action
  case CreateChannel inp' =>
    let info := create_channel_info crypto inp' rm success
    rw [ReachableMemory.add_m, run_action, ←info.h_m']
    simp only [channel_exists]

    by_cases h_is_same: c = inp'.c crypto
    case pos =>
      constructor
      · intro h
        obtain ⟨addralice, addrbob, Kbob, h⟩ := h
        exact ⟨inp', by simp [ReachableMemory.add], by simp [h_is_same]⟩
      · intro h
        use inp'.addralice, inp'.addrbob, inp'.Kbob
        simp [h_is_same, info.memory_diff₂]
    case neg =>
      conv in _ ≠ 0 => rw [info.no_change _ _ (by
        have : crypto.hash [c, addralice, addrbob, Kbob] ≠ inp'.channel_hash crypto := by
          by_contra h'; apply crypto.h_hash at h'; injections; contradiction
        simp [this]
      )]
      rw [ReachableMemory.add]

      conv in _ ∈ _ => rw [List.mem_cons, Action.CreateChannel.injEq]
      rw [←channel_exists, ih]

      constructor
      · intro h
        have ⟨inp, h₀, h₁⟩ := h
        exact ⟨inp, Or.inr h₀, h₁⟩
      · intro h
        obtain ⟨inp, h₀, h₁⟩ := h
        cases h₀
        case inl h₀ =>
          rw [←h₁, h₀] at h_is_same
          contradiction
        case inr h₀ =>
          exact ⟨inp, h₀, h₁⟩

  all_goals simpa [ReachableMemory.add]
