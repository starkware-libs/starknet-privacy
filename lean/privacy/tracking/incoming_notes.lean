import privacy.actions
import privacy.amounts
import privacy.compliance.all_notes
import privacy.notes.canceled_notes
import privacy.registration.discoverable
import privacy.transactions.transactions
import privacy.tracking.utils

theorem incoming_notes₀
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (addrbob: ℕ) (token: ℕ) :
    (
      cancel_note_actions crypto stxs.rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob)
      |>.map (λ inp ↦ inp.amount)
      |>.sum
    ) = (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = addrbob)
      |>.map (λ tx ↦ tx.sum_cancel_note_amounts token)
      |>.sum
    ) := by
  rw [←filtered_note_actions_to_tx_actions]
  unfold cancel_note_actions ActionFunc.cancel ActionFuncRes.from_cancel
  simp only [List.filter_filterMap, List.map_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro action h_action
  cases h_some: filter_CancelNote action
  case none => simp
  case some inp => simp [Option.filter_some]

theorem incoming_notes₁
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (addrbob: ℕ) (token: ℕ) :
    let kbobs : List ℕ :=
      scan_users crypto stxs.rm.events
      |>.filter (λ user ↦ user.1 = addrbob)
      |>.map (λ user ↦ user.2)
      |>.dedup
    (
      cancel_note_actions crypto stxs.rm
      |>.filter (λ inp ↦ inp.token = token ∧ inp.addrbob = addrbob)
      |>.map (λ inp ↦ inp.amount)
      |>.sum
    ) =
    (
      kbobs
      |>.map (λ kbob ↦
        sum_cancel_note_amounts crypto stxs.rm addrbob kbob token
      )
      |>.sum
    ) := by
  intro kbobs
  rw [fiber_sum
    (img:=kbobs)
    (f:=λ inp ↦ inp.kbob)
    (h_img := by
      intro inp h_inp
      rw [List.mem_filter] at h_inp
      simp only [kbobs, List.mem_dedup, List.mem_map, List.mem_filter]
      use ⟨inp.addrbob, inp.kbob⟩
      refine ⟨⟨?_, ?_⟩, by rfl⟩
      . have ⟨⟨addralice, kalice, h_inp_c⟩, _, _, h_canceled⟩ := (note_cancel_action_implies h_inp.1)
        have h_exists := canceled_note_implies_exists h_canceled
        have ⟨sn, _, h_sn_note_id, ⟨addralice, kalice, addrbob, kbob, h_c, h_in_scan_users⟩⟩ := all_notes_are_discoverable h_exists
        have : inp.c = sn.c := by
          apply crypto.h_hash at h_sn_note_id
          injections
        have : inp.addrbob = addrbob ∧ inp.kbob = kbob := by
          rw [h_c, h_inp_c] at this
          apply crypto.h_hash at this
          injections
          rename_i h_kbob _
          unfold CancelNoteInput.Kbob at h_kbob
          apply crypto.priv_to_pub_inj (by assumption) (by simp) at h_kbob
          simp [*]
        simp [this, h_in_scan_users]
      · simp only [Bool.decide_and, Bool.and_eq_true, decide_eq_true_eq] at h_inp
        simp [h_inp]
    )
    (h_nodup:=by apply List.nodup_dedup)
  ]

  unfold sum_cancel_note_amounts
  simp only [←List.filterMap_eq_map, ←List.filterMap_eq_filter, List.filterMap_filterMap]
  apply congrArg
  apply List.filterMap_congr
  intro kbob h_kbob
  simp only [Function.comp_apply, Option.some.injEq, Option.guard]
  apply congrArg
  apply List.filterMap_congr
  intro inp h_inp
  by_cases h: inp.token = token ∧ inp.addrbob = addrbob
  case pos =>
    by_cases h': inp.kbob = ↑kbob
    case pos => simp [h, h']
    case neg => simp [decide_eq_true h, h']
  case neg => simp [←and_assoc, h]

theorem incoming_notes
    {crypto: Crypto} (stxs: SuccessfulTransactions crypto)
    (addrbob: ℕ) (token: ℕ) :
    (
      scan_users crypto stxs.rm.events
      |>.filter (λ user ↦ user.1 = addrbob)
      |>.map (λ user ↦ user.2)
      |>.dedup
      |>.map (λ kbob ↦
        sum_cancel_note_amounts crypto stxs.rm addrbob kbob token
      )
      |>.sum
    )= (
      stxs.txs
      |>.filter (λ tx ↦ tx.owner = addrbob)
      |>.map (λ tx ↦ tx.sum_cancel_note_amounts token)
      |>.sum
    ) := by
  rw [←incoming_notes₀, ←incoming_notes₁]
