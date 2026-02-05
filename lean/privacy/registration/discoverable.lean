import privacy.actions
import privacy.registration.registration

def scan_users (crypto: Crypto) (events: List Event) : List (ℕ × ℕ) :=
  events |>.filterMap (λ e ↦ match e with
    | .Register addralice kalice_enc => some (addralice, (crypto.dec crypto.council_priv_key kalice_enc).headD 0)
    | _ => none
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
    all_goals simp at h₁
  · intro ⟨kalice_enc, h₀, h₁⟩
    rw [scan_users, List.mem_filterMap]
    use .Register addralice kalice_enc, h₀
    simp only [h₁]

theorem RegisterImplies.from_scan {crypto: Crypto} {rm: ReachableMemory crypto} {addralice kalice: ℕ}
    (h: (addralice, kalice) ∈ scan_users crypto rm.events) :
    RegisterImplies rm ⟨addralice, kalice⟩ := by
  replace ⟨kalice_enc, h, h₁⟩ := scan_users'.1 h

  revert rm
  apply ReachableMemory.induction
  case inv₀ => intro h; contradiction

  intro action rm ih success h

  rw [rm.add_events, List.mem_append] at h
  cases h
  case inl h => exact (ih h).next success
  case inr h =>
    cases action
    case Register inp =>
      apply RegisterImplies.from_action
      rw [ReachableMemory.add, List.mem_cons]
      apply Or.inl

      let info := register_info crypto inp rm success
      rw [run_action, info.events, List.mem_singleton] at h
      simp only [Event.Register.injEq] at h

      have h_kalice : kalice = inp.kalice := by
        simp only [h.2, crypto.h_council_priv_key, crypto.dec_enc, List.headD_eq_head?_getD,
          List.head?_cons, Option.getD_some] at h₁
        exact h₁.symm

      simp [h, h_kalice]

    case CreateNote inp =>
      by_cases h_r: inp.r = 1 <;> simp [run_action, get_events, create_note, h_r] at h

    all_goals contradiction

theorem RegisterImplies.scan
    {crypto: Crypto} {rm: ReachableMemory crypto} {inp: RegisterInput}
    (register_imp: RegisterImplies rm inp) :
    (inp.addralice, inp.kalice) ∈ scan_users crypto rm.events := by
  revert register_imp
  suffices h: .Register inp ∈ rm.actions → (inp.addralice, inp.kalice) ∈ scan_users crypto rm.events from
    λ h' ↦ h h'.h_action

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

def get_priv_key (crypto: Crypto) (events: List Event) (addralice: ℕ) : ℕ :=
  scan_users crypto events
      |>.find? (λ (addralice', _) ↦ addralice' = addralice)
      |>.map (λ (_, kalice) ↦ kalice)
      |>.getD 0

theorem RegisterImplies.for_get_priv_key
    {crypto: Crypto} (rm: ReachableMemory crypto) (addralice: ℕ)
    (h_public_keys: rm.m .PublicKeys [addralice] ≠ 0) :
    RegisterImplies rm ⟨addralice, get_priv_key crypto rm.events addralice⟩ := by
  have ⟨kalice, register_imp⟩ := RegisterImplies.from_public_key h_public_keys
  have h_not_none : ¬(scan_users crypto rm.events).find? (λ (addralice', _) ↦ addralice' = addralice) = none := by
    rw [List.find?_eq_none, not_forall]
    use ⟨addralice, ↑kalice⟩
    simp only [decide_true, not_true_eq_false, imp_false, Decidable.not_not]
    apply register_imp.scan

  have : (scan_users crypto rm.events).find? (λ (addralice', _) ↦ addralice' = addralice) =
      some (addralice, ↑kalice) := by
    have ⟨⟨addralice', kalice'⟩, h⟩ := (Option.ne_none_iff_exists'.1 h_not_none)
    replace ⟨h₀, ⟨as, bs, h₁, _⟩⟩ := List.find?_eq_some_iff_append.1 h
    have h_addralice : addralice' = addralice := by
      simp only [decide_eq_true_eq] at h₀
      exact h₀
    have : (addralice', kalice') ∈ scan_users crypto rm.events := by simp [h₁]
    have register_imp' := RegisterImplies.from_scan this
    have h_kalice: kalice' = kalice := by
      apply crypto.priv_to_pub_inj register_imp'.h_kalice (by simp)
      rw [←register_imp.public_key, ←register_imp'.public_key, h_addralice]
    rw [h, h_addralice, h_kalice]

  have : get_priv_key crypto rm.events addralice = ↑kalice := by
    rw [get_priv_key, this, Option.map_some]
    rfl

  exact this ▸ register_imp
