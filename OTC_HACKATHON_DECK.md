---
marp: true
theme: default
size: 16:9
paginate: false
style: |
  section {
    font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
    background: #FAFAF8;
    color: #1A1A1A;
    padding: 64px 88px;
    font-size: 28px;
    line-height: 1.45;
  }
  h1 {
    font-size: 56px;
    font-weight: 800;
    margin: 0 0 0.4em 0;
    color: #111;
    letter-spacing: -0.025em;
    line-height: 1.05;
  }
  h2 {
    font-size: 40px;
    font-weight: 700;
    margin: 0 0 0.5em 0;
    color: #111;
    letter-spacing: -0.015em;
    line-height: 1.1;
  }
  h3 {
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 0.4em 0;
    color: #6B6B6B;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  ul, ol {
    margin: 0.3em 0;
    padding-left: 1.1em;
  }
  li {
    margin: 0.55em 0;
  }
  li::marker {
    color: #C04026;
  }
  strong {
    color: #C04026;
    font-weight: 700;
  }
  em {
    color: #444;
    font-style: italic;
  }
  code {
    font-family: 'JetBrains Mono', 'Menlo', 'Monaco', monospace;
    background: #EFEAE0;
    padding: 0.06em 0.4em;
    border-radius: 4px;
    font-size: 0.88em;
    color: #1A1A1A;
  }
  blockquote {
    border-left: 4px solid #C04026;
    margin: 1em 0;
    padding: 0.2em 0 0.2em 1em;
    color: #333;
    font-style: italic;
    font-size: 28px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.6em 0;
    font-size: 26px;
  }
  th, td {
    padding: 0.55em 0.9em;
    border-bottom: 1px solid #DDD;
    text-align: left;
    vertical-align: top;
  }
  th {
    font-weight: 700;
    color: #6B6B6B;
    font-size: 18px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    border-bottom: 2px solid #1A1A1A;
  }
  .tag {
    display: inline-block;
    background: #111;
    color: #FAFAF8;
    padding: 0.18em 0.7em;
    border-radius: 4px;
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 0.7em;
  }
  .lede {
    font-size: 34px;
    font-weight: 500;
    color: #1A1A1A;
    line-height: 1.35;
    margin: 0.4em 0;
  }
  .accent-bar {
    width: 84px;
    height: 6px;
    background: #C04026;
    margin: 0.6em 0 0.8em 0;
  }
  .subhead {
    font-size: 26px;
    font-weight: 700;
    color: #1A1A1A;
    margin: 0.8em 0 0.15em;
    letter-spacing: -0.005em;
  }
  .subhead:first-of-type {
    margin-top: 0.2em;
  }
  section.title {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  section.title h1 {
    font-size: 104px;
    line-height: 0.95;
  }
  section.title .lede {
    font-size: 34px;
    color: #3A3A3A;
    margin-top: 0.5em;
    max-width: 80%;
  }
  section.demo {
    background: #111;
    color: #FAFAF8;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  section.demo h1 {
    color: #FAFAF8;
    font-size: 128px;
    margin-bottom: 0.4em;
  }
  section.demo .tag {
    background: #C04026;
    color: #FAFAF8;
  }
  section.demo strong { color: #FF7A60; }
  section.demo li::marker { color: #FF7A60; }
  section.demo code {
    background: #2A2A2A;
    color: #EEE;
  }
---

<!-- _class: title -->

<span class="tag">Hackathon · Starknet</span>

# Private OTC

<div class="accent-bar"></div>

<p class="lede">Atomic peer-to-peer trades.<br>
No escrow. No third party. No funds ever locked.</p>

<!--
Thesis in one sentence: OTC trading on a privacy pool — both sides keep their balances private, both legs settle atomically, neither party escrows funds with anyone.
Don't dwell. The demo is doing the selling.
-->

---

<!-- _class: demo -->

<span class="tag">~2 minutes</span>

# Live demo

- Two browsers. Same `trade_id`. Opposite legs.
- One click each — **order doesn't matter**.
- Watch: balances flip atomically. Tampering reverts.

<!--
Alice: "I'll give 100 USD, want 0.005 BTC, trade_id = 0x1234, counterparty = Bob."
Bob: opposite leg, same trade_id.
Both hit submit. Whichever lands second triggers settlement.
Show balances change on both sides — encrypted on chain, plaintext in the UI.
Open the Audit tab → received notes appear with the trade_id as the salt; click Verify, point at the on-chain join_trade tx.
If time: flip Bob's amount mid-trade → tx reverts before any tokens move.
-->

---

### What we changed in the privacy pool

# Proof and execution, **decoupled**

<p class="subhead">Pool change</p>

- Split `apply_actions` → `store_actions` + `apply_stored_actions`.
- **Proof verification** at *store* time. **Execution** at *apply* time.

<p class="subhead">Built on top (our OTC app)</p>

- Apply **both legs atomically** in one tx.
- Use the existing `InvokeExternal` hook to assert a **conditional check** during apply → conditional trades.

<!--
The pool change: the original fused proof-and-execute. You can't bundle two independently-proved actions in one tx that way — each proof binds to a specific block context. Separating them lets the pool hold proven-but-not-yet-applied actions per party.
Built on top: nothing about InvokeExternal was new — that hook was already there. What's new is the helper contract that triggers both applies atomically, and the conditional check pattern we wrap around InvokeExternal (covered in the "How" slide).
Make this distinction explicit when speaking — credits the pool team and shows you understand the layering.
-->

---

### What you get

# A genuinely private OTC trade

- **Private** — amounts and tokens encrypted; only the two parties decrypt.
- **Atomic** — both legs settle in one tx, or neither does.
- **Peer-to-peer** — no third party, no escrow, no lock window.
- **Permissionless** — no identity checks. *Anyone* can submit the txs; only valid proofs settle. Bad proofs simply fail.
- **Symmetric** — both sides submit the same shape of call. No initiator role.
- **Order-independent** — second-to-join automatically settles both.

<!--
Contrast with traditional OTC: trusted desk, KYC choke points, escrow with settlement risk.
Contrast with on-chain DEX: orderbook leaks intent, AMM leaks price impact, both leak balance trails.
Here, the on-chain footprint is encrypted notes — same privacy guarantees as a regular pool transfer.
On "Permissionless": the OTC helper contract has zero identity logic. The security comes from proof validity, not access control. A relayer or even a random observer can submit the txs on the parties' behalf — only the parties hold the keys to produce a valid proof. Bad/forged proofs revert at store time, before any state changes.
-->

---

### How — the key idea

# One proof carries **both halves** of the trade

- Each leg's proof commits to **(a)** transferring to the counterparty, and **(b)** checking the counterparty also transferred — scoped to the same `trade_id`.

- Naïve impl ⇒ **chicken-and-egg deadlock.**

- **Fix:** the helper contract turns the check into *"counterparty transferred me **OR** committed to transfer me here."*

- Net: a check that's **on-chain, private, and token+amount-bound.**

<!--
Walk the deadlock: "If Alice's apply needs Bob's note on chain and Bob's apply needs Alice's, neither can go first."
The OR-clause: when Alice's apply runs second-to-go, Bob's notes already exist on chain → check looks up the actual note. When Bob's apply runs first-to-go, Alice's actions are still committed → check reads Alice's commitment from helper storage. Same condition, two branches.
The salt trick is the privacy magic: a transfer's encrypted note normally depends on a random salt only the sender knows. Fix salt to trade_id, and both parties — and only them — can compute the exact (note_id, packed_value) the counterparty must emit. On-chain check just does equality.
This is what the privacy pool's expressiveness enables. One proof, two intertwined assertions, no extra round-trips.
-->

---

### Proof points

# It works. It can't be cheated.

| Order-agnostic | Tamper-evident |
|----------------|----------------|
| Alice first → settles | Wrong token → revert |
| Bob first → settles | Wrong amount → revert |
| Simultaneous → settles | Wrong recipient → revert |
| | Wrong `trade_id` → never pairs up |

*Videos show the revert + the failing assertion in the explorer.*

<!--
Don't narrate every clip. Queue them, let the failure modes speak.
"Try to cheat by changing X → revert with EXPECTED_NOTE_NOT_FOUND."
-->

---

### What's next

# Match Maker integration

- Alice and Bob submit their conditional proofs to a **Match Maker** — *not* to each other.
- The MM adds the only missing piece: a proof of *"transfer to Alice and transfer to Bob."*
- **Alice and Bob never need to know about each other.** Discovery, matching, and settlement on the fly.
- Add an **enclave** ⇒ even the MM doesn't see the trade details.

<br>

> **Atomic. No lock. Zero trust. Executed on the fly.**
> Today the parties agree off-chain. Tomorrow the Match Maker does it for them — with the same privacy and atomicity guarantees.

<!--
The leap: today both parties have to know they're trading with each other and agree on terms off-chain. With an MM in front, neither party sees the counterparty — they just post a conditional offer ("I'll give X for Y at trade_id Z") and the MM finds the match.
Why this works without breaking our security: the MM never holds funds. It only adds an outer proof that bundles two of our conditional offers into a settled trade. The same OR-check still pins each leg to the agreed token+amount — the MM can't cheat by misrouting.
The MM does see trade details (token, amount, counterparty addresses) by default. Putting the MM in a TEE/enclave hides those too — MM becomes a blind matcher.
End-state: a fully private, atomic, zero-trust matching layer with no funds ever leaving the parties' control until both legs land in the same tx. Stop here.
-->
