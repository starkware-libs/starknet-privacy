import privacy.tracing.tracing

structure ForwardTracing₀ where
  (crypto: Crypto) (m: Memory) (events: List (List Event))
  (context: TracingContext crypto m events)
  (note_id user_enc: ℕ)
  (h_event: .CreateOpenNote note_id user_enc ∈ events.flatten)

-- Decrypt the user address.
def ForwardTracing₀.user_addr (self: ForwardTracing₀) :=
   (self.crypto.dec self.crypto.council_priv_key self.user_enc).headD 0

-- Get the user's private key.
def ForwardTracing₀.user_priv_key (self: ForwardTracing₀) :=
  get_priv_key self.crypto self.events.flatten self.user_addr

def ForwardTracing₀.user (self: ForwardTracing₀) : UserPrivKey self.crypto self.m :=
  have h := self.context.h_from_create_open_note_event self.note_id self.user_enc self.h_event
  ⟨self.user_addr, ⟨self.user_priv_key, h.2.1⟩, h.2.2⟩

-- Find the note
def ForwardTracing₀.received_notes (self: ForwardTracing₀) :=
  scan_notes_for_recipient self.context.toScanNoteContext self.user.addr self.user.k

def ForwardTracing₀.esn_opt (self: ForwardTracing₀) : Option ExScannedNote :=
  self.received_notes.find? (λ note ↦ note.note_id self.crypto = self.note_id)

structure ForwardTracing₁ extends ForwardTracing₀ where
  esn: ExScannedNote
  h_esn_opt: toForwardTracing₀.esn_opt = some esn

theorem ForwardTracing₁.esn_opt.note_id (self: ForwardTracing₁) :
    self.esn.note_id self.crypto = self.note_id := by
  have := self.h_esn_opt
  rw [ForwardTracing₀.esn_opt, List.find?_eq_some_iff_append, decide_eq_true_eq] at this
  simp only [←this.1]

def ForwardTracing₁.note_coins (self: ForwardTracing₁) : List (Coin self.crypto self.m) :=
  have : self.esn ∈ self.received_notes := by
    have ⟨_, _, h, _⟩ := (List.find?_eq_some_iff_append.1 self.h_esn_opt).2
    simp [h]
  let amount := self.esn.amount self.crypto self.m
  List.finRange amount |>.map (
    λ (i: Fin amount) ↦ ⟨self.esn, ↑i, i.prop, by

      have ⟨_, kalice, h⟩ := self.context.h_scan_notes_for_recipient self.user self.esn this
      exact ⟨kalice, self.crypto.priv_to_pub self.user_priv_key, h⟩
    ⟩
  )

theorem ForwardTracing₁.no_prev
    {self: ForwardTracing₁} {coin: Coin self.crypto self.m}
    (h_coin: coin ∈ self.note_coins) :
    self.context.tracing_graph.prev coin = none := by
  rw [ForwardTracing₁.note_coins, List.mem_map] at h_coin
  replace ⟨i, h_i, h_coin⟩ := h_coin
  have : coin.esn.note_id self.crypto = self.note_id := by
    simp only [←h_coin, ForwardTracing₁.esn_opt.note_id]

  simp only [TracingContext.tracing_graph, self.context.prev_coin_none]
  exact (self.context.h_from_create_open_note_event (coin.esn.note_id self.crypto) _ (this ▸ self.h_event)).1

def ForwardTracing₁.final_coins (self: ForwardTracing₁) : List (Coin self.crypto self.m) :=
  self.note_coins.attach.map (λ ⟨coin, h_coin⟩ ↦ self.context.tracing_graph.next_limit coin (
    ForwardTracing₁.no_prev h_coin))

theorem ForwardTracing₁.final_coins.nodup (self: ForwardTracing₁) :
    self.final_coins.Nodup := by
  apply List.Nodup.map
  · intro coin₀ coin₁ h_eq
    simp at h_eq
    refine Subtype.ext (Graph.next_limit_inj ?_ ?_ h_eq)
    · exact ForwardTracing₁.no_prev coin₀.prop
    · exact ForwardTracing₁.no_prev coin₁.prop
  · apply List.Nodup.attach
    apply (List.nodup_map_iff (by
      intro i i' h_eq
      simp only [Coin.mk.injEq, true_and] at h_eq
      exact Fin.ext h_eq
    )).2
    exact List.nodup_finRange _

theorem ForwardTracing₁.final_coins.length (self: ForwardTracing₁) :
    self.final_coins.length = self.esn.amount self.crypto self.m := by
  unfold ForwardTracing₁.final_coins
  rw [List.length_map, List.length_attach]
  unfold ForwardTracing₁.note_coins
  rw [List.length_map, List.length_finRange]

def final_coin
    {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m) : Prop :=
  ∀ (esn: ExScannedNote) (coin_idx: ℕ), context.next_coin₀ coin ≠ some (.Note esn, coin_idx)

theorem ForwardTracing₁.final_coins.final (self: ForwardTracing₁)
    (coin: Coin self.crypto self.m)
    (h_coin: coin ∈ self.final_coins) :
    final_coin self.context coin := by
  by_contra h_contra
  simp only [final_coin, not_forall] at h_contra
  obtain ⟨esn, coin_idx, h_contra⟩ := h_contra
  simp only [Decidable.not_not] at h_contra

  simp only [ForwardTracing₁.final_coins, List.mem_map, List.mem_attach, true_and] at h_coin
  obtain ⟨⟨coin', h_coin⟩, h_next_limit⟩ := h_coin
  have := Graph.next_limit' (ForwardTracing₁.no_prev h_coin) |>.1
  replace := (TracingContext.next_coin_none _ _).1 this

  cases this
  case inl h_nullifier =>
    simp only [h_next_limit] at h_nullifier
    have := (TracingContext.next_coin₀_from_some_note h_contra).2.2.2
    simp [h_nullifier] at this
  case inr this =>
    simp [h_next_limit, h_contra] at this

def coin_to_outgoing_element' {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m)
    : OutgoingElement × ℕ :=
  match context.next_coin₀ coin with
    | some (.Withdrawal evt, coin_idx) => (.Withdrawal evt, coin_idx)
    | some (.Note esn, coin_idx) => (.Note esn, coin_idx)
    | none => (.Note coin.esn, coin.coin_idx)

theorem coin_to_outgoing_element'_split {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m)
    (h_final_coin: final_coin context coin) :
    let res := coin_to_outgoing_element' context coin
    (
      context.next_coin₀ coin = none ∧
      res = (.Note coin.esn, coin.coin_idx)
    ) ∨ (
      ∃ (evt: WithdrawalEvent) (coin_idx: ℕ),
      context.next_coin₀ coin = some (.Withdrawal evt, coin_idx) ∧
      res = (.Withdrawal evt, coin_idx)
    ) := by
  simp only [coin_to_outgoing_element']
  split
  · apply Or.inr
    rename_i evt coin_idx h_next_coin₀
    use evt, coin_idx
  · exfalso
    apply h_final_coin
    assumption
  · apply Or.inl
    simp [*]

theorem coin_to_outgoing_element'_prop {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m)
    (h_final_coin: final_coin context coin) :
    let res := coin_to_outgoing_element' context coin
    res.2 < res.1.amount crypto m := by
  apply Or.elim (coin_to_outgoing_element'_split context coin h_final_coin)
  · intro h
    simp only [h.2, OutgoingElement.amount, coin.h_coin_idx]
  · intro ⟨evt, coin_idx, h₀, h₁⟩
    have := (context.next_coin₀_from_some_withdrawal h₀).2.2.1
    simp only [OutgoingElement.amount, h₁]
    exact this

theorem coin_to_outgoing_element'_inj {crypto: Crypto} {m: Memory} {events: List (List Event)}
    {context: TracingContext crypto m events}
    {coin₀ coin₁: Coin crypto m}
    (h_final_coin₀: final_coin context coin₀)
    (h_final_coin₁: final_coin context coin₁)
    (h_eq: coin_to_outgoing_element' context coin₀ = coin_to_outgoing_element' context coin₁) :
    coin₀ = coin₁ := by
  apply Or.elim (coin_to_outgoing_element'_split context coin₀ h_final_coin₀)
  all_goals
    intro h₀
    apply Or.elim (coin_to_outgoing_element'_split context coin₁ h_final_coin₁)
  all_goals
    intro h₁
  · simp [h₀, h₁] at h_eq
    apply Coin.ext <;> simp [*]
  · have ⟨_, _, h₁⟩ := h₁
    simp [h₀, h₁] at h_eq
  · have ⟨_, _, h₀⟩ := h₀
    simp [h₀, h₁] at h_eq
  · have ⟨evt₀, coin_idx₀, h₀⟩ := h₀
    have ⟨evt₁, coin_idx₁, h₁⟩ := h₁
    simp [h₀, h₁] at h_eq
    simp only [h_eq] at h₀
    exact TracingContext.next_coin₀_inj h₀.1 h₁.1

def coin_to_outgoing_element {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coin: Coin crypto m)
    : OutgoingElement :=
  (coin_to_outgoing_element' context coin).1

def coins_to_outgoing_elements {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (coins: List (Coin crypto m)) : Finset OutgoingElement :=
  coins.map (λ coin ↦ coin_to_outgoing_element context coin)
  |>.dedup
  |>.toFinset

theorem coins_to_outgoing_elements.sum_amounts
    {crypto: Crypto} {stxs: SuccessfulTransactions crypto}
    (context: TracingContext crypto stxs.rm stxs.events)
    (coins: List (Coin crypto stxs.rm))
    (h_final_coins: ∀ coin ∈ coins, final_coin context coin) :
    (∑ elt ∈ coins_to_outgoing_elements context coins, elt.amount crypto stxs.rm) ≥
    coins.dedup.length := by
  set ℓ := coins.map (coin_to_outgoing_element context) |>.dedup with h_ℓ

  have := Finset.sum_list_map_count ℓ (λ elt ↦ elt.amount crypto stxs.rm)
  rw [Finset.sum_congr rfl (by
    intro elt h_elt
    show _ = elt.amount crypto stxs.rm
    rw [List.nodup_iff_count_eq_one.1 (List.nodup_dedup _), smul_eq_mul, one_mul]
    rw [List.mem_toFinset] at h_elt
    exact h_elt
  )] at this

  simp only [coins_to_outgoing_elements, ←h_ℓ, ←this]
  clear this

  rw [←amounts_to_coins.length]
  set all_coins_in_notes := amounts_to_coins ℓ (λ elt ↦ elt.amount crypto stxs.rm)

  let coin_to_outgoing_element'' := λ coin: { x // x ∈ coins } ↦ coin_to_outgoing_element' context ↑coin
  have : (coins.attach).dedup.map coin_to_outgoing_element'' =
      (coins.map (coin_to_outgoing_element' context) |>.dedup) := by
    rw [←List.dedup_map_of_injective (by
      intro coin₀ coin₁ h_eq
      apply Subtype.ext
      exact coin_to_outgoing_element'_inj (h_final_coins _ coin₀.prop) (h_final_coins _ coin₁.prop) h_eq
    )]
    simp [coin_to_outgoing_element'']

  have : coins.dedup.length = (coins.map (coin_to_outgoing_element' context) |>.dedup |>.length) := by
    rw [←this, List.length_map]
    have h := List.dedup_map_of_injective Subtype.val_injective coins.attach
    rw [List.attach_map_subtype_val] at h
    rw [h, List.length_map]
  rw [this]

  have : all_coins_in_notes.Nodup := by
    apply amounts_to_coins.nodup
    exact List.nodup_dedup _

  rw [←List.Nodup.dedup this]
  rw [←List.card_toFinset, ←List.card_toFinset]
  apply Finset.card_le_card
  intro ⟨elt, i⟩ h_coin
  rw [List.mem_toFinset, amounts_to_coins.mem]
  rw [List.mem_toFinset, List.mem_map] at h_coin

  replace ⟨coin, h⟩ := h_coin
  constructor
  · simp only [ℓ, List.mem_dedup, List.mem_map]
    use coin, h.1
    simp [coin_to_outgoing_element, h.2]
  · have := coin_to_outgoing_element'_prop context coin (h_final_coins _ h.1)
    rw [h.2] at this
    exact this

-- Given an open-note deposit, returns a list of notes that cover the note's amount.
def forward_tracing {crypto: Crypto} {m: Memory} {events: List (List Event)}
    (context: TracingContext crypto m events)
    (note_id user_enc: ℕ)
    (h_event: .CreateOpenNote note_id user_enc ∈ events.flatten) :
    Finset OutgoingElement :=
  let forward_tracing₀: ForwardTracing₀ := ⟨crypto, m, events, context, note_id, user_enc, h_event⟩
  match h_esn_opt: forward_tracing₀.esn_opt with
  | none =>
    -- If the note is not found, return an empty list.
    .empty
  | some esn =>
    let forward_tracing₁: ForwardTracing₁ := ⟨forward_tracing₀, esn, h_esn_opt⟩
    coins_to_outgoing_elements context forward_tracing₁.final_coins

theorem forward_tracing' {crypto: Crypto} {stxs: SuccessfulTransactions crypto}
    (context: TracingContext crypto stxs.rm.m stxs.events)
    (note_id user_enc: ℕ)
    (h_event: .CreateOpenNote note_id user_enc ∈ stxs.events.flatten) :
    let forward_tracing₀: ForwardTracing₀ := ⟨crypto, stxs.rm.m, stxs.events, context, note_id, user_enc, h_event⟩
    ∃ esn, ∃ h: forward_tracing₀.esn_opt = some esn,
      let forward_tracing₁: ForwardTracing₁ := ⟨forward_tracing₀, esn, h⟩
      forward_tracing context note_id user_enc h_event =
      (coins_to_outgoing_elements context forward_tracing₁.final_coins) := by
  intro forward_tracing₀
  rw [SuccessfulTransactions.events.flatten_eq] at h_event
  have ⟨inp, note_imp, h_note_id, h_r, h_user_enc⟩ := NoteImplies.from_open_note_event h_event

  have h_addrbob : forward_tracing₀.user_addr = inp.addrbob := by
    simp [ForwardTracing₀.user_addr, forward_tracing₀, h_user_enc, crypto.h_council_priv_key,
      crypto.dec_enc]
  have h_addrbob' : forward_tracing₀.user.addr = inp.addrbob := h_addrbob
  let kbob := note_imp.subchannel.channel.kbob
  have : forward_tracing₀.user_priv_key = kbob := by
    simp only [ForwardTracing₀.user_priv_key, forward_tracing₀]
    simp only [forward_tracing₀] at h_addrbob

    let register_imp₀ := note_imp.subchannel.channel.bob_registered
    have register_imp₁ := RegisterImplies.for_get_priv_key stxs.rm inp.addrbob (by
      simp [register_imp₀.public_key]
      exact crypto.zero_not_public_key ⟨_, register_imp₀.h_kalice⟩
    )
    have := register_imp₁.public_key ▸ register_imp₀.public_key
    apply crypto.priv_to_pub_inj (forward_tracing₀.user.k.prop) register_imp₀.h_kalice
    simp only [←h_addrbob, ←SuccessfulTransactions.events.flatten_eq] at this
    exact this
  have : forward_tracing₀.user.k = kbob := by
    apply Subtype.ext; exact this
  have h_esn_opt : forward_tracing₀.esn_opt = some (inp.to_ex_scanned_note crypto) := by
    apply find?_eq_some
    · simp [ForwardTracing₀.received_notes, *]
      exact note_imp.scan_for_recipient
    · rw [decide_eq_true_eq]
      exact h_note_id
    · intro esn' h_esn' h
      simp only [decide_eq_true_eq, forward_tracing₀, ←h_note_id] at h
      have h_eq := CreateNoteInput.to_scanned_note_eq h.symm

      replace ⟨inp', note_imp', h_esn', h₀', h₁', h₂', h₃'⟩ :=
        NoteImplies.from_scan_notes_for_recipient forward_tracing₀.user.h_k h_esn'
      rw [←h_esn'] at h_eq

      have : inp.c crypto = inp'.c crypto := congrArg ScannedNote.c h_eq
      apply crypto.h_hash at this

      apply ExScannedNote.ext
      · rw [←h_esn']
        exact h_eq
      · injections
        simp [*]
      · injections
        rw [h₂']
        assumption

  use inp.to_ex_scanned_note crypto, h_esn_opt
  simp [forward_tracing]
  split
  case h_1 h_esn_opt' =>
    rw [h_esn_opt] at h_esn_opt'
    contradiction
  case h_2 esn h_esn_opt' =>
    convert rfl
    exact Option.some.inj (h_esn_opt ▸ h_esn_opt')

theorem forward_tracing_props
    {crypto: Crypto} {stxs: SuccessfulTransactions crypto}
    (context: TracingContext crypto stxs.rm.m stxs.events)
    (note_id user_enc: ℕ)
    (h_event: .CreateOpenNote note_id user_enc ∈ stxs.events.flatten) :
    let outputs := forward_tracing context note_id user_enc h_event
    (∀ elt ∈ outputs,
      match elt with
      | .Note esn' =>
        stxs.rm.m .Notes [esn'.note_id crypto, 0] ≠ 0 ∧
        stxs.rm.m .Nullifiers [crypto.hash [esn'.c, esn'.token, esn'.i, get_priv_key crypto stxs.events.flatten esn'.addrbob]] = 0
      | .Withdrawal evt =>
        Event.Withdraw evt.user_enc evt.amount evt.token ∈ stxs.events.flatten
    ) := by
  have ⟨esn, h_esn_opt, h_forward_tracing⟩ := forward_tracing' context note_id user_enc h_event
  rw [h_forward_tracing]
  dsimp only
  set forward_tracing₀: ForwardTracing₀ := ⟨crypto, stxs.rm.m, stxs.events, context, note_id, user_enc, h_event⟩ with h_forward_tracing₀
  let forward_tracing₁: ForwardTracing₁ := ⟨forward_tracing₀, esn, h_esn_opt⟩

  intro elt h_elt

  simp only [coins_to_outgoing_elements, List.mem_toFinset, List.mem_dedup, List.mem_map] at h_elt
  replace ⟨coin, h_elt⟩ := h_elt
  have h_final := ForwardTracing₁.final_coins.final forward_tracing₁ coin h_elt.1
  simp only [ForwardTracing₁.final_coins, List.mem_map, List.mem_attach, true_and] at h_elt

  cases elt
  case Note esn' =>
    replace ⟨⟨⟨coin', h_coin⟩, h_next_limit⟩, h_elt⟩ := h_elt
    have := (Graph.next_limit' (ForwardTracing₁.no_prev h_coin)).1
    rw [h_next_limit] at this
    replace := (context.next_coin_none coin).1 this
    simp only [TracingContext.bob] at this
    cases this
    case inr this =>
      replace ⟨_, _, this⟩ := this
      simp [coin_to_outgoing_element, coin_to_outgoing_element', this] at h_elt
    case inl this =>
      have h_esn' : coin.esn = esn' := by
        simp only [coin_to_outgoing_element] at h_elt
        apply Or.elim (coin_to_outgoing_element'_split context coin h_final)
        · intro h
          simp only [h.2, OutgoingElement.Note.injEq] at h_elt
          exact h_elt
        · intro ⟨_, _, h⟩
          simp [h.2] at h_elt

      refine ⟨?_, ?_⟩
      · have ⟨inp, note_imp, h_note_id⟩ := NoteImplies.from_coin coin
        have := note_imp.h_note_exists
        rw [note_exists, h_note_id] at this
        rw [←h_esn']
        exact this
      · rwa [←h_esn']

  case Withdrawal evt =>
    simp only

    apply Or.elim (coin_to_outgoing_element'_split context coin h_final)
    · intro h
      simp [coin_to_outgoing_element, h.2] at h_elt
    · intro ⟨evt', coin_idx, h⟩
      simp only [coin_to_outgoing_element, h.2, OutgoingElement.Withdrawal.injEq] at h_elt
      simp [h_elt.2] at h
      exact (context.next_coin₀_from_some_withdrawal h.1).2.2.2

theorem forward_tracing_sum_amounts
    {crypto: Crypto} {stxs: SuccessfulTransactions crypto}
    (context: TracingContext crypto stxs.rm.m stxs.events)
    (note_id user_enc: ℕ)
    (h_event: .CreateOpenNote note_id user_enc ∈ stxs.events.flatten) :
    let outputs := forward_tracing context note_id user_enc h_event
    ∑ elt ∈ outputs, elt.amount crypto stxs.rm ≥ (crypto.unpack (stxs.rm.m .Notes [note_id, 0])).2 := by
  have ⟨esn, h_esn_opt, h_forward_tracing⟩ := forward_tracing' context note_id user_enc h_event
  simp only [h_forward_tracing]

  apply le_trans _ (coins_to_outgoing_elements.sum_amounts context _ (by
    intro coin h_coin
    let forward_tracing₀: ForwardTracing₀ := ⟨crypto, stxs.rm.m, stxs.events, context, note_id, user_enc, h_event⟩
    let forward_tracing₁: ForwardTracing₁ := ⟨forward_tracing₀, esn, h_esn_opt⟩
    exact ForwardTracing₁.final_coins.final forward_tracing₁ coin h_coin
  ))

  rw [List.Nodup.dedup (ForwardTracing₁.final_coins.nodup _)]
  rw [ForwardTracing₁.final_coins.length]

  set forward_tracing₀: ForwardTracing₀ := ⟨crypto, stxs.rm.m, stxs.events, context, note_id, user_enc, h_event⟩ with h_forward_tracing₀
  let forward_tracing₁: ForwardTracing₁ := ⟨forward_tracing₀, esn, h_esn_opt⟩
  rw [SuccessfulTransactions.events.flatten_eq] at h_event
  have ⟨inp, note_imp, h_note_id, h_r⟩ := NoteImplies.from_open_note_event h_event

  have : esn.note_id crypto = inp.note_id crypto := by
    rw [h_note_id, ForwardTracing₁.esn_opt.note_id forward_tracing₁]

  simp only [ScannedNote.amount, note_amount, this, note_imp.h_r, h_r, reduceIte, ←h_note_id]
  simp
