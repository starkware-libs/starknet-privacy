import privacy.tracing.tracing

structure ForwardTracing₀ where
  (crypto: Crypto) (m: Memory) (events: List Event)
  (context: TracingContext crypto m events)
  (note_id user_enc: ℕ)
  (h_event: .CreateOpenNote note_id user_enc ∈ events)

-- Decrypt the user address.
def ForwardTracing₀.user_addr (self: ForwardTracing₀) :=
   (self.crypto.dec self.crypto.council_priv_key self.user_enc).headD 0

-- Get the user's private key.
def ForwardTracing₀.user_priv_key (self: ForwardTracing₀) :=
  get_priv_key self.crypto self.events self.user_addr

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
      intro i₀ i₁ h_eq
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

-- Given an open-note deposit, returns a list of notes that cover the note's amount.
def forward_tracing {crypto: Crypto} {m: Memory} {events: List Event}
    (context: TracingContext crypto m events)
    (note_id user_enc: ℕ)
    (h_event: .CreateOpenNote note_id user_enc ∈ events) :
    Finset ExScannedNote :=
  let forward_tracing₀: ForwardTracing₀ := ⟨crypto, m, events, context, note_id, user_enc, h_event⟩
  match h_esn_opt: forward_tracing₀.esn_opt with
  | none =>
    -- If the note is not found, return an empty list.
    .empty
  | some esn =>
    let forward_tracing₁: ForwardTracing₁ := ⟨forward_tracing₀, esn, h_esn_opt⟩
    coins_to_notes forward_tracing₁.final_coins

theorem forward_tracing' {crypto: Crypto} {rm: ReachableMemory crypto}
    (context: TracingContext crypto rm.m rm.events)
    (note_id user_enc: ℕ)
    (h_event: .CreateOpenNote note_id user_enc ∈ rm.events) :
    let forward_tracing₀: ForwardTracing₀ := ⟨crypto, rm.m, rm.events, context, note_id, user_enc, h_event⟩
    ∃ esn, ∃ h: forward_tracing₀.esn_opt = some esn,
      let forward_tracing₁: ForwardTracing₁ := ⟨forward_tracing₀, esn, h⟩
      forward_tracing context note_id user_enc h_event =
      (coins_to_notes forward_tracing₁.final_coins) := by
  intro forward_tracing₀
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
    have register_imp₁ := RegisterImplies.for_get_priv_key rm inp.addrbob (by
      simp [register_imp₀.public_key]
      exact crypto.zero_not_public_key ⟨_, register_imp₀.h_kalice⟩
    )
    have := register_imp₁.public_key ▸ register_imp₀.public_key
    apply crypto.priv_to_pub_inj (forward_tracing₀.user.k.prop) register_imp₀.h_kalice
    simp only [←h_addrbob] at this
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
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (context: TracingContext crypto rm.m rm.events)
    (note_id user_enc: ℕ)
    (h_event: .CreateOpenNote note_id user_enc ∈ rm.events) :
    let output_notes := forward_tracing context note_id user_enc h_event
    (∀ esn' ∈ output_notes,
      rm.m .Notes [esn'.note_id crypto, 0] ≠ 0 ∧
      rm.m .Nullifiers [crypto.hash [esn'.c, esn'.token, esn'.i₀, esn'.i₁, get_priv_key crypto rm.events esn'.addrbob]] = 0
    ) := by
  have ⟨esn, h_esn_opt, h_forward_tracing⟩ := forward_tracing' context note_id user_enc h_event
  rw [h_forward_tracing]
  dsimp only
  set forward_tracing₀: ForwardTracing₀ := ⟨crypto, rm.m, rm.events, context, note_id, user_enc, h_event⟩ with h_forward_tracing₀

  intro esn' h_esn'
  simp only [coins_to_notes, List.mem_toFinset, List.mem_dedup, List.mem_map] at h_esn'
  replace ⟨coin, h_coin, h_esn'⟩ := h_esn'
  simp only [ForwardTracing₁.final_coins, List.mem_map, List.mem_attach] at h_coin
  replace ⟨⟨coin', h_coin⟩, _, h_next_limit⟩ := h_coin
  have := (context.tracing_graph.next_limit' (ForwardTracing₁.no_prev h_coin)).1
  rw [h_next_limit] at this
  replace := (context.next_coin_none coin).1 this
  simp only [h_esn', TracingContext.bob] at this

  refine ⟨?_, this⟩
  · have ⟨inp, note_imp, h_note_id⟩ := NoteImplies.from_coin coin
    have := note_imp.h_note_exists
    rw [note_exists, h_note_id] at this
    rw [←h_esn']
    exact this

theorem forward_tracing_sum_amounts
    {crypto: Crypto} {rm: ReachableMemory crypto}
    (context: TracingContext crypto rm.m rm.events)
    (note_id user_enc: ℕ)
    (h_event: .CreateOpenNote note_id user_enc ∈ rm.events) :
    let output_notes := forward_tracing context note_id user_enc h_event
    ∑ esn ∈ output_notes, esn.amount crypto rm ≥ (crypto.unpack (rm.m .Notes [note_id, 0])).2 := by
  have ⟨esn, h_esn_opt, h_forward_tracing⟩ := forward_tracing' context note_id user_enc h_event
  rw [h_forward_tracing]
  intro output_notes

  apply le_trans _ (coins_to_notes.sum_amounts _)
  rw [List.Nodup.dedup (ForwardTracing₁.final_coins.nodup _)]
  rw [ForwardTracing₁.final_coins.length]

  set forward_tracing₀: ForwardTracing₀ := ⟨crypto, rm.m, rm.events, context, note_id, user_enc, h_event⟩ with h_forward_tracing₀
  let forward_tracing₁: ForwardTracing₁ := ⟨forward_tracing₀, esn, h_esn_opt⟩
  have ⟨inp, note_imp, h_note_id, h_r⟩ := NoteImplies.from_open_note_event h_event

  have : esn.note_id crypto = inp.note_id crypto := by
    rw [h_note_id, ForwardTracing₁.esn_opt.note_id forward_tracing₁]

  simp only [ScannedNote.amount, note_amount, this, note_imp.h_r, h_r, reduceIte, ←h_note_id]
  simp
