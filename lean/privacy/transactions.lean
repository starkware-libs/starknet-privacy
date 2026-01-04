import privacy.utils
import privacy.actions
import privacy.immutability

structure Transaction where
  actions: List Action

def run_transaction_action (crypto: Crypto) (action: Action) (inp: Memory × Memory × Bool) : Memory × Memory × Bool :=
  let (m_s, m_c, success) := inp

  -- Run the client-side.
  let ⟨server_actions, success_c⟩ := run_action₀ crypto action m_c
  -- "Server"-side `success` of `run_all` on `m_c` is ignored.
  let ⟨m_c, _⟩ := ServerAction.run_all crypto server_actions m_c

  -- Run the server-side.
  let ⟨m_s, success_s⟩ := ServerAction.run_all crypto server_actions m_s

  (m_s, m_c, success && success_c && success_s)

def run_transaction_actions (crypto: Crypto) (actions: List Action) (m_s m_c: Memory) : Memory × Memory × Bool :=
  actions.foldr (run_transaction_action crypto) (m_s, m_c, true)

theorem run_transaction_actions_cons₁ (crypto: Crypto) (action: Action) (actions: List Action) (m_s m_c: Memory) :
    (run_transaction_actions crypto (action :: actions) m_s m_c).1 =
    let res := run_transaction_actions crypto actions m_s m_c
    (ServerAction.run_all crypto (run_action₀ crypto action res.2.1).1 res.1).1 := by
  rw [run_transaction_actions, run_transaction_actions, List.foldr_cons, run_transaction_action]

theorem run_transaction_actions_cons₂ (crypto: Crypto) (action: Action) (actions: List Action) (m_s m_c: Memory) :
    (run_transaction_actions crypto (action :: actions) m_s m_c).2.1 =
    let res := run_transaction_actions crypto actions m_s m_c
    (ServerAction.run_all crypto (run_action₀ crypto action res.2.1).1 res.2.1).1 := by
  rw [run_transaction_actions, run_transaction_actions, List.foldr_cons, run_transaction_action]

theorem run_transaction_actions_cons₃ (crypto: Crypto) (action: Action) (actions: List Action) (m_s m_c: Memory) :
    (run_transaction_actions crypto (action :: actions) m_s m_c).2.2 =
    let res := run_transaction_actions crypto actions m_s m_c
    let client_success := (run_action₀ crypto action res.2.1).2
    let server_success := (ServerAction.run_all crypto (run_action₀ crypto action res.2.1).1 res.1).2
    res.2.2 && client_success && server_success := by
  rw [run_transaction_actions, run_transaction_actions, List.foldr_cons, run_transaction_action]

-- A transaction and the "time" where the client-side ran.
-- If `time=t`, it means that the client-side ran after the server-side execution of the first `t`
-- transactions.
structure TimedTransaction where
  tx: Transaction
  time: ℕ

def run_transactions' (crypto: Crypto) (ttxs: List TimedTransaction) : Memory × (List Memory) × Bool :=
  let initial_m: Memory := 0
  ttxs.foldr (λ ttx (m, past_ms, success) ↦
    let (m, _, success') := run_transaction_actions crypto ttx.tx.actions m (past_ms[ttx.time]? |>.getD initial_m)
    (m, past_ms ++ [m], success && success')
  ) (initial_m, ([initial_m] : List Memory), true)

def run_transactions (crypto: Crypto) (ttxs: List TimedTransaction) : Memory × Bool :=
  let res := run_transactions' crypto ttxs
  (res.1, res.2.2)

-------------------------

theorem add_transaction_is_reachable
    (crypto: Crypto) (actions: List Action) (rm_s rm_c: ReachableMemory crypto)
    (h_extends: rm_s.extends rm_c) :
    let res := run_transaction_actions crypto actions rm_s rm_c
    res.2.2 →
    (∃ rm: ReachableMemory crypto,
      rm.actions = actions ++ rm_s.actions ∧
      rm.m = res.1
    ) ∧ (∃ server_actions: List ServerAction,
      res.1 = (ServerAction.run_all crypto server_actions rm_s).1 ∧
      res.2.1 = (ServerAction.run_all crypto server_actions rm_c).1
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
    set client_res := run_action₀ crypto action res.2.1 with h_client_res

    rw [run_transaction_actions_cons₃] at success
    simp only [Bool.and_eq_true] at success
    have success₀ : res.2.2 := success.1.1
    have success₁ : client_res.2 := success.1.2
    have success₂ : (ServerAction.run_all crypto client_res.1 res.1).2 := success.2

    obtain ⟨⟨rm, ih₀, ih₁⟩, ⟨server_actions, ih₂, ih₃⟩⟩ := ih success₀
    dsimp only at ih

    have h_same_actions : run_action₀ crypto action res.1 = client_res := by
      let e: TransactionExecution := { m_c₀ := rm_c.m, m_s₀ := rm_s.m, actions := server_actions }
      apply run_action₀_immutable (success:=success₁)

      have h_extends' : rm.extends rm_c := by
        have ⟨a, h⟩ := h_extends
        use actions ++ a
        simp [h, ih₀]

      have := ImmutableCells.reflected_immutability' e (by
        unfold TransactionExecution.m_s
        rw [←ih₂, ←ih₁]
        exact ImmutableCells.of_extends crypto h_extends'
      )
      rw [ih₂, ih₃]
      exact this

    constructor
    · use rm.add action (by
        rw [run_action, process_action, ih₁]
        simp only [Bool.and_eq_true]
        rw [h_same_actions]
        exact ⟨success₁, success₂⟩
      )
      constructor
      · simp [ih₀]
      ·
        dsimp only [ReachableMemory.add]
        rw [ih₁, run_transaction_actions_cons₁, run_action, process_action]
        dsimp only
        rw [h_same_actions]
    · use server_actions ++ (run_action₀ crypto action res.1).1
      constructor
      · rw [run_transaction_actions_cons₁]
        dsimp only
        rw [ServerAction.run_all_append, ←h_res, ←ih₂, h_same_actions]
      · rw [run_transaction_actions_cons₂]
        dsimp only
        rw [ServerAction.run_all_append, ←h_res, ←ih₃, h_same_actions]

-------------------------

theorem zero_in_past_ms
    (crypto: Crypto) (ttxs: List TimedTransaction) :
    0 ∈ (run_transactions' crypto ttxs).2.1 := by
  induction ttxs
  case nil => simp [run_transactions']
  case cons ttx ttxs ih =>
    rw [run_transactions', List.foldr_cons, ←run_transactions']
    dsimp only
    rw [List.mem_append]
    exact Or.inl ih

theorem run_transactions'_add_tx
    (crypto: Crypto) (ttxs: List TimedTransaction) (ttx: TimedTransaction) :
    let res₀ := run_transactions' crypto ttxs
    let res₁ := run_transactions' crypto (ttx :: ttxs)
    res₁.2.2 →
    res₀.2.2 ∧
    ∃ past_m ∈ res₀.2.1,
    res₁.1 = (run_transaction_actions crypto ttx.tx.actions res₀.1 past_m).1 ∧
    (run_transaction_actions crypto ttx.tx.actions res₀.1 past_m).2.2 := by
  dsimp only
  set res₀ := run_transactions' crypto ttxs with h_res₀
  set res₁ := run_transactions' crypto (ttx :: ttxs) with h_res₁
  intro success
  unfold res₁ at success
  rw [run_transactions', List.foldr_cons, ←run_transactions'] at success
  dsimp only at success
  simp [Bool.and_eq_true] at success
  have ⟨success₀, success₁⟩ := success
  use success₀
  use res₀.2.1[ttx.time]?.getD 0
  refine ⟨?_, ?_, ?_⟩
  · by_cases h: ttx.time < res₀.2.1.length
    case pos => simp [List.getElem?_eq_getElem h]
    case neg =>
      rw [List.getElem?_eq_none (by omega)]
      simp only [Option.getD_none]
      apply zero_in_past_ms
  · unfold res₁
    rw [run_transactions', List.foldr_cons, ←run_transactions']
  · exact success₁

theorem run_transactions'_is_reachable
    (crypto: Crypto) (ttxs: List TimedTransaction) :
    let res := run_transactions' crypto ttxs
    res.2.2 →
    (∃ rm: ReachableMemory crypto,
      rm.actions = ttxs >>= (λ ttx ↦ ttx.tx.actions) ∧
      rm.m = res.1 ∧
      (∀ past_m ∈ res.2.1, ∃ past_rm: ReachableMemory crypto,
        past_rm.m = past_m ∧ rm.extends past_rm
      )
    ) := by
  intro res success
  induction ttxs
  case nil =>
    use ReachableMemory.empty
    refine ⟨?_, ?_, ?_⟩
    · trivial
    · trivial
    · unfold res
      intro past_m h_past_m
      use ReachableMemory.empty
      simp only [run_transactions', List.foldr_nil, List.mem_cons, List.not_mem_nil, or_false] at h_past_m
      rw [h_past_m]
      constructor
      · trivial
      · exact ⟨[], by simp⟩
  case cons ttx ttxs ih =>
    unfold res at success
    have ⟨success₀, past_m, h₀, h₁, h₂⟩ := run_transactions'_add_tx crypto ttxs ttx success
    have ⟨rm_s, ih₀, ih₁, ih_past_ms⟩ := ih success₀
    have ⟨past_rm, h_past_rm, h_extends⟩ := ih_past_ms past_m h₀
    have ⟨⟨rm, h_rm_actions, h_rm_m⟩, _⟩ := add_transaction_is_reachable crypto ttx.tx.actions rm_s past_rm h_extends (by rwa [h_past_rm, ih₁])

    have h_rm_m_eq_res1 : rm.m = res.1 := by
      unfold res
      rw [h_rm_m, ih₁, h_past_rm, h₁]

    use rm
    refine ⟨?_, ?_, ?_⟩
    · simp [h_rm_actions, ih₀]
    · exact h_rm_m_eq_res1
    · intro past_m h_past_m
      unfold res at h_past_m
      rw [run_transactions', List.foldr_cons, ←run_transactions'] at h_past_m
      simp only [List.mem_append, List.mem_cons, List.not_mem_nil, or_false] at h_past_m
      cases h_past_m
      case inl h_past_m =>
        have ⟨past_rm, h_past_rm_m, ⟨actions, h_actions⟩⟩ := ih_past_ms past_m h_past_m
        refine ⟨past_rm, h_past_rm_m, ?_⟩
        use ttx.tx.actions ++ actions
        simp [h_rm_actions, ←h_actions]
      case inr h_past_m =>
        rw [h_past_m]
        exact ⟨rm, h_rm_m_eq_res1, [], by simp⟩

theorem run_transactions_eq_run_sequentially
    {crypto: Crypto} {ttxs: List TimedTransaction} :
    let res := run_transactions crypto ttxs
    let res_seq := run_all crypto (ttxs >>= (λ ttx ↦ ttx.tx.actions)) 0
    res.2 → res = res_seq := by
  intro res res_seq success
  have ⟨rm, h₀, h₁, _⟩ := run_transactions'_is_reachable crypto ttxs success
  unfold res res_seq
  rw [run_transactions]
  apply Prod.ext
  · rw [←h₁, rm.h, h₀]
  · rwa [←h₀, rm.success]
