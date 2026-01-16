import privacy.actions
import privacy.amounts
import privacy.compliance.all_notes
import privacy.notes.canceled_notes
import privacy.registration.discoverable
import privacy.transactions.transactions
import privacy.tracking.utils

theorem outgoing_notes₀
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (addralice: ℕ) (token: ℕ) :
    (
      create_note_actions crypto stxs.rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = addralice)
      |>.map (λ inp ↦ inp.amount)
      |>.sum
    ) = (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = addralice)
      |>.map (λ tx ↦ tx.sum_create_note_amounts token)
      |>.sum
    ) := by
  rw [←filtered_note_actions_to_tx_actions]
  unfold create_note_actions ActionFunc.create ActionFuncRes.from_create
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_action
  cases h_some: filter_CreateNote action
  case none => simp
  case some inp => simp [Option.filter_some]

theorem outgoing_notes₁
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (addralice: ℕ) (token: ℕ) :
    let kalices : List ℕ :=
      scan_users crypto stxs.rm.events
      |>.filter (λ user ↦ user.1 = addralice)
      |>.map (λ user ↦ user.2)
      |>.dedup
    (
      create_note_actions crypto stxs.rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = addralice)
      |>.map (λ inp ↦ inp.amount)
      |>.sum
    ) =
    (
      kalices
      |>.map (λ kalice ↦
        create_note_actions crypto stxs.rm
        |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = addralice ∧ inp.kalice = kalice)
        |>.map (λ inp ↦ inp.amount)
        |>.sum
      )
      |>.sum
    ) := by
  intro kalices
  rw [fiber_sum
    (img:=kalices)
    (f:=λ inp ↦ inp.kalice)
    (h_img := by
      intro inp h_inp
      rw [List.mem_filter] at h_inp
      simp only [kalices, List.mem_dedup, List.mem_map, List.mem_filter]
      use ⟨inp.addralice, inp.kalice⟩
      refine ⟨⟨?_, ?_⟩, by rfl⟩
      . have ⟨note_imp⟩ := NoteImplies.from_create_note_actions h_inp.1
        rw [note_imp.h_kalice]
        exact note_imp.subchannel.channel.alice_registered.scan
      · simp only [Bool.decide_and, Bool.and_eq_true, decide_eq_true_eq] at h_inp
        simp [h_inp]
    )
    (h_nodup:=by apply List.nodup_dedup)
  ]

  simp only [←List.filterMap_eq_map, ←List.filterMap_eq_filter, List.filterMap_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro kalice h_kalice
  simp only [Function.comp_apply, Option.some.injEq, Option.guard]
  apply congrArg
  apply List.filterMap_congr
  intro inp h_inp
  by_cases h: inp.token = token ∧ inp.addralice = addralice
  case pos =>
    by_cases h': inp.kalice = kalice
    case pos => simp [h, h']
    case neg => simp [decide_eq_true h, h']
  case neg => simp [←and_assoc, h]

theorem outgoing_notes
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (addralice: ℕ) (token: ℕ) :
    (
      scan_users crypto stxs.rm.events
      |>.filter (λ user ↦ user.1 = addralice)
      |>.map (λ user ↦ user.2)
      |>.dedup
      |>.map (λ kalice ↦
        create_note_actions crypto stxs.rm
          |>.filter (λ inp ↦ inp.token = token ∧ inp.addralice = addralice ∧ inp.kalice = kalice)
          |>.map (λ inp ↦ inp.amount)
          |>.sum
      )
      |>.sum
    )= (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = addralice)
      |>.map (λ tx ↦ tx.sum_create_note_amounts token)
      |>.sum
    ) := by
  rw [←outgoing_notes₀, ←outgoing_notes₁]
