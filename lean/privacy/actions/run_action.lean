import privacy.actions.action_spec
import privacy.actions.server_actions

abbrev run_action₀ (crypto: Crypto) (action: Action) (m: Memory) : List ServerAction × Bool :=
  match action with
    | .Register inp => register crypto inp m
    | .CreateChannel inp => create_channel crypto inp m
    | .CreateSubchannel inp => create_subchannel crypto inp m
    | .CreateNote inp => create_note crypto inp m
    | .CancelNote inp => cancel_note crypto inp m
    | .OpenDeposit inp => open_deposit crypto inp m

def run_action (crypto: Crypto) (action: Action) (m: Memory) : Memory × Bool :=
  run_action₀ crypto action m |> process_action crypto m

def run_all (crypto: Crypto) (actions: List Action) (m: Memory) : Memory × Bool :=
  actions.foldr (λ action (m, success) ↦
    let (m, success') := run_action crypto action m
    (m, success && success')
  ) (m, true)

@[simp]
theorem run_all_nil (crypto: Crypto) (m: Memory) :
    run_all crypto [] m = (m, true) := rfl

@[simp]
theorem run_all_cons₁
    (crypto: Crypto) (m: Memory) (actions: List Action) (action: Action) :
    (run_all crypto (action :: actions) m).1 =
    (run_action crypto action (run_all crypto actions m).1).1 := by
  conv => lhs; rw [run_all, List.foldr_cons, ←run_all]

@[simp]
theorem run_all_cons₂
    (crypto: Crypto) (m: Memory) (actions: List Action) (action: Action) :
    (run_all crypto (action :: actions) m).2 =
    (
      (run_all crypto actions m).2 ∧
      (run_action crypto action (run_all crypto actions m).1).2
    ) := by
  conv => lhs; rw [run_all, List.foldr_cons, ←run_all]
  simp

theorem run_all_append
    (crypto: Crypto) (m: Memory) (actions₀ actions₁: List Action) :
    (run_all crypto (actions₁ ++ actions₀) m).1 =
    (run_all crypto actions₁ (run_all crypto actions₀ m).1).1 := by
  induction actions₁ generalizing m
  case nil => simp
  case cons action actions₁ ih => simp [ih]

theorem run_all_append₂
    {crypto: Crypto} {m: Memory} {actions₀ actions₁: List Action} :
    (run_all crypto (actions₁ ++ actions₀) m).2 →
    (run_all crypto actions₀ m).2 ∧
    (run_all crypto actions₁ (run_all crypto actions₀ m).1).2 := by
  induction actions₁
  case nil => simp
  case cons action actions₁ ih =>
    rw [List.cons_append, run_all_cons₂, run_all_cons₂]
    intro h
    rw [run_all_append] at h
    simp [ih h.1, h]
