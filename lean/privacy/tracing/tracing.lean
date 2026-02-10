import privacy.tracing.tracing_context
import privacy.tracing.graph

def TracingContext.alice {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin: Coin crypto m) : UserPrivKey crypto m :=
  have h := context.h_coin_props_alice coin
  let kalice: crypto.PrivateKeys := ⟨get_priv_key crypto events coin.esn.addralice, h.1⟩
  ⟨coin.esn.addralice, kalice, h.2.1⟩

def TracingContext.bob {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin: Coin crypto m) : UserPrivKey crypto m :=
  have h := context.h_coin_props_bob coin
  let kbob: crypto.PrivateKeys := ⟨get_priv_key crypto events coin.esn.addrbob, h.1⟩
  ⟨coin.esn.addrbob, kbob, h.2.1⟩

def incoming_equiv_outgoing
  {crypto: Crypto} {m: Memory} {events: List Event}
  (context: TracingContext crypto m events)
  (user: UserPrivKey crypto m) (token: ℕ) :=
  amounts_to_coins.equiv
    (ℓ₀ := spent_notes_ex context.toScanNoteContext user.addr user.k token)
    (ℓ₁ := nonopen_created_notes context.toScanOutgoingNoteContext user.addr user.k token)
    (h_nodup₀ := by
      apply List.Nodup.filter
      apply List.Nodup.filter
      apply List.nodup_dedup
    )
    (h_nodup₁ := by
      apply List.Nodup.filter
      apply List.Nodup.filter
      apply List.nodup_dedup
    )
    (f := λ esn ↦ esn.amount crypto m)
    (g := λ esn ↦ esn.amount crypto m)
    (h_sum := by rw [context.h_incoming_eq_outgoing])

theorem TracingContext.next_coin_spent_notes_ex {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] ≠ 0) :
    let bob := context.bob coin
    (coin.esn, coin.coin_idx) ∈ (amounts_to_coins
       (spent_notes_ex context.toScanNoteContext bob.addr bob.k coin.esn.token)
       (λ esn => esn.amount crypto m)).toFinset := by
  simp only [List.mem_toFinset, amounts_to_coins.mem]
  refine ⟨?_, coin.h_coin_idx⟩
  simp only [spent_notes_ex, List.mem_filter, decide_eq_true_eq, and_true]
  have h := context.h_coin_props_bob coin
  refine ⟨h.2.2 h.1, h_spent⟩

def TracingContext.prev_coin_helper {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_nonopen: is_open_note crypto m (coin.esn.note_id crypto) = false) :
    let alice := context.alice coin
    (coin.esn, coin.coin_idx) ∈ (amounts_to_coins
       (nonopen_created_notes context.toScanOutgoingNoteContext alice.addr alice.k coin.esn.token)
       (λ esn => esn.amount crypto m)).toFinset := by
    simp only [List.mem_toFinset, amounts_to_coins.mem]
    refine ⟨?_, coin.h_coin_idx⟩
    simp only [nonopen_created_notes, List.mem_filter, decide_eq_true_eq, and_true]
    have h := context.h_coin_props_alice coin
    refine ⟨h.2.2, h_nonopen⟩

def TracingContext.next_coin₀ {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] ≠ 0) :
    let bob := context.bob coin
    { v : ExScannedNote × ℕ // v ∈ (
      amounts_to_coins
        (nonopen_created_notes context.toScanOutgoingNoteContext bob.addr bob.k coin.esn.token)
        (λ esn ↦ esn.amount crypto m)
      ).toFinset
    } := by
  intro bob
  let incoming_outgoing := incoming_equiv_outgoing context bob coin.esn.token
  exact incoming_outgoing ⟨⟨coin.esn, coin.coin_idx⟩, context.next_coin_spent_notes_ex _ h_spent⟩

def TracingContext.prev_coin₀ {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_nonopen: is_open_note crypto m (coin.esn.note_id crypto) = false) :
    let alice := context.alice coin
    { v : ExScannedNote × ℕ // v ∈ (
      amounts_to_coins
        (spent_notes_ex context.toScanNoteContext alice.addr alice.k coin.esn.token)
        (λ esn ↦ esn.amount crypto m)
      ).toFinset
    }  := by
  intro alice
  let incoming_outgoing := incoming_equiv_outgoing context alice coin.esn.token
  exact incoming_outgoing.invFun ⟨⟨coin.esn, coin.coin_idx⟩, context.prev_coin_helper _ h_nonopen⟩

theorem TracingContext.next_prev₀
    {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin₀ coin₁: Coin crypto m)
    (token: ℕ) (h_token₀: token = coin₀.esn.token)
    (user: UserPrivKey crypto m) (h_user₀: user = context.bob coin₀)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin₀.esn.c, coin₀.esn.token, coin₀.esn.i, (context.bob coin₀).k]] ≠ 0)
    (h_nonopen: is_open_note crypto m (coin₁.esn.note_id crypto) = false) :
    context.next_coin₀ coin₀ h_spent = (coin₁.esn, coin₁.coin_idx) ↔
    context.prev_coin₀ coin₁ h_nonopen = (coin₀.esn, coin₀.coin_idx) := by
  set res₀ := context.next_coin₀ coin₀ h_spent with h_res₀
  set res₁ := context.prev_coin₀ coin₁ h_nonopen with h_res₁
  have (a b: Prop): (a ∨ b → (a ↔ b)) → (a ↔ b) := by
    by_cases h: a; all_goals simp [h]
  apply this
  intro h_or

  have ⟨h_addr₁, h_token₁⟩ : coin₀.esn.addrbob = coin₁.esn.addralice ∧ token = coin₁.esn.token := by
    cases h_or
    case inl h_or =>
      have := res₀.prop
      rw [List.mem_toFinset, amounts_to_coins.mem] at this
      simp only [nonopen_created_notes, List.mem_filter, decide_eq_true_eq] at this
      have ⟨h_addralice, Kbob, h_c⟩ := context.h_scan_outgoing_notes_for_sender _ _ _ this.1.1.1
      simp only [TracingContext.bob, h_or] at h_addralice

      have h_token := this.1.1.2.symm
      simp only [h_or] at h_token

      exact ⟨h_addralice, h_token₀ ▸ h_token⟩
    case inr h_or =>
      have := res₁.prop
      rw [List.mem_toFinset, amounts_to_coins.mem] at this
      simp only [spent_notes_ex, List.mem_filter, decide_eq_true_eq] at this
      have ⟨h_addrbob, kalice, h_c⟩ := context.h_scan_notes_for_recipient (context.alice coin₁) _ this.1.1.1
      simp only [TracingContext.alice, h_or] at h_addrbob

      have h_token := this.1.1.2.symm
      simp only [h_or] at h_token

      exact ⟨h_addrbob.symm, h_token₀ ▸ h_token.symm⟩

  replace h_user₁ : user = context.alice coin₁ := by
    rw [h_user₀]
    simp only [TracingContext.bob, TracingContext.alice]
    conv => lhs; arg 1; rw [h_addr₁]
    conv => lhs; arg 2; arg 1; rw [h_addr₁]

  let incoming_outgoing := incoming_equiv_outgoing context user token
  have h_res₀' : res₀.1 = (incoming_outgoing ⟨⟨coin₀.esn, coin₀.coin_idx⟩, h_token₀ ▸ h_user₀ ▸ context.next_coin_spent_notes_ex _ h_spent⟩).1 := by
    cases h_token₀
    cases h_user₀
    rfl
  have h_res₁' : res₁.1 = (incoming_outgoing.symm ⟨⟨coin₁.esn, coin₁.coin_idx⟩, h_token₁ ▸ h_user₁ ▸ context.prev_coin_helper _ h_nonopen⟩).1 := by
    cases h_token₁
    cases h_user₁
    rfl

  rw [h_res₀']
  have (S: Type) (p q: S → Prop) (e: Equiv { s // p s } { s // q s}) (x y: S) (h_x: p x) (h_y: q y):
      ↑(e ⟨x, h_x⟩) = y ↔ ↑(e.symm ⟨y, h_y⟩) = x := by
    have : e ⟨x, h_x⟩ = ⟨y, h_y⟩ ↔ ↑(e ⟨x, h_x⟩) = y := by apply Subtype.ext_iff
    rw [←this]

    have : e.symm ⟨y, h_y⟩ = ⟨x, h_x⟩ ↔ ↑(e.symm ⟨y, h_y⟩) = x := by apply Subtype.ext_iff
    rw [←this]

    rw [e.apply_eq_iff_eq_symm_apply]
    constructor
    all_goals intro h; rw [h]

  rw [this, h_res₁']

def TracingContext.next_coin₁ {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] ≠ 0) :
    Coin crypto m := by
  let ⟨⟨esn, coin_idx⟩, h_next⟩ := context.next_coin₀ coin h_spent

  simp only [List.mem_toFinset, amounts_to_coins.mem, nonopen_created_notes, List.mem_filter, decide_eq_true_eq] at h_next
  refine ⟨esn, coin_idx, h_next.2, ?_⟩
  have ⟨h_addralice, Kbob, h_c⟩ := context.h_scan_outgoing_notes_for_sender _ _ _ h_next.1.1.1
  use (context.bob coin).k, Kbob, h_c

def TracingContext.prev_coin₁ {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_nonopen: is_open_note crypto m (coin.esn.note_id crypto) = false) :
    Coin crypto m := by
  let ⟨⟨esn, coin_idx⟩, h_prev⟩ := context.prev_coin₀ coin h_nonopen

  simp only [List.mem_toFinset, amounts_to_coins.mem, spent_notes_ex, List.mem_filter, decide_eq_true_eq] at h_prev
  refine ⟨esn, coin_idx, h_prev.2, ?_⟩
  have ⟨h_addrbob, kalice, h_c⟩ := context.h_scan_notes_for_recipient (context.alice coin) _ h_prev.1.1.1
  use kalice, crypto.priv_to_pub (context.alice coin).k, h_c

theorem TracingContext.next_prev₁
    {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) (coin₀ coin₁: Coin crypto m)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin₀.esn.c, coin₀.esn.token, coin₀.esn.i, (context.bob coin₀).k]] ≠ 0)
    (h_nonopen: is_open_note crypto m (coin₁.esn.note_id crypto) = false) :
    context.next_coin₁ coin₀ h_spent = coin₁ ↔
    context.prev_coin₁ coin₁ h_nonopen = coin₀ := by
  simp only [TracingContext.next_coin₁, TracingContext.prev_coin₁]
  simp only [Coin.ext_iff]
  have := context.next_prev₀ coin₀ coin₁ _ (by rfl) _ (by rfl) h_spent h_nonopen
  simp only [Prod.ext_iff] at this
  exact this

def TracingContext.next_coin {crypto: Crypto} {m: Memory} {events: List Event}
  (context: TracingContext crypto m events)
  (coin: Coin crypto m) : Option (Coin crypto m) := by
  let bob := context.bob coin

  -- Check if the note was spent.
  by_cases h_is_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, bob.k]] ≠ 0
  case neg => exact none

  exact some (context.next_coin₁ coin h_is_spent)

def TracingContext.prev_coin
    {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m) :
    Option (Coin crypto m) := by
  let alice := context.alice coin

  -- Check if the note is an open note.
  by_cases h_nonopen: is_open_note crypto m (coin.esn.note_id crypto)
  case pos => exact none

  exact some (context.prev_coin₁ coin (by simp only [h_nonopen]))

theorem TracingContext.next_coin_none
    {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m) :
    context.next_coin coin = none ↔
    m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] = 0 := by
  simp only [TracingContext.next_coin]
  split_ifs <;> simp [*]; omega

theorem TracingContext.prev_coin_none
    {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m) :
    context.prev_coin coin = none ↔
    is_open_note crypto m (coin.esn.note_id crypto) := by
  simp only [TracingContext.prev_coin]
  split_ifs <;> simp [*]

theorem TracingContext.next_prev
    {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events)
    (coin₀ coin₁: Coin crypto m) :
    context.next_coin coin₀ = some coin₁ ↔
    context.prev_coin coin₁ = some coin₀ := by
  simp only [TracingContext.next_coin, TracingContext.prev_coin]
  simp only [ne_eq, dite_not, Option.dite_none_left_eq_some, Option.some.injEq, Bool.not_eq_true]
  constructor
  · intro ⟨h_spent, h⟩
    have h_nonopen : is_open_note crypto m (ScannedNote.note_id crypto coin₁.esn.toScannedNote) = false := by
      rw [←h]
      simp only [TracingContext.next_coin₁]
      set res := context.next_coin₀ coin₀ h_spent
      have := res.prop
      rw [List.mem_toFinset, amounts_to_coins.mem] at this
      simp only [nonopen_created_notes, List.mem_filter, decide_eq_true_eq] at this
      exact this.1.2
    have := context.next_prev₁ coin₀ coin₁ h_spent h_nonopen
    use h_nonopen, this.1 h
  · intro ⟨h_nonopen, h⟩
    have h_nullifier : m MemoryType.Nullifiers [crypto.hash [coin₀.esn.c, coin₀.esn.token, coin₀.esn.i, ↑(context.bob coin₀).k]] ≠ 0 := by
      rw [←h]
      simp only [TracingContext.prev_coin₁]
      set res := context.prev_coin₀ coin₁ h_nonopen
      have := res.prop
      rw [List.mem_toFinset, amounts_to_coins.mem] at this
      simp only [spent_notes_ex, List.mem_filter, decide_eq_true_eq] at this
      simp only [TracingContext.bob]
      have h_addr := (context.h_scan_notes_for_recipient (context.alice coin₁) _ this.1.1.1).1
      rw [←h_addr]
      exact this.1.2
    have := context.next_prev₁ coin₀ coin₁ h_nullifier h_nonopen
    use h_nullifier, this.2 h

def TracingContext.tracing_graph
    {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events) :
    Graph (Coin crypto m) := {
  next := context.next_coin
  prev := context.prev_coin,
  next_iff_prev := by intro coin₀ coin₁; apply TracingContext.next_prev
  h_fintype := context.h_fintype_coin
}
