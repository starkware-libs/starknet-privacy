import privacy.tracking.outgoing_notes
import privacy.tracking.incoming_notes

theorem incoming_eq_outgoing
  {crypto: Crypto} (stxs: SuccessfulTransactions crypto) (addr: ℕ) (token: ℕ) : false := by
  have := outgoing_notes stxs addr token
  conv at this =>
    rhs; enter [1, 1, tx]
    rw [tx.h_balance]
  rw [←incoming_notes] at this

  sorry
