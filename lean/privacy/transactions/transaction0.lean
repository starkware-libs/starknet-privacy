import privacy.utils
import privacy.actions
import privacy.transactions.immutability

structure Transaction₀ where
  actions: List Action

structure RunTransactionActionResult where
  m_s: Memory
  m_c: Memory
  events: List Event
  success: Bool

def run_transaction_action (crypto: Crypto) (action: Action) (inp: RunTransactionActionResult) : RunTransactionActionResult :=
  -- Run the client-side.
  let ⟨server_actions, success_c⟩ := run_action₀ crypto action inp.m_c
  -- "Server"-side `success` of `run_all` on `m_c` is ignored.
  let ⟨m_c, _⟩ := ServerAction.run_all crypto server_actions inp.m_c

  -- Run the server-side.
  let ⟨m_s, success_s⟩ := ServerAction.run_all crypto server_actions inp.m_s

  let events' := inp.events ++get_events server_actions

  { m_s := m_s, m_c := m_c, events := events', success := inp.success && success_c && success_s }

def run_transaction_actions (crypto: Crypto) (actions: List Action) (m_s m_c: Memory) : RunTransactionActionResult :=
  actions.foldr (run_transaction_action crypto) { m_s := m_s, m_c := m_c, events := [], success := true }

theorem run_transaction_actions_cons₁ (crypto: Crypto) (action: Action) (actions: List Action) (m_s m_c: Memory) :
    (run_transaction_actions crypto (action :: actions) m_s m_c).m_s =
    let res := run_transaction_actions crypto actions m_s m_c
    (ServerAction.run_all crypto (run_action₀ crypto action res.m_c).1 res.m_s).1 := by
  rw [run_transaction_actions, run_transaction_actions, List.foldr_cons, run_transaction_action]

theorem run_transaction_actions_cons₂ (crypto: Crypto) (action: Action) (actions: List Action) (m_s m_c: Memory) :
    (run_transaction_actions crypto (action :: actions) m_s m_c).m_c =
    let res := run_transaction_actions crypto actions m_s m_c
    (ServerAction.run_all crypto (run_action₀ crypto action res.m_c).1 res.m_c).1 := by
  rw [run_transaction_actions, run_transaction_actions, List.foldr_cons, run_transaction_action]

theorem run_transaction_actions_cons₃ (crypto: Crypto) (action: Action) (actions: List Action) (m_s m_c: Memory) :
    (run_transaction_actions crypto (action :: actions) m_s m_c).success =
    let res := run_transaction_actions crypto actions m_s m_c
    let client_success := (run_action₀ crypto action res.m_c).2
    let server_success := (ServerAction.run_all crypto (run_action₀ crypto action res.m_c).1 res.m_s).2
    res.success && client_success && server_success := by
  rw [run_transaction_actions, run_transaction_actions, List.foldr_cons, run_transaction_action]

theorem run_transaction_actions_m_c
    (crypto: Crypto) (actions: List Action) (m_s m_c: Memory) :
    (run_transaction_actions crypto actions m_s m_c).m_c =
    (run_all crypto actions m_c).m := by
  induction actions
  case nil => simp [run_transaction_actions]
  case cons action actions ih =>
    rw [run_transaction_actions, List.foldr_cons, ←run_transaction_actions, run_transaction_action]
    dsimp only
    rw [run_all_cons₁, ih]
    rfl

theorem run_transaction_actions_events
    (crypto: Crypto) (actions: List Action) (m_s m_c: Memory) :
    (run_transaction_actions crypto actions m_s m_c).events =
    (run_all crypto actions m_c).events := by
  induction actions
  case nil => simp [run_transaction_actions]
  case cons action actions ih =>
    rw [run_transaction_actions, List.foldr_cons, ←run_transaction_actions, run_transaction_action]
    dsimp only
    rw [run_all_cons_events, ih, List.append_cancel_left_eq]
    rw [run_transaction_actions_m_c]
    rfl

-- A transaction and the "time" where the client-side ran.
-- If `time=t`, it means that the client-side ran after the server-side execution of the first `t`
-- transactions.
structure TimedTransaction extends Transaction₀ where
  time: ℕ

structure RunTransactionsResult where
  m: Memory
  past_ms: List Memory
  events: List (List Event)
  success: Bool

def run_transactions (crypto: Crypto) (ttxs: List TimedTransaction) : RunTransactionsResult :=
  let initial_m: Memory := 0
  ttxs.foldr (λ ttx res ↦
    let res' := run_transaction_actions crypto ttx.actions res.m (res.past_ms[ttx.time]? |>.getD initial_m)
    { m := res'.m_s, past_ms := res.past_ms ++ [res'.m_s], events := res.events ++ [res'.events], success := res.success && res'.success }
  ) { m :=initial_m, past_ms := [initial_m], events := [], success := true }

-------------------------

theorem add_transaction_is_reachable
    (crypto: Crypto) (actions: List Action) (rm_s rm_c: ReachableMemory crypto)
    (h_extends: rm_s.extends rm_c) :
    let res := run_transaction_actions crypto actions rm_s rm_c
    res.success →
    (∃ rm: ReachableMemory crypto,
      rm.actions = actions ++ rm_s.actions ∧
      rm.m = res.m_s ∧
      rm.events = rm_s.events ++ res.events
    ) ∧ (∃ server_actions: List ServerAction,
      res.m_s = (ServerAction.run_all crypto server_actions rm_s).1 ∧
      res.m_c = (ServerAction.run_all crypto server_actions rm_c).1
    ) := by
  induction actions
  case nil =>
    dsimp only
    intro success
    constructor
    · use rm_s
      simp [run_transaction_actions]
    · use []
      simp [run_transaction_actions, ServerAction.run_all]

  case cons action actions ih =>
    dsimp only
    intro success
    set res := run_transaction_actions crypto actions rm_s.m rm_c.m with h_res
    set client_res := run_action₀ crypto action res.m_c with h_client_res

    rw [run_transaction_actions_cons₃] at success
    simp only [Bool.and_eq_true] at success
    have success₀ : res.success := success.1.1
    have success₁ : client_res.2 := success.1.2
    have success₂ : (ServerAction.run_all crypto client_res.1 res.m_s).2 := success.2

    obtain ⟨⟨rm, ih₀, ih₁, ih₂⟩, ⟨server_actions, ih₃, ih₄⟩⟩ := ih success₀
    dsimp only at ih

    have h_same_actions : run_action₀ crypto action res.m_s = client_res := by
      let e: TransactionExecution := { m_c₀ := rm_c.m, m_s₀ := rm_s.m, actions := server_actions }
      apply run_action₀_immutable (success:=success₁)

      have h_extends' : rm.extends rm_c := by
        have ⟨a, h⟩ := h_extends
        use actions ++ a
        simp [h, ih₀]

      have := ImmutableCells.reflected_immutability' e (by
        unfold TransactionExecution.m_s
        rw [←ih₃, ←ih₁]
        exact ImmutableCells.of_extends crypto h_extends'
      )
      rw [ih₃, ih₄]
      exact this

    constructor
    · use rm.add action (by
        rw [run_action, process_action, ih₁]
        simp only [Bool.and_eq_true]
        rw [h_same_actions]
        exact ⟨success₁, success₂⟩
      )
      refine ⟨?_, ?_, ?_⟩
      · simp [ih₀]
      · rw [ReachableMemory.add_m, ih₁, run_transaction_actions_cons₁, run_action, process_action]
        dsimp only
        rw [h_same_actions]
      · rw [ReachableMemory.add_events, ih₂]
        rw [List.append_assoc, List.append_cancel_left_eq]
        conv => rhs; rw [run_transaction_actions_events, run_all_cons_events]
        rw [←run_transaction_actions_events (m_s:=rm_s.m)]
        rw [List.append_cancel_left_eq]
        dsimp only [run_action, process_action]
        rw [ih₁, h_same_actions, h_client_res]
        rw [run_transaction_actions_m_c]
    · use server_actions ++ (run_action₀ crypto action res.m_s).1
      constructor
      · rw [run_transaction_actions_cons₁]
        dsimp only
        rw [ServerAction.run_all_append, ←h_res, ←ih₃, h_same_actions]
      · rw [run_transaction_actions_cons₂]
        dsimp only
        rw [ServerAction.run_all_append, ←h_res, ←ih₄, h_same_actions]

-------------------------

theorem zero_in_past_ms
    (crypto: Crypto) (ttxs: List TimedTransaction) :
    0 ∈ (run_transactions crypto ttxs).past_ms := by
  induction ttxs
  case nil => simp [run_transactions]
  case cons ttx ttxs ih =>
    rw [run_transactions, List.foldr_cons, ←run_transactions]
    dsimp only
    rw [List.mem_append]
    exact Or.inl ih

theorem run_transactions_add_tx
    (crypto: Crypto) (ttxs: List TimedTransaction) (ttx: TimedTransaction) :
    let res₀ := run_transactions crypto ttxs
    let res₁ := run_transactions crypto (ttx :: ttxs)
    res₁.success →
    res₀.success ∧
    ∃ past_m ∈ res₀.past_ms,
    res₁.m = (run_transaction_actions crypto ttx.actions res₀.m past_m).m_s ∧
    res₁.events = res₀.events ++ [(run_transaction_actions crypto ttx.actions res₀.m past_m).events] ∧
    (run_transaction_actions crypto ttx.actions res₀.m past_m).success ∧
    past_m = res₀.past_ms[ttx.time]?.getD 0 := by
  dsimp only
  set res₀ := run_transactions crypto ttxs with h_res₀
  set res₁ := run_transactions crypto (ttx :: ttxs) with h_res₁
  intro success
  unfold res₁ at success
  rw [run_transactions, List.foldr_cons, ←run_transactions] at success
  dsimp only at success
  simp [Bool.and_eq_true] at success
  have ⟨success₀, success₁⟩ := success
  use success₀
  use res₀.past_ms[ttx.time]?.getD 0
  refine ⟨?_, ?_, ?_, ?_, ?_⟩
  · by_cases h: ttx.time < res₀.past_ms.length
    case pos => simp [List.getElem?_eq_getElem h]
    case neg =>
      rw [List.getElem?_eq_none (by omega)]
      simp only [Option.getD_none]
      apply zero_in_past_ms
  · unfold res₁
    rw [run_transactions, List.foldr_cons, ←run_transactions]
  · unfold res₁
    rw [run_transactions, List.foldr_cons, ←run_transactions]
  · exact success₁
  · rfl

theorem run_transactions_is_reachable
    (crypto: Crypto) (ttxs: List TimedTransaction) :
    let res := run_transactions crypto ttxs
    res.success →
    (∃ rm: ReachableMemory crypto,
      rm.actions = ttxs >>= (λ ttx ↦ ttx.actions) ∧
      rm.m = res.m ∧
      rm.events = res.events.flatten ∧
      (∀ past_m ∈ res.past_ms, ∃ past_rm: ReachableMemory crypto,
        past_rm.m = past_m ∧ rm.extends past_rm
      )
    ) := by
  intro res success
  induction ttxs
  case nil =>
    use ReachableMemory.empty
    refine ⟨?_, ?_, ?_, ?_⟩
    · trivial
    · trivial
    · trivial
    · unfold res
      intro past_m h_past_m
      use ReachableMemory.empty
      simp only [run_transactions, List.foldr_nil, List.mem_cons, List.not_mem_nil, or_false] at h_past_m
      rw [h_past_m]
      constructor
      · trivial
      · exact ⟨[], by simp⟩
  case cons ttx ttxs ih =>
    unfold res at success
    have ⟨success₀, past_m, h₀, h₁, h₂, h₃, _⟩ := run_transactions_add_tx crypto ttxs ttx success
    have ⟨rm_s, ih₀, ih₁, ih_events, ih_past_ms⟩ := ih success₀
    have ⟨past_rm, h_past_rm, h_extends⟩ := ih_past_ms past_m h₀
    have ⟨⟨rm, h_rm_actions, h_rm_m, h_rm_events⟩, _⟩ := add_transaction_is_reachable crypto ttx.actions rm_s past_rm h_extends (by rwa [h_past_rm, ih₁])

    have h_rm_m_eq_res1 : rm.m = res.m := by
      unfold res
      rw [h_rm_m, ih₁, h_past_rm, h₁]

    use rm
    refine ⟨?_, ?_, ?_, ?_⟩
    · simp [h_rm_actions, ih₀]
    · exact h_rm_m_eq_res1
    · rw [h_rm_events]
      rw [h₂, List.flatten_append, List.flatten_singleton]
      rw [←ih_events, List.append_cancel_left_eq]
      rw [ih₁, h_past_rm]
    · intro past_m h_past_m
      unfold res at h_past_m
      rw [run_transactions, List.foldr_cons, ←run_transactions] at h_past_m
      simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at h_past_m
      cases h_past_m
      case inl h_past_m =>
        have ⟨past_rm, h_past_rm_m, ⟨actions, h_actions⟩⟩ := ih_past_ms past_m h_past_m
        refine ⟨past_rm, h_past_rm_m, ?_⟩
        use ttx.actions ++ actions
        simp [h_rm_actions, ←h_actions]
      case inr h_past_m =>
        rw [h_past_m]
        exact ⟨rm, h_rm_m_eq_res1, [], by simp⟩

theorem run_transactions_eq_run_sequentially
    {crypto: Crypto} {ttxs: List TimedTransaction} :
    let res := run_transactions crypto ttxs
    let ⟨res_seq_m, res_seq_events, res_seq_success⟩ := run_all crypto (ttxs >>= (λ ttx ↦ ttx.actions)) 0
    res.success → (
      res.m = res_seq_m ∧
      res.events.flatten = res_seq_events ∧
      res.success = res_seq_success
     ) := by
  dsimp only
  intro success
  have ⟨rm, h₀, h₁, h₂, _⟩ := run_transactions_is_reachable crypto ttxs success
  rw [←h₀, ←h₁, ←h₂]
  refine ⟨?_, ?_, ?_⟩
  · rw [ReachableMemory.m, h₀, run_all]
  · rfl
  · rw [success, rm.success]
