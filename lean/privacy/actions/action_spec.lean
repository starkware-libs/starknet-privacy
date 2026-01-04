import privacy.utils
import privacy.actions.server_actions

--------------
-- Register --
--------------

structure RegisterInput where
  (addrbob kbob: ℕ)

abbrev RegisterInput.Kbob (crypto: Crypto) (inp: RegisterInput) : ℕ :=
  crypto.priv_to_pub inp.kbob

def register (crypto: Crypto) (inp: RegisterInput) (_: Memory) : List ServerAction × Bool :=
  ([
    .Write .PublicKeys [inp.addrbob] (inp.Kbob crypto),
  ], inp.kbob ∈ crypto.PrivateKeys)

--------------------
-- Create Channel --
--------------------

structure CreateChannelInput where
  (kalice Kbob addralice addrbob: ℕ)


abbrev CreateChannelInput.c (crypto: Crypto) (inp: CreateChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.addrbob, inp.Kbob]

abbrev CreateChannelInput.enc (crypto: Crypto) (inp: CreateChannelInput) : ℕ :=
  crypto.enc inp.Kbob [inp.c crypto, inp.addralice]

abbrev CreateChannelInput.channel_hash (crypto: Crypto) (inp: CreateChannelInput) : ℕ :=
  crypto.hash [inp.c crypto, inp.addralice, inp.addrbob, inp.Kbob]

def create_channel (crypto: Crypto) (inp: CreateChannelInput) (_: Memory) : List ServerAction × Bool :=
  ([
    .Append .ChannelsJ .Channels [inp.addrbob, inp.Kbob] (inp.enc crypto) (by simp),
    .WriteOnce .ChannelHashes [inp.channel_hash crypto] 1,
    .Check .PublicKeys [inp.addrbob] inp.Kbob,
  ], inp.Kbob ≠ 0)

-----------------------
-- Create Subchannel --
-----------------------

structure CreateSubchannelInput where
  (c addralice addrbob Kbob token k₀ k₁ r: ℕ)

abbrev CreateSubchannelInput.subchannel_id (crypto: Crypto) (inp: CreateSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.k₀, inp.k₁]

abbrev CreateSubchannelInput.enc (crypto: Crypto) (inp: CreateSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.r] + inp.token

abbrev CreateSubchannelInput.subchannel_hash (crypto: Crypto) (inp: CreateSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.addrbob, inp.Kbob, inp.token]

def create_subchannel (crypto: Crypto) (inp: CreateSubchannelInput) (m: Memory) : List ServerAction × Bool :=
  let channel_exists := m .ChannelHashes [crypto.hash [inp.c, inp.addralice, inp.addrbob, inp.Kbob]] ≠ 0
  let prev_subchannel_exists := inp.k₁ = 0 ∨ m .Tokens [crypto.hash [inp.c, inp.k₀, inp.k₁ - 1], 0] != 0
  ([
    .WriteOnce .Tokens [inp.subchannel_id crypto, 0] inp.r,
    .Write .Tokens [inp.subchannel_id crypto, 1] (inp.enc crypto),
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
  (if inp.r = 1 then 0 else crypto.hash [inp.c crypto, inp.r]) + inp.amount

def create_note (crypto: Crypto) (inp: CreateNoteInput) (m: Memory) : List ServerAction × Bool :=
  let c := inp.c crypto
  let note_id := inp.note_id crypto
  let subchannel_exists := m .SubchannelHashes [crypto.hash [c, inp.addrbob, inp.Kbob, inp.token]] ≠ 0
  let prev_note_exists := inp.i₁ = 0 ∨ m .Notes [crypto.hash [c, inp.token, inp.i₀, inp.i₁ - 1], 0] ≠ 0
  ([
    .WriteOnce .Notes [note_id, 0] (crypto.pack inp.r (inp.enc crypto)),
    .Write .OpenNoteToken [note_id] (if inp.r = 1 then inp.token else 0),
  ], inp.r ≠ 0 ∧ prev_note_exists ∧ inp.i₀ < crypto.MAX_I₀ ∧ subchannel_exists)

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
  let dec_amount := note_amount crypto m (inp.note_id crypto) inp.c
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
  | CreateChannel (inp: CreateChannelInput)
  | CreateSubchannel (inp: CreateSubchannelInput)
  | CreateNote (inp: CreateNoteInput)
  | CancelNote (inp: CancelNoteInput)
  | OpenDeposit (inp: OpenDepositInput)
