import privacy.utils
import privacy.actions.server_actions

--------------
-- Register --
--------------

structure RegisterInput where
  (addralice kalice: ℕ)

abbrev RegisterInput.Kalice (crypto: Crypto) (inp: RegisterInput) : ℕ :=
  crypto.priv_to_pub inp.kalice

def register (crypto: Crypto) (inp: RegisterInput) (_: Memory) : List ServerAction × Bool :=
  ([
    .WriteOnce .PublicKeys [inp.addralice] (inp.Kalice crypto),
    .Event (.Register inp.addralice (crypto.enc crypto.council_pub_key [inp.kalice])),
  ], inp.kalice ∈ crypto.PrivateKeys)

--------------------
-- Open Channel --
--------------------

structure OpenChannelInput where
  (addralice kalice addrbob Kbob: ℕ)
  -- Outgoing channel index and random blinding value.
  (s r: ℕ)

abbrev OpenChannelInput.c (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.addrbob, inp.Kbob]

abbrev OpenChannelInput.enc (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.enc inp.Kbob [inp.c crypto, inp.addralice]

abbrev OpenChannelInput.channel_hash (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.c crypto, inp.addralice, inp.addrbob, inp.Kbob]

abbrev OpenChannelInput.prev_outgoing_channel_id (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.s - 1]

abbrev OpenChannelInput.outgoing_channel_id (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.s]

abbrev OpenChannelInput.enc_addrbob (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.s, inp.r] + inp.addrbob

def open_channel (crypto: Crypto) (inp: OpenChannelInput) (m: Memory) : List ServerAction × Bool :=
  let alice_registered := m .PublicKeys [inp.addralice] = crypto.priv_to_pub inp.kalice
  let prev_outgoing_exists := inp.s = 0 ∨ m .OutgoingChannels [inp.prev_outgoing_channel_id crypto, 0] ≠ 0
  ([
    .Append .ChannelsJ .Channels [inp.addrbob] (inp.enc crypto) (by simp),
    .WriteOnce .ChannelHashes [inp.channel_hash crypto] 1,
    .ReadAssert .PublicKeys [inp.addrbob] inp.Kbob,
    .WriteOnce .OutgoingChannels [inp.outgoing_channel_id crypto, 0] inp.r,
    .WriteOnce .OutgoingChannels [inp.outgoing_channel_id crypto, 1] (inp.enc_addrbob crypto),
  ], inp.Kbob ≠ 0 ∧ alice_registered ∧ inp.kalice ∈ crypto.PrivateKeys ∧ inp.r ≠ 0 ∧ prev_outgoing_exists)

-----------------------
-- Open Subchannel --
-----------------------

structure OpenSubchannelInput where
  (c addralice addrbob Kbob token k₀ k₁ r: ℕ)

abbrev OpenSubchannelInput.subchannel_id (crypto: Crypto) (inp: OpenSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.k₀, inp.k₁]

abbrev OpenSubchannelInput.enc (crypto: Crypto) (inp: OpenSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.k₀, inp.k₁, inp.r] + inp.token

abbrev OpenSubchannelInput.subchannel_hash (crypto: Crypto) (inp: OpenSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.addrbob, inp.Kbob, inp.token]

def open_subchannel (crypto: Crypto) (inp: OpenSubchannelInput) (m: Memory) : List ServerAction × Bool :=
  let channel_exists := m .ChannelHashes [crypto.hash [inp.c, inp.addralice, inp.addrbob, inp.Kbob]] ≠ 0
  let prev_subchannel_exists := inp.k₁ = 0 ∨ m .SubchannelTokens [crypto.hash [inp.c, inp.k₀, inp.k₁ - 1], 0] != 0
  ([
    .WriteOnce .SubchannelTokens [inp.subchannel_id crypto, 0] inp.r,
    .WriteOnce .SubchannelTokens [inp.subchannel_id crypto, 1] (inp.enc crypto),
    .WriteOnce .SubchannelHashes [inp.subchannel_hash crypto] 1,
  ], inp.r ≠ 0 ∧ channel_exists ∧ prev_subchannel_exists ∧ inp.k₀ < crypto.MAX_K₀)

-----------------
-- Create Note --
-----------------

structure CreateNoteInput where
  (addralice kalice addrbob Kbob token i₀ i₁ r amount: ℕ)

abbrev CreateNoteInput.c (crypto: Crypto) (inp: CreateNoteInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.addrbob, inp.Kbob]

abbrev CreateNoteInput.note_id (crypto: Crypto) (inp: CreateNoteInput) : ℕ :=
  crypto.hash [inp.c crypto, inp.token, inp.i₀, inp.i₁]

abbrev CreateNoteInput.enc (crypto: Crypto) (inp: CreateNoteInput) : ℕ :=
  (if inp.r = 1 then 0 else crypto.hash [inp.c crypto, inp.token, inp.i₀, inp.i₁, inp.r]) + inp.amount

def create_note (crypto: Crypto) (inp: CreateNoteInput) (m: Memory) : List ServerAction × Bool :=
  let c := inp.c crypto
  let note_id := inp.note_id crypto
  let subchannel_exists := m .SubchannelHashes [crypto.hash [c, inp.addrbob, inp.Kbob, inp.token]] ≠ 0
  let prev_note_exists := inp.i₁ = 0 ∨ m .Notes [crypto.hash [c, inp.token, inp.i₀, inp.i₁ - 1], 0] ≠ 0
  ([
    .WriteOnce .Notes [note_id, 0] (crypto.pack inp.r (inp.enc crypto)),
    .Write .OpenNoteToken [note_id] (if inp.r = 1 then inp.token else 0),
    .Event (
      if inp.r = 1 then
        .CreateOpenNote note_id (crypto.enc crypto.council_pub_key [inp.addrbob])
      else
        .None
    ),
  ], inp.r ≠ 0 ∧ prev_note_exists ∧ inp.i₀ < crypto.MAX_I₀ ∧ subchannel_exists ∧ (inp.r = 1 → inp.amount = 0))

-----------------
-- Cancel Note --
-----------------

structure CancelNoteInput where
  (c addrbob kbob token i₀ i₁: ℕ)
  -- `amount` is not really an input since it can be computed from the memory and the other inputs.
  -- It is included here for convenience.
  (amount: ℕ)

abbrev CancelNoteInput.nullifier (crypto: Crypto) (inp: CancelNoteInput) : ℕ :=
  crypto.hash [inp.c, inp.token, inp.i₀, inp.i₁, inp.kbob]

abbrev CancelNoteInput.note_id (crypto: Crypto) (inp: CancelNoteInput) : ℕ :=
  crypto.hash [inp.c, inp.token, inp.i₀, inp.i₁]

abbrev CancelNoteInput.Kbob (crypto: Crypto) (inp: CancelNoteInput) : ℕ :=
  crypto.priv_to_pub inp.kbob

def cancel_note (crypto: Crypto) (inp: CancelNoteInput) (m: Memory) : List ServerAction × Bool :=
  let subchannel_exists := m .SubchannelHashes [crypto.hash [inp.c, inp.addrbob, inp.Kbob crypto, inp.token]] ≠ 0
  let r := m .Notes [inp.note_id crypto, 0]
  let dec_amount := note_amount crypto m (inp.note_id crypto) inp.c inp.token inp.i₀ inp.i₁
  ([
    .WriteOnce .Nullifiers [inp.nullifier crypto] 1,
  ], subchannel_exists ∧ r ≠ 0 ∧ dec_amount = inp.amount ∧ inp.kbob ∈ crypto.PrivateKeys ∧ inp.amount ≠ 0)

-------------
-- Deposit --
-------------

-- Deposit funds into an open note.
structure OpenDepositInput where
  (note_id amount token: ℕ)

def open_deposit (_crypto: Crypto) (inp: OpenDepositInput) (_m: Memory) : List ServerAction × Bool :=
  ([
    .OpenDeposit inp.note_id inp.amount inp.token
  ], true)

------------
-- Action --
------------

inductive Action where
  | Register (inp: RegisterInput)
  | OpenChannel (inp: OpenChannelInput)
  | OpenSubchannel (inp: OpenSubchannelInput)
  | CreateNote (inp: CreateNoteInput)
  | CancelNote (inp: CancelNoteInput)
  | OpenDeposit (inp: OpenDepositInput)

abbrev filter_CreateNote (action: Action) : Option CreateNoteInput :=
  match action with
    | .CreateNote inp => some inp
    | _ => none

theorem filter_CreateNote_some (action: Action) :
    filter_CreateNote action = some inp ↔ action = .CreateNote inp := by
  cases action; all_goals simp

abbrev filter_CancelNote (action: Action) : Option CancelNoteInput :=
  match action with
    | .CancelNote inp => some inp
    | _ => none

theorem filter_CancelNote_some (action: Action) :
    filter_CancelNote action = some inp ↔ action = .CancelNote inp := by
  cases action; all_goals simp

abbrev filter_OpenDeposit (action: Action) : Option OpenDepositInput :=
  match action with
    | .OpenDeposit inp => some inp
    | _ => none

theorem filter_OpenDeposit_some (action: Action) :
    filter_OpenDeposit action = some inp ↔ action = .OpenDeposit inp := by
  cases action; all_goals simp
