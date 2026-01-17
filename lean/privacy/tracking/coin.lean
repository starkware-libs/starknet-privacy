import privacy.actions

-- Map from action to optional (token, amount) pair.
private abbrev CollectCoinsFunc := Action → Option (ℕ × ℕ)

def collect_coins (actions: List Action) (f: CollectCoinsFunc) (token: ℕ) : List (Fin actions.length × ℕ) :=
  actions
  |>.mapFinIdx (λ idx action h_idx ↦ ((⟨idx, h_idx⟩: Fin actions.length), action))
  |>.flatMap (λ (idx, action) ↦ (
    f action
    |>.filter (λ (token', _) ↦ token' = token)
    |>.map (λ (_, amount) ↦ (List.range amount).map (λ x ↦ (idx, x)))
    |>.getD []
  ))

theorem collect_coins_length {actions: List Action} {f: CollectCoinsFunc} {token: ℕ} :
    (collect_coins actions f token).length =
    (actions
      |>.filterMap f
      |>.filter (λ (token', _) ↦ token' = token)
      |>.map (λ (_, amount) ↦ amount) |>.sum) := by
  unfold collect_coins
  rw [List.length_flatMap]
  rw [List.map_congr_left (by
    intro ⟨idx, action⟩ h_idx_action
    let g := λ a: Fin actions.length × Action ↦ (f a.2).map (λ val ↦ if val.1= token then val.2 else 0) |>.getD 0
    show _ = g (idx, action)
    simp only [g]
    cases f action
    case none => simp
    case some val =>
      simp [Option.filter_some]
      by_cases h: val.1 = token
      case pos => simp [h]
      case neg => simp [h]
  )]
  rw [map_maxFinIdx]
  rw [mapFinIdx_eq_map (λ action: Action ↦ (f action).map (λ val ↦ if val.1 = token then val.2 else 0) |>.getD 0)]
  simp [filter_map_sum_to_ite, filterMap_map_sum_to_getD]

theorem collect_coins_nodup {actions: List Action} {f: CollectCoinsFunc} {token: ℕ} :
    (collect_coins actions f token).Nodup := by
  apply mapFinIdx_flatMap_Nodup (j := λ (idx, x) ↦ idx)
  case g_nodup =>
    intro ⟨idx, action⟩
    simp only
    cases f action
    case some val =>
      by_cases h: val.1 = token
      case pos =>
        simp [Option.filter_some, h]
        apply List.Nodup.map
        · intro a b hab
          simp only [Prod.mk.injEq] at hab
          exact hab.2
        · exact List.nodup_range
      case neg => simp [Option.filter_some, h]
    case none => simp

  case h_j =>
    intro i action h_idx res h_res
    simp only at h_res
    cases h_f: f action
    case some val =>
      rw [h_f] at h_res
      by_cases h: val.1 = token
      case pos =>
        simp only [Option.filter_some, h, decide_true, ↓reduceIte, Option.map_some,
          Option.getD_some, List.mem_map, List.mem_range] at h_res
        have ⟨_, _, h_res⟩ := h_res
        rw [←h_res]
      case neg => simp [Option.filter_some, h] at h_res
    case none => simp [h_f] at h_res
