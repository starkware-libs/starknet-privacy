import Mathlib.Data.Nat.Basic
import Mathlib.Data.Nat.Find
import Mathlib.Tactic

structure Graph (α: Type) where
  next: α → Option α
  prev: α → Option α
  next_iff_prev: ∀ {x y}, next x = some y ↔ prev y = some x
  h_fintype: Nonempty (Fintype α)

def Graph.dual (g: Graph α) : Graph α := {
  next := g.prev
  prev := g.next
  next_iff_prev := g.next_iff_prev.symm
  h_fintype := g.h_fintype
}

def Graph.next_n (g: Graph α) (n: ℕ) (x: α) : Option α := match n with
  | 0 => some x
  | n + 1 => g.next x >>= g.next_n n

def Graph.prev_n (g: Graph α) (n: ℕ) (x: α) : Option α :=
  Graph.next_n (g.dual) n x

theorem Graph.next_n_succ (g: Graph α) (x: α) (n: ℕ) :
    g.next_n (n + 1) x = g.next_n n x >>= g.next := by
  induction n generalizing x
  case zero => simp [Graph.next_n]
  case succ n ih =>
    simp only [Graph.next_n, bind_assoc] at *
    apply congrArg
    ext y
    rw [ih y]

theorem Graph.prev_n_succ (g: Graph α) (x: α) (n: ℕ) :
    g.prev_n (n + 1) x = g.prev_n n x >>= g.prev := by
  exact Graph.next_n_succ (g.dual) x n

theorem Graph.next_n_add (g: Graph α) (x: α) (n₀ n₁: ℕ) :
    g.next_n (n₀ + n₁) x = (g.next_n n₀ x) >>= g.next_n n₁ := by
  induction n₁ generalizing x
  case zero => simp [Graph.next_n]
  case succ n₁ ih =>
    rw [←add_assoc, Graph.next_n_succ]
    rw [ih]
    rw [bind_assoc]
    apply congrArg
    ext y
    simp only [Graph.next_n_succ]

theorem Graph.next_n_iff_prev_n {g: Graph α} {x: α} :
    g.next_n n x = some y ↔ g.prev_n n y = some x := by
  induction n generalizing x y
  case zero =>
    simp [Graph.next_n, Graph.prev_n]
    constructor
    all_goals intro h; exact h.symm
  case succ n ih =>
    constructor
    · intro h
      simp only [Graph.next_n_succ, Option.bind_eq_bind, Option.bind_eq_some_iff] at h
      replace ⟨z, h⟩ := h
      have : g.prev_n (n + 1) y = g.prev y >>= g.prev_n n := by rfl
      rw [this, g.next_iff_prev.1 h.2, ←h.1]
      apply Option.bind_eq_some_iff.2
      refine ⟨z, h.1, (ih (x:=x) (y:=z)).1 h.1⟩
    · intro h
      simp only [Graph.prev_n_succ, Option.bind_eq_bind, Option.bind_eq_some_iff] at h
      replace ⟨z, h⟩ := h
      rw [Graph.next_n, g.next_iff_prev.2 h.2, ←h.1]
      apply Option.bind_eq_some_iff.2
      refine ⟨z, h.1, (ih (x:=z) (y:=y)).2 h.1⟩

theorem Graph.next_n_seq_nodup {g: Graph α} {x: α}
    (no_prev : g.prev x = none)
    (n₀ Δ: ℕ)
    (h : g.next_n (n₀ + Δ + 1) x = g.next_n n₀ x) :
    g.next_n n₀ x = none := by
  induction n₀
  case zero =>
    rw [Graph.next_n, Graph.next_n_succ, zero_add] at h
    have ⟨y, h₀, h⟩ := Option.bind_eq_some_iff.1 h
    have := (g.next_iff_prev.1 h) ▸ no_prev
    contradiction
  case succ n₀ ih =>
    simp only [Graph.next_n_succ] at h ⊢
    cases h_n₀ : g.next_n n₀ x
    case none => simp
    case some x_n₀ =>
      simp only [h_n₀, Option.bind_eq_bind, Option.bind_some] at h ih ⊢
      cases h_Δ : g.next_n (n₀ + 1 + Δ) x
      case none =>
        rw [h_Δ] at h
        simp only [Option.bind_none] at h
        rw [h]
      case some x_Δ =>
        rw [(by omega: n₀ + Δ + 1 = n₀ + 1 + Δ)] at ih
        simp only [h_Δ, Option.bind_some] at h ih
        cases h': g.next x_n₀
        case none => simp
        case some z =>
          have := (g.next_iff_prev.1 h') ▸ (g.next_iff_prev.1 (h' ▸ h))
          have := ih (by simp [this])
          contradiction

theorem Graph.next_limit_exists {α : Type} [DecidableEq α] (g: Graph α) (x: α)
    (no_prev : g.prev x = none) :
    ∃ n, g.next_n n x = none := by
  -- Prove that there exists a pair of indices i₀ ≠ i₁ such that g.next_n i₀ x = g.next_n i₁ x.
  have := g.h_fintype.some
  let c := Fintype.card α
  let ℓ := List.range (c + 2) |>.map (λ n ↦ g.next_n n x)
  have : ¬Function.Injective (λ n ↦ g.next_n n x) := by
    by_contra h'
    have ℓ_nodup : ℓ.Nodup := by
      apply List.Nodup.map h'
      apply List.nodup_range
    have ℓ_card : ℓ.toFinset.card = c + 2 := by
      rw [List.toFinset_card_of_nodup ℓ_nodup]
      simp [ℓ, List.length_map, List.length_range]
    have := Finset.card_le_univ (ℓ.toFinset)
    rw [ℓ_card, Fintype.card_option] at this
    omega

  simp only [Function.Injective, not_forall] at this
  have ⟨i₀, i₁, h, i₀_ne_i₁⟩ := this

  by_cases i₀ < i₁
  case pos =>
    have := Graph.next_n_seq_nodup no_prev i₀ (i₁ - i₀ - 1) (by
      have := calc i₀ + (i₁ - i₀ - 1) + 1
        _ = i₀ + 1 + i₁ - i₀ - 1 := by omega
        _ = i₁ := by omega
      rw [h, this]
    )
    use i₀
  case neg =>
    have : i₁ < i₀ := by omega
    have := Graph.next_n_seq_nodup no_prev i₁ (i₀ - i₁ - 1) (by
      have := calc i₁ + (i₀ - i₁ - 1) + 1
        _ = i₁ + 1 + i₀ - i₁ - 1 := by omega
        _ = i₀ := by omega
      rw [←h, this]
    )
    use i₁

def Graph.next_limit_exists_ne_zero {α : Type} [DecidableEq α] (g: Graph α) (x: α)
    (no_prev : g.prev x = none) :
    Nat.find (g.next_limit_exists x no_prev) ≠ 0 := by
  by_contra h
  have := h ▸ Nat.find_spec (g.next_limit_exists x no_prev)
  rw [Graph.next_n] at this
  contradiction

def Graph.next_limit_n
    {α: Type} [DecidableEq α] (g: Graph α) (x: α) (no_prev : g.prev x = none) : ℕ :=
    match h: Nat.find (g.next_limit_exists x no_prev) with
    | 0 => by
      have := g.next_limit_exists_ne_zero x no_prev
      contradiction
    | n + 1 => n

def Graph.next_limit
    {α: Type} [DecidableEq α] (g: Graph α) (x: α)
    (no_prev : g.prev x = none)
    : α :=
  (g.next_n (g.next_limit_n x no_prev) x).getD x

def Graph.prev_limit
    {α: Type} [DecidableEq α] (g: Graph α) (x: α)
    (no_prev : g.next x = none)
    : α := g.dual.next_limit x no_prev

theorem Graph.next_limit'
    {α: Type} [DecidableEq α] {g: Graph α} {x: α}
    (no_prev : g.prev x = none) :
    g.next (g.next_limit x no_prev) = none ∧
    g.next_n (g.next_limit_n x no_prev) x = some (g.next_limit x no_prev) := by
  set n₀ := Nat.find (g.next_limit_exists x no_prev) with h_n₀
  have h_n₀' : (g.next_limit_n x no_prev) + 1 = n₀ := by
    rw [Graph.next_limit_n]
    split
    case h_1 h =>
      have := g.next_limit_exists_ne_zero x no_prev
      contradiction
    case h_2 n₀' h =>
      exact h.symm

  have := Nat.find_min (g.next_limit_exists x no_prev) (by omega : (g.next_limit_n x no_prev) < n₀)
  have ⟨y, h_y⟩ := Option.ne_none_iff_exists.1 this
  rw [next_limit, ←h_y, Option.getD_some]
  refine ⟨?_, by rfl⟩

  have := Nat.find_spec (g.next_limit_exists x no_prev)
  rw [←h_n₀, ←h_n₀', Graph.next_n_add, ←h_y] at this
  rw [Option.bind_eq_bind, Option.bind_some] at this
  rw [Graph.next_n, Option.bind_eq_bind] at this
  rw [(by rfl : g.next_n 0 = some)] at this
  rw [Option.bind_fun_some] at this
  exact this

theorem Graph.next_limit_of_next_n
    {α: Type} [DecidableEq α] {g: Graph α} {x y: α}
    (no_prev : g.prev x = none) (no_next: g.next y = none) :
    g.next_n n x = some y → g.next_limit x no_prev = y := by
  intro h
  have : g.next_n (n + 1) x = none := by
    rw [Graph.next_n_succ, h, Option.bind_eq_bind, Option.bind_some]
    exact no_next
  have := Nat.find_min' (g.next_limit_exists x no_prev) this
  rw [Graph.next_limit, Graph.next_limit_n]
  split
  case h_1 h' =>
    have := g.next_limit_exists_ne_zero x no_prev
    contradiction
  case h_2 n' h' =>
    suffices n_eq_n' : n = n' from by simp [←n_eq_n', h]
    by_contra ne

    rw [h'] at this
    have : g.next_n (n'.succ) x >>= g.next_n (n - n' - 1) = y := by
      rwa [←Graph.next_n_add, (by omega: (n' + 1) + (n - n' - 1) = n)]

    rw [←h', Nat.find_spec (g.next_limit_exists x no_prev)] at this
    rw [Option.bind_eq_bind, Option.bind_none] at this
    contradiction

theorem Graph.prev_limit_of_prev_n
    {α: Type} [DecidableEq α] {g: Graph α} {x y: α}
    (no_next: g.next x = none) (no_prev: g.prev y = none) :
    g.prev_n n x = some y → g.prev_limit x no_next = y := by
  apply Graph.next_limit_of_next_n (g:=g.dual)
  exact no_prev

theorem Graph.prev_limit_next_limit
    {α: Type} [DecidableEq α] {g: Graph α} {x: α}
    (no_prev : g.prev x = none) :
    g.prev_limit (g.next_limit x no_prev) (g.next_limit' no_prev).1 = x := by
  have := Graph.next_n_iff_prev_n.1 (g.next_limit' no_prev).2
  exact Graph.prev_limit_of_prev_n (g.next_limit' no_prev).1 no_prev this

theorem Graph.next_limit_inj
    {α: Type} [DecidableEq α] {g: Graph α} {x y: α}
    (no_prev_x : g.prev x = none) (no_prev_y : g.prev y = none)
    (eq: g.next_limit x no_prev_x = g.next_limit y no_prev_y) :
    x = y := calc x
  _ = g.prev_limit (g.next_limit x no_prev_x) (g.next_limit' no_prev_x).1 := by rw [g.prev_limit_next_limit]
  _ = g.prev_limit (g.next_limit y no_prev_y) (g.next_limit' no_prev_y).1 := by
    conv => enter [1, 2]; rw [eq]
  _ = y := by rw [g.prev_limit_next_limit no_prev_y]
