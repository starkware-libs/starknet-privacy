import privacy.tracing.tracing_context
import privacy.tracing.graph

def TracingContext.alice {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m) : UserPrivKey crypto m :=
  have h := context.h_coin_props_alice coin
  let kalice: crypto.PrivateKeys := ⟨get_priv_key crypto events.flatten coin.esn.addralice, h.1⟩
  ⟨coin.esn.addralice, kalice, h.2.1⟩

def TracingContext.bob {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m) : UserPrivKey crypto m :=
  have h := context.h_coin_props_bob coin
  let kbob: crypto.PrivateKeys := ⟨get_priv_key crypto events.flatten coin.esn.addrbob, h.1⟩
  ⟨coin.esn.addrbob, kbob, h.2.1⟩

inductive OutgoingElement
  | Note (esn: ExScannedNote)
  | Withdrawal (evt: WithdrawalEvent)
deriving DecidableEq

def OutgoingElement.amount
  (crypto: Crypto) (m: Memory)
  (elm: OutgoingElement) : ℕ :=
  match elm with
  | OutgoingElement.Note esn => esn.amount crypto m
  | OutgoingElement.Withdrawal evt => evt.amount

def all_outgoing {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (user: UserPrivKey crypto m) (token: ℕ) :=
  (
    nonopen_created_notes context.toScanOutgoingNoteContext user.addr user.k token
    |>.map OutgoingElement.Note
  ) ++ (
    withdrawals_for_user_token context.toScanNoteContext events user token
    |>.map OutgoingElement.Withdrawal
  )

def incoming_equiv_outgoing
  {crypto: Crypto} {m: Memory} {events: List (List Event)}
  (context: TracingContext crypto m events)
  (user: UserPrivKey crypto m) (token: ℕ) :=
  amounts_to_coins.equiv
    (ℓ₀ := spent_notes_ex context.toScanNoteContext user.addr user.k token)
    (ℓ₁ := all_outgoing context user token)
    (h_nodup₀ := by
      apply List.Nodup.filter
      apply List.Nodup.filter
      apply List.nodup_dedup
    )
    (h_nodup₁ := by
      apply List.Nodup.append
      · apply List.Nodup.map (by apply OutgoingElement.Note.inj)
        apply List.Nodup.filter
        apply List.Nodup.filter
        apply List.nodup_dedup
      · apply List.Nodup.map (by apply OutgoingElement.Withdrawal.inj)
        apply List.Nodup.filter
        apply withdrawals_for_user.nodup
      · intro x h₀ h₁
        rw [List.mem_map] at h₀ h₁
        obtain ⟨_, _, h₀⟩ := h₀
        obtain ⟨_, _, h₁⟩ := h₁
        rw [←h₀] at h₁
        contradiction
    )
    (f := λ esn ↦ esn.amount crypto m)
    (g := λ esn ↦ esn.amount crypto m)
    (h_sum := by
      rw [context.h_incoming_eq_outgoing, all_outgoing, List.map_append, List.sum_append]
      apply congrArg₂
      · rw [List.map_map]
        apply congrArg
        apply List.map_congr_left
        intro esn h_esn
        rfl
      · rw [List.map_map]
        apply congrArg
        apply List.map_congr_left
        intro evt h_evt
        rfl
    )

theorem TracingContext.next_coin_spent_notes_ex {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] ≠ 0) :
    let bob := context.bob coin
    (coin.esn, coin.coin_idx) ∈ amounts_to_coins
       (spent_notes_ex context.toScanNoteContext bob.addr bob.k coin.esn.token)
       (λ esn => esn.amount crypto m) := by
  simp only [amounts_to_coins.mem]
  refine ⟨?_, coin.h_coin_idx⟩
  simp only [spent_notes_ex, List.mem_filter, decide_eq_true_eq, and_true]
  have h := context.h_coin_props_bob coin
  refine ⟨h.2.2 h.1, h_spent⟩

theorem TracingContext.prev_coin_helper {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_nonopen: is_open_note crypto m (coin.esn.note_id crypto) = false) :
    let alice := context.alice coin
    (.Note coin.esn, coin.coin_idx) ∈ amounts_to_coins
       (all_outgoing context alice coin.esn.token)
       (λ esn => esn.amount crypto m) := by
    simp only [amounts_to_coins.mem]
    refine ⟨?_, coin.h_coin_idx⟩
    rw [all_outgoing, List.mem_append]
    apply Or.inl
    simp only [List.mem_map, OutgoingElement.Note.injEq, exists_eq_right]
    simp only [nonopen_created_notes, List.mem_filter, decide_eq_true_eq, and_true]
    have h := context.h_coin_props_alice coin
    refine ⟨h.2.2, h_nonopen⟩

def TracingContext.next_coin₀ {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m) :
    Option (OutgoingElement × ℕ) :=
  let bob := context.bob coin
  let incoming_outgoing := incoming_equiv_outgoing context bob coin.esn.token
  ↑(partial_equiv incoming_outgoing ⟨coin.esn, coin.coin_idx⟩)

theorem TracingContext.next_coin₀_from_some_withdrawal {crypto: Crypto} {m: Memory} {events: List (List Event)}
    {context: TracingContext crypto m events} {coin: Coin crypto m}
    {evt: WithdrawalEvent} {coin_idx: ℕ}
    (h_next_coin₀: context.next_coin₀ coin = some (.Withdrawal evt, coin_idx)) :
    coin.esn.token = evt.token ∧
    coin.esn.addrbob = evt.addr ∧
    coin_idx < evt.amount ∧
    Event.Withdraw evt.user_enc evt.amount evt.token ∈ events.flatten := by
  have h := partial_equiv_from_some h_next_coin₀
  simp only [amounts_to_coins.mem, all_outgoing, List.mem_append, List.mem_map, reduceCtorEq,
    and_false, exists_false, OutgoingElement.Withdrawal.injEq, exists_eq_right, false_or] at h
  simp only [withdrawals_for_user_token, withdrawals_for_user, List.mem_filter, decide_eq_true_eq] at h
  have ⟨_, ⟨h₀, h₁⟩, h₂⟩ := h
  clear h
  replace ⟨i, ⟨user_enc, amount, token⟩, h₀⟩ := mem_mapIdx' h₀
  simp only [List.mem_flatMap] at h₀
  replace ⟨⟨⟨events, cond⟩, h_evt, h₀⟩, h₀'⟩ := h₀
  split at h₀
  swap; · simp at h₀

  simp only [List.mem_filterMap] at h₀
  have ⟨_, _, h₀⟩ := h₀
  split at h₀
  swap; · simp at h₀
  rename_i h_withdraw_in
  simp only [Option.some.injEq, Prod.mk.injEq] at h₀
  simp only [h₀] at h_withdraw_in

  refine ⟨h₁.symm, ?_, h₂, ?_⟩
  · simp [h₀']
    rfl
  · simp only [List.mem_flatten, h₀']
    exact ⟨events, (List.of_mem_zip h_evt).1, h_withdraw_in⟩

theorem TracingContext.next_coin₀_from_some_note {crypto: Crypto} {m: Memory} {events: List (List Event)}
    {context: TracingContext crypto m events} {coin: Coin crypto m}
    {esn: ExScannedNote} {coin_idx: ℕ}
    (h_next_coin₀: context.next_coin₀ coin = some (.Note esn, coin_idx)) :
    coin.esn.token = esn.token ∧
    coin.esn.addrbob = esn.addralice ∧
    coin_idx < esn.amount crypto m ∧
    m MemoryType.Nullifiers [coin.esn.nullifier crypto (context.bob coin).k] ≠ 0 := by
  have h := partial_equiv_from_some h_next_coin₀
  simp only [amounts_to_coins.mem, all_outgoing, nonopen_created_notes, Bool.decide_eq_false,
    List.filter_filter, List.mem_append, List.mem_map, List.mem_filter, Bool.and_eq_true,
    Bool.not_eq_eq_eq_not, Bool.not_true, decide_eq_true_eq, OutgoingElement.Note.injEq,
    exists_eq_right, reduceCtorEq, and_false, exists_false, or_false] at h
  simp only [spent_notes_ex, ne_eq, decide_not, List.filter_filter, List.mem_filter, decide_true,
    Bool.and_true, Bool.not_eq_eq_eq_not, Bool.not_true, decide_eq_false_iff_not] at h
  have ⟨⟨⟨_, h_nullifier⟩, _⟩, ⟨h₀, _, h₁⟩, h₂⟩ := h
  exact ⟨h₁.symm, (context.h_scan_outgoing_notes_for_sender _ _ _ h₀).1, h₂, h_nullifier⟩

theorem TracingContext.next_coin₀_inj {crypto: Crypto} {m: Memory} {events: List (List Event)}
    {context: TracingContext crypto m events}
    {coin₀ coin₁: Coin crypto m}
    {elt: OutgoingElement} {coin_idx: ℕ}
    (h_next_coin₀: context.next_coin₀ coin₀ = some (elt, coin_idx))
    (h_next_coin₁: context.next_coin₀ coin₁ = some (elt, coin_idx)) :
    coin₀ = coin₁ := by
  have ⟨h_token, h_bob⟩: coin₀.esn.token = coin₁.esn.token ∧ coin₀.esn.addrbob = coin₁.esn.addrbob := by
    cases elt
    case Withdrawal evt =>
      have h₀ := context.next_coin₀_from_some_withdrawal h_next_coin₀
      have h₁ := context.next_coin₀_from_some_withdrawal h_next_coin₁
      simp [h₀, h₁]
    case Note esn =>
      have h₀ := context.next_coin₀_from_some_note h_next_coin₀
      have h₁ := context.next_coin₀_from_some_note h_next_coin₁
      simp [h₀, h₁]

  simp only [TracingContext.next_coin₀] at h_next_coin₀ h_next_coin₁
  apply (partial_equiv_inv _ _ _).1 at h_next_coin₀
  apply (partial_equiv_inv _ _ _).1 at h_next_coin₁
  have h_bob : context.bob coin₀ = context.bob coin₁ := by
    simp [TracingContext.bob, h_bob]
  rw [h_token, h_bob] at h_next_coin₀
  simp only [h_next_coin₁, Option.some.injEq, Prod.mk.injEq] at h_next_coin₀
  apply Coin.ext <;> simp [*]

def TracingContext.prev_coin₀ {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m) :
    Option (ExScannedNote × ℕ) :=
  let alice := context.alice coin
  let incoming_outgoing := incoming_equiv_outgoing context alice coin.esn.token
  ↑(partial_equiv incoming_outgoing.symm ⟨.Note coin.esn, coin.coin_idx⟩)

theorem TracingContext.next_coin₀_prop
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] ≠ 0) :
    let bob := context.bob coin
    let res := context.next_coin₀ coin
    ∃ (elt: OutgoingElement) (coin_idx: ℕ),
    res = some (elt, coin_idx) ∧
    elt ∈ all_outgoing context bob coin.esn.token ∧
    coin_idx < elt.amount crypto m := by
  intro bob
  dsimp only [TracingContext.next_coin₀]
  let incoming_outgoing := incoming_equiv_outgoing context bob coin.esn.token
  have ⟨⟨elt, coin_idx⟩, h₀, h₁⟩ := partial_equiv_prop incoming_outgoing ⟨coin.esn, coin.coin_idx⟩
    (context.next_coin_spent_notes_ex _ h_spent)
  use elt, coin_idx, h₀

  rw [amounts_to_coins.mem] at h₁
  exact h₁

theorem TracingContext.prev_coin₀_prop
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_nonopen: is_open_note crypto m (coin.esn.note_id crypto) = false) :
    let alice := context.alice coin
    let res := context.prev_coin₀ coin
    ∃ (esn: ExScannedNote) (coin_idx: ℕ),
    res = some (esn, coin_idx) ∧
    esn ∈ spent_notes_ex context.toScanNoteContext alice.addr alice.k coin.esn.token  ∧
    coin_idx < esn.amount crypto m := by
  intro alice
  dsimp only [TracingContext.prev_coin₀]
  let incoming_outgoing := incoming_equiv_outgoing context alice coin.esn.token
  have ⟨⟨esn, coin_idx⟩, h₀, h₁⟩ := partial_equiv_prop incoming_outgoing.symm
    ⟨.Note coin.esn, coin.coin_idx⟩
    (context.prev_coin_helper _ h_nonopen)
  use esn, coin_idx, h₀
  rw [amounts_to_coins.mem] at h₁
  exact h₁

theorem TracingContext.next_prev₀
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin₀ coin₁: Coin crypto m) :
    context.next_coin₀ coin₀ = some (.Note coin₁.esn, coin₁.coin_idx) ↔
    context.prev_coin₀ coin₁ = some (coin₀.esn, coin₀.coin_idx) := by
  have (a b: Prop): (a ∨ b → (a ↔ b)) → (a ↔ b) := by
    by_cases h: a; all_goals simp [h]
  apply this

  intro h_or
  have h_addr_token : coin₀.esn.addrbob = coin₁.esn.addralice ∧ coin₀.esn.token = coin₁.esn.token := by
    simp only [TracingContext.next_coin₀, TracingContext.prev_coin₀] at h_or
    cases h_or
    case inl h_or =>
      have ⟨h₀, h₁⟩ := partial_equiv_from_some h_or
      simp [amounts_to_coins.mem] at h₀ h₁

      simp only [spent_notes_ex, List.mem_filter, decide_eq_true_eq, and_true] at h₀
      have ⟨h_addr₀, _, _⟩ := context.h_scan_notes_for_recipient _ _ h₀.1.1

      simp only [all_outgoing, List.mem_append] at h₁
      cases h₁.1
      case inr h₁ => simp [List.mem_map] at h₁
      rename_i h₁
      simp only [List.mem_map, List.mem_filter, OutgoingElement.Note.injEq, exists_eq_right,
        nonopen_created_notes, decide_eq_true_eq] at h₁
      have ⟨h_addr₁, Kbob, _⟩ := context.h_scan_outgoing_notes_for_sender _ _ _ h₁.1.1

      rw [←h_addr₀, h_addr₁, h₁.1.2]
      trivial
    case inr h_or =>
      have ⟨h₁, h₀⟩ := partial_equiv_from_some h_or
      simp [amounts_to_coins.mem] at h₀ h₁
      simp only [spent_notes_ex, List.mem_filter, decide_eq_true_eq] at h₀
      have ⟨h_addr₀, _, _⟩ := context.h_scan_notes_for_recipient _ _ h₀.1.1.1

      simp only [all_outgoing, List.mem_append] at h₁
      cases h₁.1
      case inr h₁ => simp [List.mem_map] at h₁
      rename_i h₁
      simp only [List.mem_map, List.mem_filter, OutgoingElement.Note.injEq, exists_eq_right,
        nonopen_created_notes, decide_eq_true_eq, and_true] at h₁
      have ⟨h_addr₁, Kbob, _⟩ := context.h_scan_outgoing_notes_for_sender _ _ _ h₁.1

      rw [←h_addr₀, h_addr₁, h₀.1.1.2]
      trivial

  have h_user : context.bob coin₀ = context.alice coin₁ := by
    simp only [TracingContext.bob, TracingContext.alice]
    conv => enter [1, 1]; rw [h_addr_token.1]
    conv => enter [1, 2, 1]; rw [h_addr_token.1]

  simp only [TracingContext.next_coin₀, TracingContext.prev_coin₀]
  rw [h_user, h_addr_token.2]
  apply partial_equiv_inv

-------------------------------------

def TracingContext.next_coin₁ {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m) :
    Option (ExScannedNote × ℕ) :=
  let res := context.next_coin₀ coin
  match res with
  | some (OutgoingElement.Note esn, coin_idx) => some ⟨esn, coin_idx⟩
  | _ => none

def TracingContext.prev_coin₁ {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m) :
    Option (ExScannedNote × ℕ) :=
  context.prev_coin₀ coin

theorem TracingContext.next_prev₁
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin₀ coin₁: Coin crypto m) :
    context.next_coin₁ coin₀ = some ⟨coin₁.esn, coin₁.coin_idx⟩ ↔
    context.prev_coin₁ coin₁ = some ⟨coin₀.esn, coin₀.coin_idx⟩ := by
  simp only [TracingContext.next_coin₁, TracingContext.prev_coin₁]
  constructor
  · split
    · rename_i res esn coin_idx h
      intro h'
      simp only [Option.some.injEq, Prod.mk.injEq] at h'
      rw [h'.1, h'.2] at h
      exact (context.next_prev₀ _ _).1 h
    · intro h
      contradiction
  · split
    · rename_i res esn coin_idx h
      intro h'
      rw [(context.next_prev₀ _ _).2 h'] at h
      simp only [Option.some.injEq, Prod.mk.injEq, OutgoingElement.Note.injEq] at h
      simp [h]
    · rename_i res h
      intro h'
      exfalso
      have := (context.next_prev₀ _ _).2 h'
      exact h coin₁.esn coin₁.coin_idx this

-------------------------------------

def TracingContext.next_coin₂ {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] ≠ 0) :
    Option (Coin crypto m) :=
  match h: context.next_coin₁ coin with
  | some ⟨esn, coin_idx⟩ => by
    refine some ⟨esn, coin_idx, ?_, ?_⟩
    all_goals
      have prop := context.next_coin₀_prop coin h_spent
      simp only [TracingContext.next_coin₁] at h
      cases h' : context.next_coin₀ coin
      case none => simp [h'] at h
      rename_i val
      have h_val : val = (val.1, val.2) := by rfl
      cases h'': val.1
      case Withdrawal esn' =>
        rw [h', h_val, h''] at h
        simp at h
      rename_i esn'
      rw [h', h_val, h'', Option.some.injEq, Prod.mk.injEq] at h
      have ⟨elt, coin_idx', prop₀, prop₁, prop₂⟩ := prop
      clear prop
      rw [h', Option.some.injEq, Prod.mk.injEq, h.2, h''] at prop₀

    · simp only [←prop₀, OutgoingElement.amount, h] at prop₂
      exact prop₂
    · rw [all_outgoing, List.mem_append] at prop₁
      cases prop₁
      case inl prop₁ =>
        simp only [←prop₀, h, List.mem_map] at prop₁
        simp only [OutgoingElement.Note.injEq, exists_eq_right,
          nonopen_created_notes, List.mem_filter, decide_eq_true_eq] at prop₁
        have ⟨h_addralice, Kbob, h_c⟩ := context.h_scan_outgoing_notes_for_sender _ _ _ prop₁.1.1
        exact ⟨(context.bob coin).k, Kbob, h_c⟩
      case inr prop₁ =>
        simp [←prop₀] at prop₁
  | none => none

def TracingContext.prev_coin₂ {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin: Coin crypto m)
    (h_nonopen: is_open_note crypto m (coin.esn.note_id crypto) = false) :
    Option (Coin crypto m) :=
  match h: context.prev_coin₁ coin with
  | some ⟨esn, coin_idx⟩ => by
    refine some ⟨esn, coin_idx, ?_, ?_⟩
    all_goals
      have prop := context.prev_coin₀_prop coin h_nonopen
      simp only [TracingContext.prev_coin₁] at h
      cases h' : context.prev_coin₀ coin
      case none => simp [h'] at h
      rename_i val
      rw [h', Option.some.injEq, Prod.mk.injEq] at h
      have ⟨esn', coin_idx', prop₀, prop₁, prop₂⟩ := prop
      clear prop
      rw [h', Option.some.injEq, Prod.mk.injEq, h.2] at prop₀

    · simp only [←prop₀, h] at prop₂
      exact prop₂
    · simp only [←prop₀, h] at prop₁
      simp only [spent_notes_ex, List.mem_filter, decide_eq_true_eq] at prop₁
      have ⟨h_addrbob, kalice, h_c⟩ := context.h_scan_notes_for_recipient _ _ prop₁.1.1
      exact ⟨_, _, h_c⟩
  | none => none

theorem TracingContext.next_prev₂
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) (coin₀ coin₁: Coin crypto m)
    (h_spent: m MemoryType.Nullifiers [crypto.hash [coin₀.esn.c, coin₀.esn.token, coin₀.esn.i, (context.bob coin₀).k]] ≠ 0)
    (h_nonopen: is_open_note crypto m (coin₁.esn.note_id crypto) = false) :
    context.next_coin₂ coin₀ h_spent = some coin₁ ↔
    context.prev_coin₂ coin₁ h_nonopen = some coin₀ := by
  simp only [TracingContext.next_coin₂, TracingContext.prev_coin₂]
  split
  · rename_i esn coin_idx h_next
    split
    · rename_i esn' coin_idx' h_prev
      simp only [Option.some.injEq, Coin.ext_iff]
      constructor
      · intro h
        simp [h] at h_next
        replace h_next := (context.next_prev₁ _ _).1 h_next
        rw [h_next, Option.some.injEq, Prod.mk.injEq] at h_prev
        simp [h_prev]
      · intro h
        simp [h] at h_prev
        replace h_prev := (context.next_prev₁ _ _).2 h_prev
        rw [h_prev, Option.some.injEq, Prod.mk.injEq] at h_next
        simp [h_next]
    · rename_i h_none
      simp only [Option.some.injEq, reduceCtorEq, iff_false, Coin.ext_iff]
      by_contra h
      simp [h] at h_next
      replace h_next := (context.next_prev₁ _ _).1 h_next
      simp [h_next] at h_none
  · rename_i h_none
    split
    · simp only [Option.some.injEq, Coin.ext_iff, reduceCtorEq, false_iff]
      rename_i esn' coin_idx' h_prev
      by_contra h
      simp [h] at h_prev
      replace h_prev := (context.next_prev₁ _ _).2 h_prev
      simp [h_prev] at h_none
    · simp

-------------------------------------

def TracingContext.next_coin {crypto: Crypto} {m: Memory} {events: List (List Event)}
  (context: TracingContext crypto m events)
  (coin: Coin crypto m) : Option (Coin crypto m) := by
  let bob := context.bob coin

  -- Check if the note was spent.
  by_cases h_is_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, bob.k]] ≠ 0
  case neg => exact none

  exact context.next_coin₂ coin h_is_spent

def TracingContext.prev_coin
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m) :
    Option (Coin crypto m) := by
  let alice := context.alice coin

  -- Check if the note is an open note.
  by_cases h_nonopen: is_open_note crypto m (coin.esn.note_id crypto)
  case pos => exact none

  exact context.prev_coin₂ coin (by simp only [h_nonopen])

theorem TracingContext.next_prev
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin₀ coin₁: Coin crypto m) :
    context.next_coin coin₀ = some coin₁ ↔
    context.prev_coin coin₁ = some coin₀ := by
  simp only [TracingContext.next_coin, TracingContext.prev_coin]
  simp only [ne_eq, dite_not, Option.dite_none_left_eq_some, Bool.not_eq_true]
  constructor
  · intro ⟨h_spent, h⟩
    have h_nonopen : is_open_note crypto m (ScannedNote.note_id crypto coin₁.esn.toScannedNote) = false := by
      have ⟨elt, _, prop₀, prop₁, _⟩ := context.next_coin₀_prop coin₀ h_spent

      simp only [TracingContext.next_coin₂, TracingContext.next_coin₁] at h
      split at h
      swap
      · contradiction
      rename_i esn _ h'

      split at h'
      swap
      · contradiction
      rename_i res esn' _ h''

      simp only [Option.some.injEq, Coin.ext_iff] at h
      rw [prop₀, Option.some.injEq, Prod.mk.injEq] at h''
      simp only [Option.some.injEq, Prod.mk.injEq] at h'
      simp only [all_outgoing, List.mem_append] at prop₁
      cases prop₁
      swap
      · rename_i h_elt_in
        simp [List.mem_map, h''] at h_elt_in

      rename_i h_elt_in
      simp only [h'', List.mem_map, OutgoingElement.Note.injEq,
        exists_eq_right] at h_elt_in
      simp only [nonopen_created_notes, List.mem_filter, decide_eq_true_eq, h'.1] at h_elt_in

      rw [←h.1]
      exact h_elt_in.2

    have := context.next_prev₂ coin₀ coin₁ h_spent h_nonopen
    use h_nonopen, this.1 h
  · intro ⟨h_nonopen, h⟩
    have h_nullifier : m MemoryType.Nullifiers [crypto.hash [coin₀.esn.c, coin₀.esn.token, coin₀.esn.i, ↑(context.bob coin₀).k]] ≠ 0 := by
      have ⟨esn, _, prop₀, prop₁, _⟩ := context.prev_coin₀_prop coin₁ h_nonopen
      simp only [TracingContext.prev_coin₂, TracingContext.prev_coin₁] at h
      split at h

      swap
      · contradiction
      rename_i esn' _ h'

      simp only [Option.some.injEq, Coin.ext_iff] at h
      rw [prop₀, Option.some.injEq, Prod.mk.injEq] at h'

      simp only [spent_notes_ex, List.mem_filter, decide_eq_true_eq] at prop₁
      simp only [TracingContext.bob]

      have h_addr := (context.h_scan_notes_for_recipient (context.alice coin₁) _ prop₁.1.1).1
      simp only [←h.1, ←h'.1, ←h_addr]

      exact prop₁.2
    have := context.next_prev₂ coin₀ coin₁ h_nullifier h_nonopen
    use h_nullifier, this.2 h

theorem TracingContext.next_coin_none
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m) :
    context.next_coin coin = none ↔
    m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] = 0 ∨
    ∃ (evt: WithdrawalEvent) (coin_idx: ℕ), context.next_coin₀ coin = some (.Withdrawal evt, coin_idx)
     := by
  simp only [TracingContext.next_coin, TracingContext.next_coin₂]
  by_cases h_spent: m MemoryType.Nullifiers [crypto.hash [coin.esn.c, coin.esn.token, coin.esn.i, (context.bob coin).k]] = 0
  case pos => simp [h_spent]
  case neg =>
    simp only [ne_eq, h_spent, not_false_eq_true, ↓reduceDIte, false_or]
    have ⟨elt, coin_idx, prop₀, prop₁, prop₂⟩ := context.next_coin₀_prop coin h_spent
    simp only [prop₀, Option.some.injEq, Prod.mk.injEq, exists_and_left, ↓existsAndEq, and_true]

    split
    · simp only [reduceCtorEq, false_iff]
      by_contra h_next_coin₀
      obtain ⟨evt, h_next_coin₀⟩ := h_next_coin₀
      rename_i h_next_coin₁
      simp [TracingContext.next_coin₁, prop₀, h_next_coin₀] at h_next_coin₁
    · simp only [true_iff]
      cases elt
      case Withdrawal evt => use evt
      case Note esn =>
        rename_i h_next_coin₁
        simp [TracingContext.next_coin₁, prop₀] at h_next_coin₁

theorem TracingContext.prev_coin_none
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m) :
    context.prev_coin coin = none ↔
    is_open_note crypto m (coin.esn.note_id crypto) := by
  simp only [TracingContext.prev_coin, TracingContext.prev_coin₂, TracingContext.prev_coin₁]
  split
  · simp [*]
  · split
    · simp [*]
    · rename_i h
      have ⟨esn, coin_idx, prop₀, prop₁, prop₂⟩ := context.prev_coin₀_prop coin (by simp only [*])
      simp [h] at prop₀

-------------------------------------

def TracingContext.tracing_graph
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events) :
    Graph (Coin crypto m) := {
  next := context.next_coin
  prev := context.prev_coin,
  next_iff_prev := by intro coin₀ coin₁; apply TracingContext.next_prev
  h_fintype := context.h_fintype_coin
}
