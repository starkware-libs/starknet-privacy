import privacy.actions
import privacy.notes.scanned_note
import privacy.compliance.all_notes

-- Given a list and a function that maps each element to an amount,
-- returns a list of pairs (x, i) where x ∈ ℓ and i ∈ [0, f x).
def amounts_to_coins
    {α: Type} (ℓ: List α) (f: α → ℕ) : List (α × ℕ) :=
  ℓ.flatMap (λ x ↦ (List.range (f x)).map (λ i ↦ (x, i)))

theorem amounts_to_coins.mem
    {α: Type} (ℓ: List α) (f: α → ℕ) (x: α) (i: ℕ) :
    ((x, i) ∈ amounts_to_coins ℓ f) ↔ (x ∈ ℓ ∧ i < f x) := by
  simp [amounts_to_coins]

theorem amounts_to_coins.length
    {α: Type} (ℓ: List α) (f: α → ℕ) :
    (amounts_to_coins ℓ f).length = (ℓ |>.map f |>.sum) := by
  rw [amounts_to_coins, List.length_flatMap]
  apply congrArg
  apply List.map_congr_left
  intro x h_x
  rw [List.length_map, List.length_range]

theorem amounts_to_coins.nodup
    {α: Type} {ℓ: List α} (f: α → ℕ) (h_nodup: ℓ.Nodup) :
    (amounts_to_coins ℓ f).Nodup := by
  rw [amounts_to_coins, List.nodup_flatMap]
  constructor
  · intro x h_x
    apply List.Nodup.map
    · intro a b h; simp only [Prod.mk.injEq, true_and] at h; exact h
    · exact List.nodup_range
  · rw [List.pairwise_iff_get]
    intro i j i_lt_j ⟨x, k⟩ h₀ h₁
    rw [List.mem_map] at h₀ h₁
    have ⟨_, _, h₀⟩ := h₀; rw [Prod.mk.injEq] at h₀
    have ⟨_, _, h₁⟩ := h₁; rw [Prod.mk.injEq] at h₁
    have := List.nodup_iff_injective_get.1 h_nodup (h₁.1 ▸ h₀.1)
    omega

def amounts_to_coins.equiv
    {α β: Type} [DecidableEq α] [DecidableEq β] (ℓ₀: List α) (ℓ₁: List β) (h_nodup₀: ℓ₀.Nodup) (h_nodup₁: ℓ₁.Nodup)
    (f: α → ℕ) (g: β → ℕ)
    (h_sum: (ℓ₀.map f).sum = (ℓ₁.map g).sum) :
    (amounts_to_coins ℓ₀ f).toFinset ≃ (amounts_to_coins ℓ₁ g).toFinset := by
  apply two_lists_equiv
  case h => simp [amounts_to_coins.length, h_sum]
  case h_nodup₀ => exact amounts_to_coins.nodup _ h_nodup₀
  case h_nodup₁ => exact amounts_to_coins.nodup _ h_nodup₁

structure Coin (crypto: Crypto) (m: Memory) where
  esn: ExScannedNote
  coin_idx: ℕ
  h_coin_idx: coin_idx < esn.amount crypto m
  h_c: ∃ (kalice Kbob: ℕ), esn.c = crypto.hash [esn.addralice, kalice, esn.addrbob, Kbob]
deriving DecidableEq

@[ext] theorem Coin.ext {crypto: Crypto} {m: Memory} {coin₁ coin₂: Coin crypto m}
    (h_sn: coin₁.esn = coin₂.esn)
    (h_coin_idx: coin₁.coin_idx = coin₂.coin_idx) :
    coin₁ = coin₂ := by
  cases coin₁; cases coin₂; simp at *; simp [*]

abbrev Coin.note_id {crypto: Crypto} {m: Memory} (coin: Coin crypto m) : ℕ :=
  coin.esn.note_id crypto

abbrev Coin.note_start {crypto: Crypto} {m: Memory} (coin: Coin crypto m) : Coin crypto m :=
   ⟨coin.esn, 0, Nat.lt_of_le_of_lt (by simp) coin.h_coin_idx, coin.h_c⟩

theorem NoteImplies.from_coin {crypto: Crypto} {rm: ReachableMemory crypto} (coin: Coin crypto rm) :
    ∃ (inp: CreateNoteInput) (_: NoteImplies rm inp), inp.note_id crypto = coin.note_id :=
  NoteImplies.from_amount_nz (Nat.ne_zero_of_lt coin.h_coin_idx)

noncomputable def Coin.fintype {crypto: Crypto} {rm: ReachableMemory crypto} : Fintype (Coin crypto rm) := by
  let notes := { c: Coin crypto rm | c.coin_idx = 0 }
  have : Fintype notes := by
    let f : (scan_all_notes (.from rm) |>.filter (λ esn ↦ esn.amount crypto rm > 0)).toFinset → notes := by
      intro esn
      have := esn.prop
      rw [List.mem_toFinset, List.mem_filter, decide_eq_true_eq] at this
      refine ⟨⟨esn.val, 0, this.2, ?_⟩, by rfl⟩
      have ⟨inp, note_imp, h_esn, h_addralice, h_addrbob⟩ := NoteImplies.from_scan_all_notes this.1
      use inp.kalice, inp.Kbob
      rw [←h_addralice, ←h_addrbob, ←h_esn]
    apply Fintype.ofSurjective f
    intro note
    have ⟨inp, note_imp, h_note_id⟩ := NoteImplies.from_coin note.val

    use ⟨inp.to_ex_scanned_note crypto, by
      rw [List.mem_toFinset, List.mem_filter, decide_eq_true_eq]
      refine ⟨note_imp.in_scan_all_notes, ?_⟩
      have := CreateNoteInput.to_scanned_note_eq h_note_id
      have := this ▸ (Set.mem_setOf_eq ▸ note.prop) ▸ note.val.h_coin_idx
      exact this
    ⟩
    simp only [f]
    apply Subtype.ext_iff.2
    apply Coin.ext
    case h_sn =>
      have ⟨kalice, Kbob, h_c⟩ := note.val.h_c
      have := congrArg ScannedNote.c (inp.to_scanned_note_eq h_note_id)
      simp only at this
      rw [note_imp.subchannel.h_c, h_c] at this
      have := note_imp.subchannel.channel.same_c this
      simp only at this
      exact ExScannedNote.ext (inp.to_scanned_note_eq h_note_id) this.1.symm this.2.2.1.symm
    case h_coin_idx =>
      simp only
      have := note.prop
      rw [Set.mem_setOf_eq] at this
      rw [this]

  by_cases is_empty: Nonempty (Coin crypto rm)
  case neg =>
    have := not_nonempty_iff.1 is_empty
    exact Fintype.ofIsEmpty

  let max_amount :=
    notes.toFinset
    |>.image (λ coin: Coin crypto rm ↦ coin.esn.amount crypto rm)
    |>.max' (by
      simp only [Finset.image_nonempty, Set.toFinset_nonempty]
      exact Set.nonempty_of_mem (x:=is_empty.some.note_start) (by rfl)
    )

  let to_note_start : Coin crypto rm → notes :=
    λ coin ↦ ⟨coin.note_start, by simp only [Set.mem_setOf_eq, notes]⟩

  let to_idx : Coin crypto rm → Fin max_amount :=
    λ coin ↦ ⟨coin.coin_idx, by
      apply Nat.lt_of_lt_of_le coin.h_coin_idx
      apply Finset.le_max'
      rw [Finset.mem_image]
      refine ⟨coin.note_start, ?_, by rfl⟩
      simp only [Set.mem_toFinset, Set.mem_setOf_eq, notes]
    ⟩

  apply Fintype.ofInjective
    (λ coin ↦ (to_note_start coin, to_idx coin))

  intro coin₁ coin₂ h
  simp only [Prod.mk.injEq, to_note_start, to_idx] at h
  apply Coin.ext
  · have := Subtype.ext_iff.1 h.1
    simp only [note_start, mk.injEq, and_true] at this
    exact this
  · exact Fin.ext_iff.1 h.2
