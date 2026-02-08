import privacy.actions.action_spec
import privacy.actions.server_actions

abbrev run_action₀ (crypto: Crypto) (action: Action) (m: Memory) : List ServerAction × Bool :=
  match action with
    | .Register inp => register crypto inp m
    | .OpenChannel inp => open_channel crypto inp m
    | .OpenSubchannel inp => open_subchannel crypto inp m
    | .CreateNote inp => create_note crypto inp m
    | .CancelNote inp => cancel_note crypto inp m
    | .OpenDeposit inp => open_deposit crypto inp m

def run_action (crypto: Crypto) (action: Action) (m: Memory) : RunResult :=
  run_action₀ crypto action m |> process_action crypto m

def run_all (crypto: Crypto) (actions: List Action) (m: Memory) : RunResult :=
  actions.foldr (λ action res ↦
    res.add (run_action crypto action res.m)
  ) { m := m, events := [], success := true }

@[simp]
theorem run_all_nil (crypto: Crypto) (m: Memory) :
    run_all crypto [] m = ⟨m, [], true⟩ := rfl

@[simp]
theorem run_all_cons₁
    (crypto: Crypto) (m: Memory) (actions: List Action) (action: Action) :
    (run_all crypto (action :: actions) m).m =
    (run_action crypto action (run_all crypto actions m).m).m := by
  conv => lhs; rw [run_all, List.foldr_cons, ←run_all]

@[simp]
theorem run_all_cons₂
    (crypto: Crypto) (m: Memory) (actions: List Action) (action: Action) :
    (run_all crypto (action :: actions) m).success =
    (
      (run_all crypto actions m).success ∧
      (run_action crypto action (run_all crypto actions m).m).success
    ) := by
  conv => lhs; rw [run_all, List.foldr_cons, ←run_all]
  simp [run_all, RunResult.add]

@[simp]
theorem run_all_cons_events
    (crypto: Crypto) (m: Memory) (actions: List Action) (action: Action) :
    (run_all crypto (action :: actions) m).events =
    (
      (run_all crypto actions m).events ++
      (run_action crypto action (run_all crypto actions m).m).events
    ) := by
  rw [run_all, List.foldr_cons, ←run_all]

@[simp]
theorem run_all_append
    (crypto: Crypto) (m: Memory) (actions₀ actions₁: List Action) :
    (run_all crypto (actions₁ ++ actions₀) m).m =
    (run_all crypto actions₁ (run_all crypto actions₀ m).m).m := by
  induction actions₁ generalizing m
  case nil => simp
  case cons action actions₁ ih => simp [ih]

theorem run_all_append₂
    {crypto: Crypto} {m: Memory} {actions₀ actions₁: List Action} :
    (run_all crypto (actions₁ ++ actions₀) m).success →
    (run_all crypto actions₀ m).success ∧
    (run_all crypto actions₁ (run_all crypto actions₀ m).m).success := by
  induction actions₁
  case nil => simp
  case cons action actions₁ ih =>
    rw [List.cons_append, run_all_cons₂, run_all_cons₂]
    intro h
    rw [run_all_append] at h
    simp [ih h.1, h]

theorem run_all_append_events
    {crypto: Crypto} {m: Memory} {actions₀ actions₁: List Action} :
    (run_all crypto (actions₁ ++ actions₀) m).events =
    (run_all crypto actions₀ m).events ++
    (run_all crypto actions₁ (run_all crypto actions₀ m).m).events := by
  induction actions₁
  case nil => simp
  case cons action actions₁ ih => simp [ih]
