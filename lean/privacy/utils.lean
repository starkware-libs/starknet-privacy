import Mathlib.Data.ZMod.Basic

inductive MemoryType where
  | PublicKeys
  | ChannelsJ
  | Channels
  | ChannelHashes
  | SubchannelHashes
  | Tokens
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
  MAX_I₀ : ℕ
  MAX_K₀ : ℕ

def Crypto.pack_nz (crypto: Crypto) {x y: ℕ} (h: x ≠ 0) : crypto.pack x y ≠ 0 := by
  by_contra h'
  apply congrArg crypto.unpack at h'
  rw [crypto.unpack_zero, crypto.unpack_pack] at h'
  exact h (Prod.ext_iff.1 h').1

def note_amount (crypto: Crypto) (m: Memory) (note_id c: ℕ) : ℕ :=
  let w := crypto.unpack (m .Notes [note_id, 0])
  w.2 - (if w.1 = 1 then 0 else crypto.hash [c, w.1])

-----------------
-- List lemmas --
-----------------

-- Partition a list sum by the image of a given function.
theorem fiber_sum
    (α β: Type) [DecidableEq β] (ℓ: List α)
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
