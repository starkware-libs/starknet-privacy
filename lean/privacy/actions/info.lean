import privacy.utils
import privacy.actions.server_actions
import privacy.actions.action_spec

--------------
-- Register --
--------------

structure RegisterInfo (crypto: Crypto) (inp: RegisterInput) (m: Memory) where
  m': Memory
  h_m': m' = (register crypto inp m |> process_action crypto m).m
  kalice_private_key: inp.kalice ∈ crypto.PrivateKeys
  alice_was_not_registered: m .PublicKeys [inp.addralice] = 0
  no_change: ∀ t, ∀ x,
    (t, x) ≠ (.PublicKeys, [inp.addralice]) →
    m' t x = m t x
  memory_diff₀: m' .PublicKeys [inp.addralice] = inp.Kalice crypto

def register_info
    (crypto: Crypto) (inp: RegisterInput) (m: Memory)
    (success: (register crypto inp m |> process_action crypto m).success = true) :
    RegisterInfo crypto inp m := by
  let m' := (register crypto inp m |> process_action crypto m).m
  simp only [Bool.and_eq_true] at success
  have ⟨success₀, success₁⟩ := success
  simp only [register, decide_eq_true_eq] at success₀
  let kalice_private_key := success₀

  simp [register, ServerAction.run_all, ServerAction.run] at success₁
  have alice_was_not_registered := success₁

  exact {
    m' := m'
    h_m':= by rfl,
    kalice_private_key := kalice_private_key,
    alice_was_not_registered := alice_was_not_registered,
    no_change := by
      intro t x h₀
      simp [m', h₀, register, ServerAction.run_all, ServerAction.run]
    memory_diff₀ := by simp [m', register, ServerAction.run_all, ServerAction.run]
  }

theorem RegisterInfo.events (_: RegisterInfo crypto inp m) :
    (register crypto inp m |> process_action crypto m).events =
    [.Register inp.addralice (crypto.enc crypto.council_pub_key [inp.kalice])] := by
  simp [register, get_events, register]

--------------------
-- Create Channel --
--------------------

structure CreateChannelInfo (crypto: Crypto) (inp: CreateChannelInput) (m: Memory) where
  m': Memory
  h_m': m' = (create_channel crypto inp m |> process_action crypto m).m
  j: ℕ
  h_j: j = m .ChannelsJ [inp.addrbob]
  h_Kbob: m .PublicKeys [inp.addrbob] = inp.Kbob
  bob_registered: inp.Kbob ≠ 0
  alice_registered: m .PublicKeys [inp.addralice] = crypto.priv_to_pub inp.kalice
  kalice_valid: inp.kalice ∈ crypto.PrivateKeys
  r_ne_zero: inp.r ≠ 0
  prev_outgoing_exists: inp.s = 0 ∨ m .OutgoingChannels [inp.prev_outgoing_channel_id crypto, 0] ≠ 0
  channel_didnt_exist: m .ChannelHashes [inp.channel_hash crypto] = 0
  outgoing_channel_didnt_exist: m .OutgoingChannels [inp.outgoing_channel_id crypto, 0] = 0
  no_change: ∀ t, ∀ x, (
    (t, x) ≠ (.ChannelsJ, [inp.addrbob]) ∧
    (t, x) ≠ (.Channels, [inp.addrbob, j]) ∧
    (t, x) ≠ (.ChannelHashes, [inp.channel_hash crypto]) ∧
    (t, x) ≠ (.OutgoingChannels, [inp.outgoing_channel_id crypto, 0]) ∧
    (t, x) ≠ (.OutgoingChannels, [inp.outgoing_channel_id crypto, 1])
  ) → m' t x = m t x
  memory_diff₀: m' .ChannelsJ [inp.addrbob] = m .ChannelsJ [inp.addrbob] + 1
  memory_diff₁: m' .Channels [inp.addrbob, j] = inp.enc crypto
  memory_diff₂: m' .ChannelHashes [inp.channel_hash crypto] = 1
  memory_diff₃: m' .OutgoingChannels [inp.outgoing_channel_id crypto, 0] = inp.r
  memory_diff₄: m' .OutgoingChannels [inp.outgoing_channel_id crypto, 1] = inp.enc_addrbob crypto

def create_channel_info
  (crypto: Crypto) (inp: CreateChannelInput) (m: Memory)
  (success: (create_channel crypto inp m |> process_action crypto m).success = true) : CreateChannelInfo crypto inp m := by
  let m' := (create_channel crypto inp m |> process_action crypto m).m
  let c := crypto.hash [inp.addralice, inp.kalice, inp.addrbob, inp.Kbob]
  let j := m .ChannelsJ [inp.addrbob]

  rw [Bool.and_eq_true] at success
  have ⟨success₀, success₁⟩ := success
  rw [create_channel] at success₀
  dsimp only [ne_eq] at success₀
  simp only [Bool.decide_and, decide_not, Bool.decide_or, Bool.and_eq_true, Bool.not_eq_eq_eq_not,
    Bool.not_true, decide_eq_false_iff_not, Bool.or_eq_true, decide_eq_true_eq] at success₀

  let ⟨bob_registered, alice_registered, kalice_valid, r_ne_zero, prev_outgoing_exists⟩ := success₀

  simp [ServerAction.run_all, create_channel, ServerAction.run, List.foldl_cons, List.foldl_nil, write_ne] at success₁
  have ⟨⟨⟨channel_didnt_exist, h_Kbob⟩, outgoing_channel_didnt_exist⟩, _⟩ := success₁

  exact {
    m' := m'
    h_m':= by rfl
    j := j,
    h_j := by rfl
    h_Kbob := h_Kbob,
    bob_registered := bob_registered,
    alice_registered := alice_registered,
    kalice_valid := kalice_valid,
    channel_didnt_exist := channel_didnt_exist,
    r_ne_zero := r_ne_zero,
    prev_outgoing_exists := prev_outgoing_exists,
    outgoing_channel_didnt_exist := outgoing_channel_didnt_exist,
    no_change := by
      intro t x ⟨h₀, h₁, h₂, h₃, h₄⟩
      simp [m', h₂, h₃, h₄, create_channel, ServerAction.run_all, ServerAction.run]
      rw [write_ne h₁]
      simp [h₀]
    memory_diff₀ := by simp [m', create_channel, ServerAction.run_all, ServerAction.run]
    memory_diff₁ := by
      simp [m', create_channel, ServerAction.run_all, ServerAction.run]
      rw [write_eq]
    memory_diff₂ := by simp [m', create_channel, ServerAction.run_all, ServerAction.run]
    memory_diff₃ := by simp [m', create_channel, ServerAction.run_all, ServerAction.run]
    memory_diff₄ := by simp [m', create_channel, ServerAction.run_all, ServerAction.run]
  }

-----------------------
-- Create Subchannel --
-----------------------

structure CreateSubchannelInfo (crypto: Crypto) (inp: CreateSubchannelInput) (m: Memory) where
  m': Memory
  h_m': m' = (create_subchannel crypto inp m |> process_action crypto m).m
  r_ne_zero: inp.r ≠ 0
  channel_exists: m .ChannelHashes [crypto.hash [inp.c, inp.addralice, inp.addrbob, inp.Kbob]] ≠ 0
  prev_subchannel_exists: inp.k₁ = 0 ∨ m .SubchannelTokens [crypto.hash [inp.c, inp.k₀, inp.k₁ - 1], 0] ≠ 0
  old_token_was_zero: m .SubchannelTokens [inp.subchannel_id crypto, 0] = 0
  old_hash_was_zero: m .SubchannelHashes [inp.subchannel_hash crypto] = 0
  k₀_lt_MAX_K₀: inp.k₀ < crypto.MAX_K₀
  no_change: ∀ t, ∀ x,
    (t, x) ≠ (.SubchannelHashes, [inp.subchannel_hash crypto]) →
    (t, x) ≠ (.SubchannelTokens, [inp.subchannel_id crypto, 0]) →
    (t, x) ≠ (.SubchannelTokens, [inp.subchannel_id crypto, 1]) →
    m' t x = m t x
  memory_diff₀: m' .SubchannelTokens [inp.subchannel_id crypto, 0] = inp.r
  memory_diff₁: m' .SubchannelTokens [inp.subchannel_id crypto, 1] = inp.enc crypto
  memory_diff₂: m' .SubchannelHashes [inp.subchannel_hash crypto] = 1

def create_subchannel_info
  (crypto: Crypto) (inp: CreateSubchannelInput) (m: Memory)
  (success: (create_subchannel crypto inp m |> process_action crypto m).success = true)
  : CreateSubchannelInfo crypto inp m := by
  let m' := (create_subchannel crypto inp m |> process_action crypto m).m

  unfold create_subchannel at success
  simp only [Bool.and_eq_true] at success
  have ⟨success₀, success₁⟩ := success
  simp only [ne_eq, bne_iff_ne, Bool.decide_and, decide_not, Bool.decide_or,
    Bool.and_eq_true, Bool.not_eq_eq_eq_not, Bool.not_true, decide_eq_false_iff_not,
    Bool.or_eq_true, decide_eq_true_eq] at success₀ success₁

  let ⟨r_ne_zero, channel_exists, prev_subchannel_exists, k₀_lt_MAX_K₀⟩ := success₀
  simp only [ServerAction.run_all, ServerAction.run, List.foldl_cons, Bool.true_and,
    ne_eq, Prod.mk.injEq, reduceCtorEq, List.cons.injEq, List.ne_cons_self, and_false, and_self,
    not_false_eq_true, write_ne, List.foldl_nil, Bool.and_eq_true, decide_eq_true_eq] at success₁
  have ⟨⟨old_token_was_zero, old_token_was_zero'⟩, old_hash_was_zero⟩ := success₁

  exact {
    m' := m'
    h_m':= by rfl
    r_ne_zero := r_ne_zero,
    channel_exists := channel_exists,
    prev_subchannel_exists := prev_subchannel_exists,
    old_token_was_zero := old_token_was_zero,
    old_hash_was_zero := old_hash_was_zero,
    k₀_lt_MAX_K₀ := k₀_lt_MAX_K₀,
    no_change := by
      intro t x h₀ h₁ h₂
      simp [m', h₀, h₁, h₂, create_subchannel, ServerAction.run_all, ServerAction.run]
    memory_diff₀ := by simp [m', create_subchannel, ServerAction.run_all, ServerAction.run]
    memory_diff₁ := by simp [m', create_subchannel, ServerAction.run_all, ServerAction.run]
    memory_diff₂ := by simp [m', create_subchannel, ServerAction.run_all, ServerAction.run]
  }

-----------------
-- Create Note --
-----------------

structure CreateNoteInfo (crypto: Crypto) (inp: CreateNoteInput) (m: Memory) where
  m': Memory
  h_m': m' = (create_note crypto inp m |> process_action crypto m).m
  no_change: ∀ t, ∀ x,
    (t, x) ≠ (.Notes, [inp.note_id crypto, 0]) →
    (t, x) ≠ (.OpenNoteToken, [inp.note_id crypto]) →
    m' t x = m t x
  r_ne_zero: inp.r ≠ 0
  old_value_was_zero: m .Notes [inp.note_id crypto, 0] = 0
  prev_note_exists: inp.i₁ = 0 ∨ m .Notes [crypto.hash [inp.c crypto, inp.token, inp.i₀, inp.i₁ - 1], 0] ≠ 0
  i₀_lt_MAX_I₀: inp.i₀ < crypto.MAX_I₀
  subchannel_exists : m .SubchannelHashes [crypto.hash [inp.c crypto, inp.addrbob, inp.Kbob, inp.token]] ≠ 0
  memory_diff₀: m' .Notes [inp.note_id crypto, 0] = crypto.pack inp.r (inp.enc crypto)
  memory_diff₁: m' .OpenNoteToken [inp.note_id crypto] = if inp.r = 1 then inp.token else 0

def create_note_info
  (crypto: Crypto) (inp: CreateNoteInput) (m: Memory)
  (success: (create_note crypto inp m |> process_action crypto m).success = true) : CreateNoteInfo crypto inp m := by
  let m' := (create_note crypto inp m |> process_action crypto m).m

  simp only [Bool.and_eq_true] at success
  have ⟨success₀, success₁⟩ := success
  simp [create_note] at success₀
  let ⟨r_ne_zero, prev_note_exists, i₀_lt_MAX_I₀, subchannel_exists⟩ := success₀

  simp only [ServerAction.run_all, ServerAction.run, create_note] at success₁
  simp only [Bool.decide_and, List.foldl_cons, Bool.true_and, Bool.and_true, List.foldl_nil,
    decide_eq_true_eq] at success₁
  have old_value_was_zero := success₁
  exact {
    m' := m'
    h_m':= by rfl
    r_ne_zero := r_ne_zero
    old_value_was_zero := old_value_was_zero
    prev_note_exists := prev_note_exists
    i₀_lt_MAX_I₀ := i₀_lt_MAX_I₀
    subchannel_exists := subchannel_exists
    no_change := by
      intro t x h₀ h₁
      simp [m', h₀, h₁, create_note, ServerAction.run_all, ServerAction.run]
    memory_diff₀ := by simp [m', create_note, ServerAction.run_all, ServerAction.run]
    memory_diff₁ := by simp [m', create_note, ServerAction.run_all, ServerAction.run]
  }

-----------------
-- Cancel Note --
-----------------

structure CancelNoteInfo (crypto: Crypto) (inp: CancelNoteInput) (m: Memory) where
  m': Memory
  h_m': m' = (cancel_note crypto inp m |> process_action crypto m).m
  subchannel_exists: m .SubchannelHashes [crypto.hash [inp.c, inp.addrbob, inp.Kbob crypto, inp.token]] ≠ 0
  nullifier_didnt_exist: m .Nullifiers [inp.nullifier crypto] = 0
  r_ne_zero: m .Notes [inp.note_id crypto, 0] ≠ 0
  h_amount: note_amount crypto m (inp.note_id crypto) inp.c = inp.amount
  kbob_private_key: inp.kbob ∈ crypto.PrivateKeys
  amount_ne_zero: inp.amount ≠ 0
  no_change: ∀ t, ∀ x,
    (t, x) ≠ (.Nullifiers, [inp.nullifier crypto]) →
    m' t x = m t x
  memory_diff₀: m' .Nullifiers [inp.nullifier crypto] = 1

def cancel_note_info
  (crypto: Crypto) (inp: CancelNoteInput) (m: Memory)
  (success: (cancel_note crypto inp m |> process_action crypto m).success = true) : CancelNoteInfo crypto inp m := by
  let m' := (cancel_note crypto inp m |> process_action crypto m).m

  simp only [Bool.and_eq_true] at success
  have ⟨success₀, success₁⟩ := success
  simp only [cancel_note, ne_eq, Bool.decide_and, decide_not, Bool.and_eq_true,
    Bool.not_eq_eq_eq_not, Bool.not_true, decide_eq_false_iff_not, decide_eq_true_eq] at success₀
  let ⟨subchannel_exists, r_ne_zero, h_amount, kbob_private_key, amount_ne_zero⟩ := success₀

  simp [cancel_note, ServerAction.run_all, ServerAction.run] at success₁
  have nullifier_didnt_exist := success₁

  exact {
    m' := m'
    h_m':= by rfl
    subchannel_exists := subchannel_exists,
    nullifier_didnt_exist := nullifier_didnt_exist,
    r_ne_zero := r_ne_zero,
    h_amount := h_amount,
    kbob_private_key := kbob_private_key,
    amount_ne_zero := amount_ne_zero,
    no_change := by
      intro t x h₀
      simp [m', h₀, cancel_note, ServerAction.run_all, ServerAction.run]
    memory_diff₀ := by
      simp [m', cancel_note, ServerAction.run_all, ServerAction.run]
  }

-------------
-- Deposit --
-------------

structure OpenDepositInfo (crypto: Crypto) (inp: OpenDepositInput) (m: Memory) where
  m': Memory
  h_m': m' = (open_deposit crypto inp m |> process_action crypto m).m
  old_value: m .Notes [inp.note_id, 0] = crypto.pack 1 0
  open_note_token: m .OpenNoteToken [inp.note_id] = inp.token
  no_change: ∀ t, ∀ x,
    (t, x) ≠ (.Notes, [inp.note_id, 0]) →
    m' t x = m t x
  memory_diff₀: m' .Notes [inp.note_id, 0] = crypto.pack 1 inp.amount

def open_deposit_info
  (crypto: Crypto) (inp: OpenDepositInput) (m: Memory)
  (success: (open_deposit crypto inp m |> process_action crypto m).success = true) : OpenDepositInfo crypto inp m := by
  let m' := (open_deposit crypto inp m |> process_action crypto m).m

  simp only [Bool.and_eq_true] at success
  have ⟨_, success₁⟩ := success

  simp [open_deposit, ServerAction.run_all, ServerAction.run] at success₁
  have ⟨old_value, open_note_token⟩ := success₁

  exact {
    m' := m'
    h_m':= by rfl
    old_value := old_value,
    open_note_token := open_note_token,
    no_change := by
      intro t x h₀
      simp [m', h₀, open_deposit, ServerAction.run_all, ServerAction.run]
    memory_diff₀ := by simp [m', open_deposit, ServerAction.run_all, ServerAction.run]
  }
