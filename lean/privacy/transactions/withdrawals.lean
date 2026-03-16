import privacy.transactions.use_note

structure WithdrawalEvent where
  (user_enc: ℕ) (addr: ℕ) (amount: ℕ) (token: ℕ) (idx: ℕ)
deriving DecidableEq

def withdrawals_for_user
    {crypto: Crypto} {m: Memory}
    (context: ScanNoteContext crypto m)
    (events: List (List Event))
    (user: UserPrivKey crypto m) : List WithdrawalEvent :=
  let user_txs: List Bool := has_use_note_event events (nullifiers_for_user context user)
  (events.zip user_txs).flatMap (λ (tx_events, is_user_tx) ↦
    if is_user_tx then
      tx_events.filterMap (λ event ↦
        match event with
        | .Withdraw user_enc amount token => some (user_enc, amount, token)
        | _ => none
      )
    else
      []
  )
  |>.mapIdx (λ idx (user_enc, amount, token) ↦ ⟨user_enc, user.addr, amount, token, idx⟩)

theorem withdrawals_for_user.eq
    (stxs: SuccessfulTransactions crypto)
    (user: UserPrivKey crypto stxs.rm) :
    withdrawals_for_user (.from stxs.rm) stxs.events user = (
      stxs.txs.reverse.flatMap (λ tx ↦
        if tx.owner = user.addr then
          tx.actions.reverse.filterMap (λ action ↦
            match action with
            | .Withdraw inp => some (inp.user_enc crypto, inp.amount, inp.token)
            | _ => none
          )
        else
          []
      )
      |>.mapIdx (λ idx (user_enc, amount, token) ↦ ⟨user_enc, user.addr, amount, token, idx⟩)
    ) := by
  unfold withdrawals_for_user
  apply congrArg₂ _ _ (by rfl)
  rw [has_use_note_event.for_nullifiers_for_user]

  generalize user.addr = addr
  clear user
  revert stxs
  apply SuccessfulTransactions.induction

  case empty => trivial
  case succ =>
    intro h ih
    conv =>
      congr
      · simp only
        rw [h.h_txs, h.h_events, List.reverse_cons, List.map_append]
        rw [List.zip_append (by rw [SuccessfulTransactions.events.length, List.length_map, List.length_reverse])]
        rw [List.flatMap_append]
      · rw [h.h_txs, List.reverse_cons, List.flatMap_append]
    apply congrArg₂
    · rw [ih]
    · clear ih
      simp only [List.flatMap_singleton, List.map_singleton, List.zip_cons_cons, List.zip_nil_left]
      by_cases h_owner: h.tx.owner = addr
      case neg => simp [h_owner]
      case pos =>
        simp only [h_owner]
        set evts_of_tx: List (ℕ × ℕ × ℕ) := h.tx.actions.reverse.filterMap (λ action ↦
          match action with
          | Action.Withdraw inp => some (inp.user_enc crypto, inp.amount, inp.token)
          | _ => none
        )
        set evts_of_events: List (ℕ × ℕ × ℕ) := (
          run_all crypto h.tx.actions h.stxs₀.m).events.filterMap (λ event ↦
            match event with
            | Event.Withdraw user_enc amount token => some (user_enc, amount, token)
            | _ => none
          )

        have h_evts : evts_of_tx = evts_of_events := by
          unfold evts_of_events evts_of_tx
          generalize h_actions: h.tx.actions = actions
          replace h_actions : ∀ action ∈ actions, action ∈ h.tx.actions := by simp [←h_actions]
          induction actions
          case nil => trivial
          case cons action actions ih =>
            simp only [List.mem_cons, forall_eq_or_imp] at h_actions
            conv =>
              congr
              · rw [←List.singleton_append, List.reverse_append, List.filterMap_append, ih h_actions.2]
              · rw [run_all_cons_events, List.filterMap_append]
            apply congrArg
            rw [List.reverse_singleton, List.filterMap_cons, List.filterMap_nil]
            simp only [run_action, get_events, run_action₀]

            cases action
            case Withdraw inp => simp [withdraw]
            case Register inp => simp [register]
            case CreateNote inp => simp [create_note]; by_cases h_r: inp.r = 1 <;> simp [h_r]
            case UseNote inp => simp [use_note]
            case OpenDeposit inp => simp [open_deposit]
            case OpenChannel inp => simp [open_channel]
            case OpenSubchannel inp => simp [open_subchannel]

        rw [←h_evts]
        by_cases h_no_withdrawals: evts_of_tx = []
        case neg =>
          have h_withdrawal := List.head_mem h_no_withdrawals
          simp only [evts_of_tx, List.mem_filterMap] at h_withdrawal
          obtain ⟨action, h_action, h_withdrawal⟩ := h_withdrawal
          rw [List.mem_reverse] at h_action
          cases action
          case Withdraw inp =>
            clear h_withdrawal
            have : List.filterMap filter_UseNote h.tx.actions ≠ [] := by
              have := h.tx.h_balance inp.token
              have : h.tx.sum_withdraw_amounts inp.token ≠ 0 := by
                by_contra h_zero
                apply List.sum_eq_zero_iff.1 at h_zero

                have h_zero := h_zero inp.amount (by
                  rw [List.mem_map]
                  use {amount := inp.amount, token := inp.token, owner := inp.addralice}
                  rw [List.mem_filter, List.mem_filterMap]
                  refine ⟨⟨⟨.Withdraw inp, h_action, by rfl⟩, by simp⟩, by rfl⟩
                )
                have ⟨withdrawal_imp⟩ := WithdrawalImplies.from_action (
                  h.stxs₁.in_rm_actions h_action (by simp [h.h_txs]))
                exact withdrawal_imp.amount_nz h_zero

              have : h.tx.sum_use_note_amounts inp.token ≠ 0 := by omega
              simp only [Transaction₀.sum_use_note_amounts, Transaction₀.sum_amounts] at this
              by_contra h_empty
              simp only [ActionFunc.use, ←List.map_filterMap, h_empty] at this
              simp at this
            simp [this]
          all_goals contradiction

        case pos =>
          simp [h_no_withdrawals]

theorem withdrawals_for_user.nodup
    {crypto: Crypto} {m: Memory}
    (context: ScanNoteContext crypto m)
    (events: List (List Event))
    (user: UserPrivKey crypto m) :
    withdrawals_for_user context events user |>.Nodup := by
  unfold withdrawals_for_user
  rw [List.nodup_iff_injective_get]
  intro ⟨i, hi⟩ ⟨j, hj⟩ h
  simp only [List.get_eq_getElem, List.getElem_mapIdx] at h
  exact Fin.ext (congrArg WithdrawalEvent.idx h)

def withdrawals_for_user_token
    {crypto: Crypto} {m: Memory}
    (context: ScanNoteContext crypto m)
    (events: List (List Event))
    (user: UserPrivKey crypto m) (token: ℕ) : List WithdrawalEvent :=
  withdrawals_for_user context events user |>.filter (λ evt ↦ evt.token = token)
