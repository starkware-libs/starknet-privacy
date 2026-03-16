import Mathlib.Data.ZMod.Basic

inductive MemoryType where
  | PublicKeys
  | ChannelsJ
  | Channels
  | ChannelMarkers
  | OutgoingChannels
  | SubchannelMarkers
  | SubchannelTokens
  | Notes
  | Nullifiers
  | OpenNoteToken
  deriving DecidableEq

abbrev Memory := MemoryType → List ℕ → ℕ

def write (t: MemoryType) (x: List ℕ) (y: ℕ) (m: Memory) : Memory :=
  λ t' x' ↦ if (t', x') = (t, x) then y else m t' x'

@[simp]
theorem write_eq (t: MemoryType) (x: List ℕ) (y: ℕ) (m: Memory) :
  write t x y m t x = y := by unfold write; simp

@[simp]
theorem write_ne {t t': MemoryType} {x x': List ℕ} (h: (t, x) ≠ (t', x')) (m: Memory) :
  write t' x' y m t x = m t x := by simp [write, h]

structure Crypto where
  hash: List ℕ → ℕ
  h_hash: ∀ {ℓ₁ ℓ₂}, hash ℓ₁ = hash ℓ₂ → ℓ₁ = ℓ₂
  PrivateKeys: Finset ℕ
  priv_to_pub: ℕ → ℕ
  enc: ℕ → List ℕ → ℕ
  enc_is_not_zero: ∀ x ℓ, enc x ℓ ≠ 0
  dec: ℕ → ℕ → List ℕ
  dec_enc: ∀ (k: PrivateKeys) ℓ, dec k (enc (priv_to_pub k) ℓ) = ℓ
  priv_to_pub_inj: ∀ {k₁ k₂: ℕ}, k₁ ∈ PrivateKeys → k₂ ∈ PrivateKeys → priv_to_pub k₁ = priv_to_pub k₂ → k₁ = k₂
  zero_not_public_key: ∀ x: PrivateKeys, priv_to_pub x ≠ 0
  pack: ℕ → ℕ → ℕ
  unpack: ℕ → ℕ × ℕ
  unpack_pack: ∀ x y, unpack (pack x y) = (x, y)
  unpack_zero: unpack 0 = (0, 0)
  council_priv_key: PrivateKeys
  council_pub_key: ℕ
  h_council_priv_key: council_pub_key = priv_to_pub council_priv_key

def Crypto.pack_nz (crypto: Crypto) {x y: ℕ} (h: x ≠ 0) : crypto.pack x y ≠ 0 := by
  by_contra h'
  apply congrArg crypto.unpack at h'
  rw [crypto.unpack_zero, crypto.unpack_pack] at h'
  exact h (Prod.ext_iff.1 h').1

def note_amount (crypto: Crypto) (m: Memory) (note_id c token i: ℕ) : ℕ :=
  let w := crypto.unpack (m .Notes [note_id, 0])
  w.2 - (if w.1 = 1 then 0 else crypto.hash [c, token, i, w.1])

-----------------
-- List lemmas --
-----------------

-- Partition a list sum by the image of a given function.
theorem fiber_sum
    {α β: Type} [DecidableEq β] (ℓ: List α)
    (img: List β) (f: α → β)
    (h_img: ∀ a ∈ ℓ, f a ∈ img)
    (h_nodup: img.Nodup)
    (g: α → ℕ) :
    (ℓ.map g |>.sum) = (
      img |>.map (
        λ b: β ↦ ℓ.filter (λ a: α ↦ f a = b) |>.map g |>.sum
      ) |>.sum
    ) := by
  induction ℓ
  case nil => simp
  case cons x xs ih =>
    rw [List.map_cons, List.sum_cons]
    conv =>
      rhs
      rw [List.map_congr_left (by
        intro b hb
        show _ = (if b = f x then g x else 0) + (xs |>.filter (λ a ↦ f a = b) |>.map g |>.sum)
        rw [List.filter_cons]
        by_cases h: b = f x
        case pos => simp [h]
        case neg => simp [h, Ne.symm h]
      )]

    simp only [List.mem_cons, forall_eq_or_imp] at h_img
    simp only [List.sum_map_add, ih h_img.2, Nat.add_right_cancel_iff]

    have : (List.filter (fun b => decide (b = f x)) img).length = 1 := by
      rw [List.filter_eq, List.length_replicate]
      rw [List.nodup_iff_count_eq_one.1 h_nodup]
      exact h_img.1

    simp [List.sum_map_ite, this]

-- If `x ∈ ℓ` is the only element satisfying the predicate `p`, then `ℓ.find? p = some x`.
theorem find?_eq_some
    {α: Type} {ℓ: List α} {p: α → Bool} {x: α}
    (h_x_in_ℓ: x ∈ ℓ) (h_p_x: p x)
    (h_inj: ∀ y ∈ ℓ, p y → x = y) :
    ℓ.find? p = some x := by
  cases h_y: ℓ.find? p
  case none =>
    exfalso
    rw [List.find?_eq_none] at h_y
    exact h_y x h_x_in_ℓ h_p_x
  case some y =>
    rw [List.find?_eq_some_iff_append] at h_y
    have ⟨h_p_y, _, _, h⟩ := h_y
    rw [h_inj y (by simp [h]) h_p_y]

theorem filter_map_nodup (α β: Type) [DecidableEq β] (ℓ: List α) (f: α → Bool) (m: α → β)
    (h_nodup: ℓ |>.map m |>.Nodup) :
    ℓ |>.filter f |>.map m |>.Nodup := by
  apply List.nodup_iff_count_le_one.2
  intro x
  simp only [List.count, List.countP_map, List.countP_filter]
  apply List.nodup_iff_count_le_one.1 at h_nodup
  replace h_nodup := h_nodup x
  simp only [List.count, List.countP_map] at h_nodup
  apply Nat.le_trans _ h_nodup
  apply List.countP_mono_left
  intro x' x'_in_ℓ h
  simp at h
  simp [h]

theorem map_maxFinIdx {α β γ: Type} {ℓ: List α} (f: (i: ℕ) → α → (i < ℓ.length) → β) (g: β → γ) :
    (ℓ |>.mapFinIdx f |>.map g) = (ℓ |>.mapFinIdx (λ idx x h_idx ↦ g (f idx x h_idx))) := by
  induction ℓ
  case nil => simp
  case cons x xs ih => simp [ih]

theorem mapIdx_eq_map {α β: Type} {ℓ: List α} (f:  α → β) :
    (ℓ |>.mapIdx (λ _ x ↦ f x)) = (ℓ |>.map f) := by
  induction ℓ
  case nil => simp
  case cons x xs ih => simp [ih]

theorem mapFinIdx_eq_map {α β: Type} {ℓ: List α} (f:  α → β) :
    (ℓ |>.mapFinIdx (λ _ x _ ↦ f x)) = (ℓ |>.map f) := by
  simp only [List.mapFinIdx_eq_mapIdx, mapIdx_eq_map]

theorem filter_map_sum_to_ite {α: Type} {ℓ: List α} (f: α → Bool) (g: α → ℕ) :
    (ℓ |>.filter f |>.map g |>.sum) =
    (ℓ |>.map (λ x ↦ if f x then g x else 0) |>.sum) := by
  induction ℓ
  case nil => simp
  case cons x xs ih =>
    rw [List.filter_cons, List.map_cons]
    by_cases h: f x
    case pos => simp [h, ih]
    case neg => simp [h, ih]

theorem filterMap_map_sum_to_getD {α β: Type} {ℓ: List α} (f: α → Option β) (g: β → ℕ) :
    (ℓ |>.filterMap f |>.map g |>.sum) =
    (ℓ |>.map (λ x ↦ (f x).map g |>.getD 0) |>.sum) := by
  induction ℓ
  case nil => simp
  case cons x xs ih =>
    rw [List.filterMap_cons, List.map_cons]
    cases f x
    case none => simp [ih]
    case some y => simp [ih]

def list_to_fin_equiv
    {α: Type} [DecidableEq α]
    (ℓ: List α)
    (h_nodup: ℓ.Nodup) :
    ℓ.toFinset ≃ Fin ℓ.length := by
  constructor
  case toFun =>
    intro ⟨x, h_x⟩
    simp only [List.mem_toFinset] at h_x
    let i := List.idxOf x ℓ
    exact ⟨i, List.idxOf_lt_length_iff.2 h_x⟩
  case invFun =>
    intro ⟨i, h_i⟩
    let val := ℓ.get ⟨i, by simp [h_i]⟩
    exact ⟨val, by simp [val]⟩
  case left_inv =>
    intro ⟨x, h_x⟩
    simp
  case right_inv =>
    intro ⟨i, h_i⟩
    simp only [List.get_eq_getElem, Fin.mk.injEq]
    apply List.Nodup.idxOf_getElem h_nodup

def two_lists_equiv
    {α: Type} [DecidableEq α] [DecidableEq β]
    (ℓ₀: List α) (ℓ₁: List β)
    (h: ℓ₀.length = ℓ₁.length)
    (h_nodup₀: ℓ₀.Nodup)
    (h_nodup₁: ℓ₁.Nodup) :
    ℓ₀.toFinset ≃ ℓ₁.toFinset :=
  (list_to_fin_equiv ℓ₀ h_nodup₀).trans (h ▸ (list_to_fin_equiv ℓ₁ h_nodup₁).symm)

theorem mapFinIdx_flatMap_Nodup
    {α β γ: Type} [DecidableEq γ]
    (ℓ: List α)
    (f: (i: ℕ) → α → (i < ℓ.length) → β)
    (g: β → List γ)
    (g_nodup: ∀ b: β, (g b).Nodup)
    (j: γ → ℕ)
    (h_j: ∀ i x y, ∀ res ∈ g (f i x y), j res = i)
    : ℓ |>.mapFinIdx f |>.flatMap g |>.Nodup := by
  induction ℓ using List.reverseRecOn
  case nil => simp
  case append_singleton xs x ih =>
    rw [List.mapFinIdx_append, List.flatMap_append]
    apply List.Nodup.append
    · exact ih
        (λ i a h => f i a (by simp; omega))
        (λ i x y res h_res => h_j i x (by simp; omega) res h_res)
    · rw [List.mapFinIdx_singleton, List.flatMap_singleton]
      apply g_nodup
    · intro v h₀ h₁
      simp only [List.mapFinIdx_singleton, List.flatMap_singleton, zero_add] at h₁
      have h_j_v := h_j xs.length x (by simp) v h₁

      rw [List.mem_flatMap] at h₀
      have ⟨y, h_y, h₀⟩ := h₀
      rw [List.mem_mapFinIdx] at h_y
      have ⟨i, h_i, h_f⟩ := h_y

      rw [←h_f] at h₀
      have := h_j i xs[i] (by simp; omega) v h₀
      omega

def partial_equiv
    {α: Type} [DecidableEq α] [DecidableEq β]
    {ℓ₀: List α} {ℓ₁: List β}
    (e: ℓ₀.toFinset ≃ ℓ₁.toFinset)
    (x: α) : Option β :=
  if h: x ∈ ℓ₀.toFinset then some (e ⟨x, h⟩).val else none

theorem partial_equiv_eq
    {α: Type} [DecidableEq α] [DecidableEq β]
    {ℓ₀: List α} {ℓ₁: List β}
    (e: ℓ₀.toFinset ≃ ℓ₁.toFinset)
    (x: α) (h_x: x ∈ ℓ₀) :
    partial_equiv e x = some (e ⟨x, by simp [h_x]⟩) := by
  simp [partial_equiv, h_x]

theorem partial_equiv_prop
    {α: Type} [DecidableEq α] [DecidableEq β]
    {ℓ₀: List α} {ℓ₁: List β}
    (e: ℓ₀.toFinset ≃ ℓ₁.toFinset)
    (x: α) (h_x: x ∈ ℓ₀) :
    ∃ y: β, partial_equiv e x = some y ∧ y ∈ ℓ₁ := by
  simp only [partial_equiv, List.mem_toFinset, Option.dite_none_right_eq_some, Option.some.injEq,
    exists_exists_eq_and]
  have := (e ⟨x, by simp [h_x]⟩).prop
  rw [List.mem_toFinset] at this
  exact ⟨h_x, this⟩

theorem partial_equiv_inv_helper
    {α: Type} [DecidableEq α] [DecidableEq β]
    {ℓ₀: List α} {ℓ₁: List β}
    (e: ℓ₀.toFinset ≃ ℓ₁.toFinset)
    (x: α) (y: β) :
    partial_equiv e x = some y → partial_equiv e.symm y = some x := by
  intro h
  by_cases h_x_ℓ₀: x ∈ ℓ₀
  case pos =>
    set a := e ⟨x, by simp [h_x_ℓ₀]⟩ with h_a
    rw [Equiv.apply_eq_iff_eq_symm_apply e] at h_a
    simp only [partial_equiv, List.mem_toFinset, h_x_ℓ₀, ↓reduceDIte, Option.some.injEq] at h
    have : y ∈ ℓ₁ := by
      have := a.prop
      simp [a, h] at this
      exact this
    rw [partial_equiv_eq e.symm y this]
    simp [←h, ←h_a]
  case neg =>
    simp [partial_equiv, List.mem_toFinset, h_x_ℓ₀] at h

theorem partial_equiv_inv
    {α: Type} [DecidableEq α] [DecidableEq β]
    {ℓ₀: List α} {ℓ₁: List β}
    (e: ℓ₀.toFinset ≃ ℓ₁.toFinset)
    (x: α) (y: β) :
    partial_equiv e x = some y ↔ partial_equiv e.symm y = some x := by
  exact ⟨partial_equiv_inv_helper e x y, partial_equiv_inv_helper e.symm y x⟩

theorem partial_equiv_from_some
    {α: Type} [DecidableEq α] [DecidableEq β]
    {ℓ₀: List α} {ℓ₁: List β}
    {e: ℓ₀.toFinset ≃ ℓ₁.toFinset}
    {x: α} {y: β}
    (h: partial_equiv e x = some y) :
    x ∈ ℓ₀ ∧ y ∈ ℓ₁ := by
  by_cases h_x_ℓ₀: x ∈ ℓ₀
  case pos =>
    have := (e ⟨x, by simp [h_x_ℓ₀]⟩).prop
    simp only [List.mem_toFinset] at this
    simp only [partial_equiv, List.mem_toFinset, h_x_ℓ₀, reduceDIte, Option.some.injEq] at h
    rw [←h]
    exact ⟨h_x_ℓ₀, this⟩
  case neg =>
    simp [partial_equiv, List.mem_toFinset, h_x_ℓ₀] at h

theorem mapIdx_filter_map
    {α β γ: Type} {ℓ: List α}
    (f: ℕ → α → β)
    (p: β → Bool)
    (q: β → γ)
    (h_p: ∀ idx₀ idx₁ x, p (f idx₀ x) ↔ p (f idx₁ x))
    (h_q: ∀ idx₀ idx₁ x, q (f idx₀ x) = q (f idx₁ x)) :
    (ℓ |>.mapIdx f |>.filter p |>.map q) =
    (ℓ |>.map (f 0) |>.filter p |>.map q) := by
  induction ℓ using List.reverseRecOn
  case nil => simp
  case append_singleton x xs ih =>
    simp only [List.mapIdx_concat, List.filter_append, List.map_append, ih, List.map_cons,
      List.map_nil, List.append_cancel_left_eq]
    by_cases p (f x.length xs)
    case pos h =>
      simp [h, (h_p _ _ _).1 h]
      apply h_q
    case neg h =>
      simp [h]
      rw [←h_p 0 _ _] at h
      simp [h]

theorem mem_mapIdx' {α β: Type} {f: ℕ → α → β} {ℓ: List α} {x: β}
    (h_mem: x ∈ ℓ.mapIdx f) :
    ∃ (i: ℕ) (y: α), y ∈ ℓ ∧ x = f i y := by
  rw [List.mem_mapIdx] at h_mem
  have ⟨i, _, h_x⟩ := h_mem
  exact ⟨i, ℓ[i], by simp [h_x]⟩
