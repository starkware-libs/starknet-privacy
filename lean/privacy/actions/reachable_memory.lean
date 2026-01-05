import privacy.actions.action_spec
import privacy.actions.run_action
import privacy.actions.server_actions

structure ReachableMemory (crypto: Crypto) where
  m: Memory
  actions: List Action
  success: (run_all crypto actions 0).2
  h: m = (run_all crypto actions 0).1

instance : CoeOut (ReachableMemory crypto) Memory where
  coe := ReachableMemory.m

@[simp]
def ReachableMemory.empty {crypto: Crypto} : ReachableMemory crypto :=
  {
    m := 0
    actions := []
    success := by rfl
    h := by rfl
  }

@[simp]
def ReachableMemory.add
    {crypto: Crypto}
    (rm: ReachableMemory crypto)
    (action: Action)
    (success: (run_action crypto action rm.m).2)
  : ReachableMemory crypto :=
  let m' := (run_action crypto action rm.m).1
  let actions' := action :: rm.actions
  let h : m' = (run_all crypto actions' 0).1 := by simp [m', actions', rm.h]
  {
    m := m'
    actions := actions'
    success := by unfold actions'; simp [←rm.h, rm.success, success]
    h := h
  }

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
  ∀ success: (run_action crypto action rm.m).2,
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
  intro ⟨m', actions, success, h⟩
  induction actions generalizing m'

  case nil =>
    simp only [run_all] at h
    subst h
    exact inv₀

  case cons action actions ih =>
    simp only [run_all, List.foldr_cons, Bool.and_eq_true] at success
    let m := (run_all crypto actions 0).1
    let rm : ReachableMemory crypto := ⟨m, actions, success.1, by rfl⟩
    subst h
    exact inv_step action rm (ih m success.1 rm.h) success.2

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
