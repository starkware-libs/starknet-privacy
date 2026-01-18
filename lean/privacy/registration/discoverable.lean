import privacy.actions

def scan_users (crypto: Crypto) (events: List Event) : List (ℕ × ℕ) :=
  events |>.filterMap (λ e ↦ match e with
    | .Register addralice kalice_enc => some (addralice, (crypto.dec crypto.council_priv_key kalice_enc).headD 0)
  )

theorem scan_users' {crypto: Crypto} {events: List Event} {addralice kalice: ℕ} :
    (addralice, kalice) ∈ scan_users crypto events ↔
    (∃ kalice_enc,
      .Register addralice kalice_enc ∈ events ∧
      (crypto.dec crypto.council_priv_key kalice_enc).headD 0 = kalice
    ) := by
  constructor
  · intro h
    rw [scan_users, List.mem_filterMap] at h
    have ⟨e, h₀, h₁⟩ := h
    cases e
    case Register addralice' kalice_enc =>
      simp only [Option.some.injEq, Prod.mk.injEq] at h₁
      rw [←h₁.1]
      exact ⟨kalice_enc, h₀, h₁.2⟩
  · intro ⟨kalice_enc, h₀, h₁⟩
    rw [scan_users, List.mem_filterMap]
    use .Register addralice kalice_enc, h₀
    simp only [h₁]

theorem scan_users_private_key {crypto: Crypto} (rm: ReachableMemory crypto) {addralice kalice: ℕ}
    (h: (addralice, kalice) ∈ scan_users crypto rm.events) :
    kalice ∈ crypto.PrivateKeys := by
  replace ⟨kalice_enc, h, h₁⟩ := scan_users'.1 h

  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h

  rw [rm.add_events, List.mem_append] at h
  cases h
  case inl h => exact ih h
  case inr h =>
    cases action
    case Register inp =>
      let info := register_info crypto inp rm success
      rw [run_action, info.events, List.mem_singleton] at h
      simp only [Event.Register.injEq] at h
      convert info.kalice_private_key
      rw [h.2, crypto.h_council_priv_key, crypto.dec_enc, List.headD_cons] at h₁
      simp [h₁]

    all_goals contradiction

theorem register_implies_scan_users
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: RegisterInput}
    (h: .Register inp ∈ rm.actions) :
    (inp.addralice, inp.kalice) ∈ scan_users crypto rm.events := by
  rw [scan_users']

  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h
  rw [rm.add_events]
  rw [ReachableMemory.add] at h
  cases h
  case tail h =>
    have ⟨kalice_enc, h₀, h₁⟩ := ih h
    use kalice_enc
    rw [List.mem_append]
    exact ⟨Or.inl h₀, h₁⟩
  case head =>
    let info := register_info crypto inp rm success
    use crypto.enc crypto.council_pub_key [inp.kalice]
    constructor
    · rw [List.mem_append]
      apply Or.inr
      rw [run_action, info.events, List.mem_singleton, crypto.h_council_priv_key]
    · rw [crypto.h_council_priv_key, crypto.dec_enc, List.headD_cons]
