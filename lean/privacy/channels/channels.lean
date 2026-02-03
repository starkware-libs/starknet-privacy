import privacy.utils
import privacy.actions
import privacy.registration

--------------------
-- Channel exists --
--------------------

def channel_exists (crypto: Crypto) (m: Memory) (c: ℕ) : Prop :=
  ∃ (addralice addrbob Kbob: ℕ),
    m .ChannelHashes [crypto.hash [c, addralice, addrbob, Kbob]] ≠ 0

structure ChannelImplies
    {crypto: Crypto} (rm: ReachableMemory crypto) (inp: OpenChannelInput) where
  h_action: .OpenChannel inp ∈ rm.actions
  success: ∃ rm₀: ReachableMemory crypto, ∃ success, rm.extends (rm₀.add (.OpenChannel inp) success)
  kbob: crypto.PrivateKeys
  h_Kbob: inp.Kbob = crypto.priv_to_pub kbob
  alice_registered: RegisterImplies rm ⟨inp.addralice, inp.kalice⟩
  bob_registered: RegisterImplies rm ⟨inp.addrbob, kbob⟩
  channel_hashes: rm.m .ChannelHashes [crypto.hash [inp.c crypto, inp.addralice, inp.addrbob, inp.Kbob]] ≠ 0
  j: ℕ
  h_j_lt: j < rm.m .ChannelsJ [inp.addrbob]
  channel_enc: rm.m .Channels [inp.addrbob, j] = inp.enc crypto

abbrev ChannelImplies.c
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenChannelInput}
    (_: ChannelImplies rm inp) : ℕ :=
  inp.c crypto

theorem ChannelImplies.h_channel_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenChannelInput}
    (channel_imp: ChannelImplies rm inp) :
    channel_exists crypto rm (inp.c crypto) :=
  ⟨inp.addralice, inp.addrbob, inp.Kbob, by simp [channel_imp.channel_hashes]⟩

theorem ChannelImplies.next
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenChannelInput}
    {action: Action} (success: (run_action crypto action rm.m).success)
    (channel_imp: ChannelImplies rm inp) :
    Nonempty (ChannelImplies (rm.add action success) inp) := by
  have ⟨rm₀, h_success, ℓ, h_extends⟩ := channel_imp.success
  unfold ReachableMemory.add at h_extends
  refine ⟨{
    h_action := by simp [channel_imp.h_action],
    success := ⟨rm₀, h_success, action::ℓ, by simp [h_extends]⟩,
    kbob := channel_imp.kbob,
    h_Kbob := channel_imp.h_Kbob,
    alice_registered := channel_imp.alice_registered.next success,
    bob_registered := channel_imp.bob_registered.next success,
    channel_hashes := ?_
    h_j_lt := ?_,
    j := channel_imp.j,
    channel_enc := ?_
  }⟩

  · cases action
    case OpenChannel inp' =>
      let info := open_channel_info crypto inp' rm success
      rw [rm.add_m, run_action, ←info.h_m']
      by_cases h_is_same: inp.channel_hash crypto = inp'.channel_hash crypto
      case pos =>
        rw [←OpenChannelInput.channel_hash, h_is_same]
        simp [info.memory_diff₂]
      case neg =>
        rw [info.no_change _ _ (by simp; simp [h_is_same])]
        exact channel_imp.channel_hashes
    all_goals exact channel_imp.channel_hashes

  · cases action
    case OpenChannel inp' =>
      let info := open_channel_info crypto inp' rm success
      rw [rm.add_m, run_action, ←info.h_m']
      by_cases h_addrbob: inp.addrbob = inp'.addrbob
      case pos =>
        rw [h_addrbob, info.memory_diff₀]
        have := h_addrbob ▸ channel_imp.h_j_lt
        omega
      case neg =>
        rw [info.no_change _ _ (by simp [h_addrbob])]
        exact channel_imp.h_j_lt

    all_goals exact channel_imp.h_j_lt

  · cases action
    case OpenChannel inp' =>
      let info := open_channel_info crypto inp' rm success
      rw [rm.add_m, run_action, ←info.h_m']
      have h: inp.addrbob = inp'.addrbob → ¬channel_imp.j = info.j := by
        intro h_addrbob
        by_contra h'
        have := channel_imp.h_j_lt
        simp [h_addrbob, info.h_j, h'] at this
      rw [info.no_change _ _ (by simpa)]
      exact channel_imp.channel_enc

    all_goals exact channel_imp.channel_enc

theorem ChannelImplies.from_action
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenChannelInput}
    (h: .OpenChannel inp ∈ rm.actions) :
    Nonempty (ChannelImplies rm inp) := by
  revert rm
  apply ReachableMemory.induction
  case inv₀ => simp

  intro action rm ih success h
  cases h
  case head =>
    let info := open_channel_info crypto inp rm success
    have ⟨kbob, res_bob⟩ := RegisterImplies.from_public_key (info.h_Kbob ▸ info.bob_registered)
    have : rm.m MemoryType.PublicKeys [inp.addralice] ≠ 0 := by
      rw [info.alice_registered]
      exact crypto.zero_not_public_key ⟨inp.kalice, info.kalice_valid⟩
    have ⟨kalice, res_alice⟩ := RegisterImplies.from_public_key this
    have h_kalice : kalice = inp.kalice := by
      apply crypto.priv_to_pub_inj (by simp) info.kalice_valid
      rw [←info.alice_registered, res_alice.public_key]

    exact ⟨{
      h_action := by simp
      success := ⟨rm, success, [], by simp⟩,
      kbob := kbob
      h_Kbob := by rw [←info.h_Kbob, res_bob.public_key]
      alice_registered := h_kalice ▸ res_alice.next success
      bob_registered := res_bob.next success
      channel_hashes := by rw [rm.add_m, run_action, ←info.h_m', info.memory_diff₂]; simp
      j := info.j
      h_j_lt := by rw [rm.add_m, run_action, ←info.h_m', info.memory_diff₀, info.h_j]; simp
      channel_enc := by rw [rm.add_m, run_action, ←info.h_m', info.memory_diff₁]
    }⟩

  case tail h =>
    have ⟨ih⟩ := ih h
    exact ih.next success

-- Channel hash entry implies c is a valid channel id and Kbob is a valid public key.
theorem ChannelImplies.from_channel_hashes
    {crypto: Crypto} {rm: ReachableMemory crypto} {c addralice addrbob Kbob: ℕ}
    (h: rm.m .ChannelHashes [crypto.hash [c, addralice, addrbob, Kbob]] ≠ 0) :
    ∃ (kalice s r: ℕ) (res: ChannelImplies rm ⟨addralice, kalice, addrbob, Kbob, s, r⟩),
    res.c = c := by
  suffices h' : ∃ kalice s r: ℕ,
      (.OpenChannel ⟨addralice, kalice, addrbob, Kbob, s, r⟩) ∈ rm.actions ∧
      c = crypto.hash [addralice, kalice, addrbob, Kbob] from by
    obtain ⟨kalice, s, r, h'⟩ := h'
    have ⟨res⟩ := ChannelImplies.from_action h'.1
    use kalice, s, r, res
    simp [ChannelImplies.c, OpenChannelInput.c, h'.2]

  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; trivial

  intro action rm ih success h
  cases action
  case OpenChannel inp =>
    let info := open_channel_info crypto inp rm success
    dsimp only [ReachableMemory.add, ReachableMemory.m] at h
    rw [run_all_cons₁, run_action, ←info.h_m'] at h

    by_cases h_is_same: c = inp.c crypto ∧ addralice = inp.addralice ∧ addrbob = inp.addrbob ∧ Kbob = inp.Kbob
    case pos =>
      simp only [h_is_same]
      use inp.kalice, inp.s, inp.r, by simp
    case neg =>
      rw [info.no_change _ _  (by
        simp only [ne_eq, Prod.mk.injEq, reduceCtorEq, List.cons.injEq, and_true, false_and,
          not_false_eq_true, List.ne_cons_self, and_false, and_self, true_and]
        by_contra h'
        apply crypto.h_hash at h'
        repeat injection h' with _ h'
        simp [*] at h_is_same
      )] at h
      have ⟨kalice, s, r, ⟨h_actions, h_c⟩⟩ := ih h
      use kalice, s, r, by simp [h_actions]

  all_goals
    have ⟨kalice, s, r, ⟨h_actions, h_c⟩⟩ := ih h
    use kalice, s, r, by simp [h_actions]

theorem ChannelImplies.same_c
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenChannelInput}
    (channel_imp: ChannelImplies rm inp)
    {addralice kalice addrbob Kbob: ℕ}
    (h: channel_imp.c = crypto.hash [addralice, kalice, addrbob, Kbob]) :
    addralice = inp.addralice ∧ kalice = inp.kalice ∧ addrbob = inp.addrbob ∧ Kbob = inp.Kbob := by
  apply crypto.h_hash at h; injections; simp [*]

theorem ChannelImplies.same_c_priv
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: OpenChannelInput}
    (channel_imp: ChannelImplies rm inp)
    {addralice kalice addrbob: ℕ}
    {kbob: crypto.PrivateKeys}
    (h: channel_imp.c = crypto.hash [addralice, kalice, addrbob, crypto.priv_to_pub kbob]) :
    addralice = inp.addralice ∧ kalice = inp.kalice ∧ addrbob = inp.addrbob ∧ kbob = channel_imp.kbob := by
  have := channel_imp.same_c h
  simp only [*, true_and]
  apply Subtype.coe_inj.1
  apply crypto.priv_to_pub_inj (by simp) (by simp)
  simp [this.2.2.2, channel_imp.h_Kbob]

theorem ChannelImplies.from_channel_exists
    {crypto: Crypto} {rm: ReachableMemory crypto} {c: ℕ}
    (h: channel_exists crypto rm c) :
    ∃ (inp: OpenChannelInput) (channel_imp: ChannelImplies rm inp),
    channel_imp.c = c := by
  replace ⟨addralice, addrbob, Kbob, h⟩ := h
  have ⟨kalice, s, r, ⟨channel_imp, h_c⟩⟩ := ChannelImplies.from_channel_hashes h
  use ⟨addralice, kalice, addrbob, Kbob, s, r⟩, channel_imp
