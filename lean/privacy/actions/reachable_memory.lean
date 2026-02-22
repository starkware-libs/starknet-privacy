import privacy.actions.action_spec
import privacy.actions.run_action
import privacy.actions.server_actions

structure ReachableMemory (crypto: Crypto) where
  actions: List Action
  success: (run_all crypto actions 0).success

abbrev ReachableMemory.m {crypto: Crypto} (rm: ReachableMemory crypto) : Memory :=
  run_all crypto rm.actions 0 |>.m

abbrev ReachableMemory.events {crypto: Crypto} (rm: ReachableMemory crypto) : List Event :=
  run_all crypto rm.actions 0 |>.events

instance : CoeOut (ReachableMemory crypto) Memory where
  coe := ReachableMemory.m

@[simp]
def ReachableMemory.empty {crypto: Crypto} : ReachableMemory crypto :=
  {
    actions := []
    success := by rfl
  }

@[simp]
def ReachableMemory.add
    {crypto: Crypto}
    (rm: ReachableMemory crypto)
    (action: Action)
    (success: (run_action crypto action rm.m).success)
  : ReachableMemory crypto :=
  let m' := (run_action crypto action rm.m).m
  let actions' := action :: rm.actions
  have h : m' = (run_all crypto actions' 0).m := by simp [m', actions']
  {
    actions := actions'
    success := by unfold actions'; simpa [rm.success]
  }

def ReachableMemory.in_add
    {crypto: Crypto}
    (rm: ReachableMemory crypto)
    (action: Action)
    (success: (run_action crypto action rm.m).success) :
    action ∈ (rm.add action success).actions := by
  simp [ReachableMemory.add, List.mem_cons]

theorem ReachableMemory.add_m
    {crypto: Crypto}
    {rm: ReachableMemory crypto} {action: Action} (success: (run_action crypto action rm.m).success) :
    (rm.add action success).m = (run_action crypto action rm.m).m := by
  simp [ReachableMemory.add, ReachableMemory.m]

theorem ReachableMemory.add_events
    {crypto: Crypto}
    {rm: ReachableMemory crypto} {action: Action} (success: (run_action crypto action rm.m).success) :
    (rm.add action success).events = rm.events ++ (run_action crypto action rm.m).events := by
  simp [ReachableMemory.add, ReachableMemory.events]

def ReachableMemory.extends (rm' rm: ReachableMemory crypto) : Prop :=
  rm.actions <:+ rm'.actions

@[ext] theorem ReachableMemory.ext : ∀ {crypto: Crypto} {rm rm' : ReachableMemory crypto},
    rm.actions = rm'.actions → rm = rm' := by
  intro crypto rm rm' h_actions
  cases rm; cases rm'
  simp at *
  simp [*]

abbrev invariant_step
  (crypto: Crypto) (inv: ReachableMemory crypto → Prop) (action: Action) (rm: ReachableMemory crypto) :=
  inv rm →
  ∀ success: (run_action crypto action rm.m).success,
  inv (rm.add action success)

-- Induction for ReachableMemory: If
--   1. property holds for empty state, and
--   2. it is preserved by all actions, then
-- the property holds for all reachable states.
theorem ReachableMemory.induction
    (crypto: Crypto) (f: ReachableMemory crypto → Prop)
    (inv₀ : f ReachableMemory.empty)
    (inv_step: ∀ action: Action, ∀ rm: ReachableMemory crypto,
      invariant_step crypto f action rm)
  : ∀ rm: ReachableMemory crypto, f rm := by
  intro ⟨actions, success⟩
  induction actions

  case nil => exact inv₀

  case cons action actions ih =>
    simp only [run_all, List.foldr_cons, Bool.and_eq_true] at success
    let m := (run_all crypto actions 0).m
    let rm : ReachableMemory crypto := ⟨actions, success.1⟩
    exact inv_step action rm (ih success.1) success.2

theorem invariant_induction_for_extends
    {crypto: Crypto}
    (rm₀: ReachableMemory crypto)
    (inv: ReachableMemory crypto → Prop)
    (inv₀ : inv rm₀)
    (inv_step:
      ∀ action: Action,
      ∀ rm': ReachableMemory crypto,
      rm'.extends rm₀ → invariant_step crypto inv action rm')
  : ∀ rm': ReachableMemory crypto, rm'.extends rm₀ → inv rm' := by
  apply ReachableMemory.induction

  case inv₀ =>
    intro h_extends
    simp only [ReachableMemory.extends, ReachableMemory.empty, List.suffix_nil] at h_extends
    convert inv₀
    ext : 1
    rw [h_extends]
    trivial

  intro action rm' ih success h_extends
  simp [ReachableMemory.extends, List.suffix_cons_iff] at h_extends
  cases h_extends
  case inl h_extends =>
    convert inv₀
    ext : 1
    rw [h_extends]
    trivial
  case inr h_extends =>
    apply inv_step _ _ h_extends
    exact ih h_extends
