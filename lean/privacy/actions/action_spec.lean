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
  (q r: ℕ)

abbrev OpenChannelInput.c (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.addrbob, inp.Kbob]

abbrev OpenChannelInput.enc (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.enc inp.Kbob [inp.c crypto, inp.addralice]

abbrev OpenChannelInput.channel_marker (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.c crypto, inp.addralice, inp.addrbob, inp.Kbob]

abbrev OpenChannelInput.prev_outgoing_channel_id (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.q - 1]

abbrev OpenChannelInput.outgoing_channel_id (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.q]

abbrev OpenChannelInput.enc_addrbob (crypto: Crypto) (inp: OpenChannelInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.q, inp.r] + inp.addrbob

def open_channel (crypto: Crypto) (inp: OpenChannelInput) (m: Memory) : List ServerAction × Bool :=
  let alice_registered := m .PublicKeys [inp.addralice] = crypto.priv_to_pub inp.kalice
  let prev_outgoing_exists := inp.q = 0 ∨ m .OutgoingChannels [inp.prev_outgoing_channel_id crypto, 0] ≠ 0
  ([
    .ReadAssert .PublicKeys [inp.addrbob] inp.Kbob,
    .Append .ChannelsJ .Channels [inp.addrbob] (inp.enc crypto) (by simp),
    .WriteOnce .ChannelMarkers [inp.channel_marker crypto] 1,
    .WriteOnce .OutgoingChannels [inp.outgoing_channel_id crypto, 0] inp.r,
    .WriteOnce .OutgoingChannels [inp.outgoing_channel_id crypto, 1] (inp.enc_addrbob crypto),
  ], inp.Kbob ≠ 0 ∧ alice_registered ∧ inp.kalice ∈ crypto.PrivateKeys ∧ inp.r ≠ 0 ∧ prev_outgoing_exists)

-----------------------
-- Open Subchannel --
-----------------------

structure OpenSubchannelInput where
  (c addralice addrbob Kbob token k r: ℕ)

abbrev OpenSubchannelInput.subchannel_id (crypto: Crypto) (inp: OpenSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.k]

abbrev OpenSubchannelInput.enc (crypto: Crypto) (inp: OpenSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.k, inp.r] + inp.token

abbrev OpenSubchannelInput.subchannel_marker (crypto: Crypto) (inp: OpenSubchannelInput) : ℕ :=
  crypto.hash [inp.c, inp.addrbob, inp.Kbob, inp.token]

def open_subchannel (crypto: Crypto) (inp: OpenSubchannelInput) (m: Memory) : List ServerAction × Bool :=
  let channel_exists := m .ChannelMarkers [crypto.hash [inp.c, inp.addralice, inp.addrbob, inp.Kbob]] ≠ 0
  let prev_subchannel_exists := inp.k = 0 ∨ m .SubchannelTokens [crypto.hash [inp.c, inp.k - 1], 0] != 0
  ([
    .WriteOnce .SubchannelTokens [inp.subchannel_id crypto, 0] inp.r,
    .WriteOnce .SubchannelTokens [inp.subchannel_id crypto, 1] (inp.enc crypto),
    .WriteOnce .SubchannelMarkers [inp.subchannel_marker crypto] 1,
  ], inp.r ≠ 0 ∧ channel_exists ∧ prev_subchannel_exists)

-----------------
-- Create Note --
-----------------

structure CreateNoteInput where
  (addralice kalice addrbob Kbob token i r amount: ℕ)

abbrev CreateNoteInput.c (crypto: Crypto) (inp: CreateNoteInput) : ℕ :=
  crypto.hash [inp.addralice, inp.kalice, inp.addrbob, inp.Kbob]

abbrev CreateNoteInput.note_id (crypto: Crypto) (inp: CreateNoteInput) : ℕ :=
  crypto.hash [inp.c crypto, inp.token, inp.i]

abbrev CreateNoteInput.enc (crypto: Crypto) (inp: CreateNoteInput) : ℕ :=
  (if inp.r = 1 then 0 else crypto.hash [inp.c crypto, inp.token, inp.i, inp.r]) + inp.amount

def create_note (crypto: Crypto) (inp: CreateNoteInput) (m: Memory) : List ServerAction × Bool :=
  let c := inp.c crypto
  let note_id := inp.note_id crypto
  let subchannel_exists := m .SubchannelMarkers [crypto.hash [c, inp.addrbob, inp.Kbob, inp.token]] ≠ 0
  let prev_note_exists := inp.i = 0 ∨ m .Notes [crypto.hash [c, inp.token, inp.i - 1], 0] ≠ 0
  ([
    .WriteOnce .Notes [note_id, 0] (crypto.pack inp.r (inp.enc crypto)),
    .Write .OpenNoteToken [note_id] (if inp.r = 1 then inp.token else 0),
    .Event (
      if inp.r = 1 then
        .CreateOpenNote note_id (crypto.enc crypto.council_pub_key [inp.addrbob])
      else
        .None
    ),
  ], inp.r ≠ 0 ∧ prev_note_exists ∧ subchannel_exists ∧ (inp.r = 1 → inp.amount = 0))

-----------------
-- Use Note --
-----------------

structure UseNoteInput where
  (c addrbob kbob token i: ℕ)
  -- `amount` is not really an input since it can be computed from the memory and the other inputs.
  -- It is included here for convenience.
  (amount: ℕ)

abbrev UseNoteInput.nullifier (crypto: Crypto) (inp: UseNoteInput) : ℕ :=
  crypto.hash [inp.c, inp.token, inp.i, inp.kbob]

abbrev UseNoteInput.note_id (crypto: Crypto) (inp: UseNoteInput) : ℕ :=
  crypto.hash [inp.c, inp.token, inp.i]

abbrev UseNoteInput.Kbob (crypto: Crypto) (inp: UseNoteInput) : ℕ :=
  crypto.priv_to_pub inp.kbob

def use_note (crypto: Crypto) (inp: UseNoteInput) (m: Memory) : List ServerAction × Bool :=
  let subchannel_exists := m .SubchannelMarkers [crypto.hash [inp.c, inp.addrbob, inp.Kbob crypto, inp.token]] ≠ 0
  let r := m .Notes [inp.note_id crypto, 0]
  let dec_amount := note_amount crypto m (inp.note_id crypto) inp.c inp.token inp.i
  ([
    .WriteOnce .Nullifiers [inp.nullifier crypto] 1,
    .Event (.UseNote (inp.nullifier crypto)),
  ], subchannel_exists ∧ r ≠ 0 ∧ dec_amount = inp.amount ∧ inp.kbob ∈ crypto.PrivateKeys ∧ inp.amount ≠ 0)

-----------------------
-- Open-note deposit --
-----------------------

-- Deposit funds into an open note.
structure OpenDepositInput where
  (note_id amount token: ℕ)

def open_deposit (_crypto: Crypto) (inp: OpenDepositInput) (_m: Memory) : List ServerAction × Bool :=
  ([
    .OpenDeposit inp.note_id inp.amount inp.token
  ], true)

--------------
-- Withdraw --
--------------

structure WithdrawInput where
  (addralice amount token: ℕ)

def WithdrawInput.user_enc (crypto: Crypto) (inp: WithdrawInput) : ℕ :=
  crypto.enc crypto.council_pub_key [inp.addralice]

def withdraw (crypto: Crypto) (inp: WithdrawInput) (_m: Memory) : List ServerAction × Bool :=
  ([
    .Event (.Withdraw (inp.user_enc crypto) inp.amount inp.token)
  ], inp.amount ≠ 0)

------------
-- Action --
------------

inductive Action where
  | Register (inp: RegisterInput)
  | OpenChannel (inp: OpenChannelInput)
  | OpenSubchannel (inp: OpenSubchannelInput)
  | CreateNote (inp: CreateNoteInput)
  | UseNote (inp: UseNoteInput)
  | OpenDeposit (inp: OpenDepositInput)
  | Withdraw (inp: WithdrawInput)

abbrev filter_CreateNote (action: Action) : Option CreateNoteInput :=
  match action with
    | .CreateNote inp => some inp
    | _ => none

theorem filter_CreateNote_some (action: Action) :
    filter_CreateNote action = some inp ↔ action = .CreateNote inp := by
  cases action; all_goals simp

abbrev filter_UseNote (action: Action) : Option UseNoteInput :=
  match action with
    | .UseNote inp => some inp
    | _ => none

theorem filter_UseNote_some (action: Action) :
    filter_UseNote action = some inp ↔ action = .UseNote inp := by
  cases action; all_goals simp

abbrev filter_OpenDeposit (action: Action) : Option OpenDepositInput :=
  match action with
    | .OpenDeposit inp => some inp
    | _ => none

theorem filter_OpenDeposit_some (action: Action) :
    filter_OpenDeposit action = some inp ↔ action = .OpenDeposit inp := by
  cases action; all_goals simp

abbrev filter_Withdraw (action: Action) : Option WithdrawInput :=
  match action with
    | .Withdraw inp => some inp
    | _ => none

theorem filter_Withdraw_some (action: Action) :
    filter_Withdraw action = some inp ↔ action = .Withdraw inp := by
  cases action; all_goals simp
