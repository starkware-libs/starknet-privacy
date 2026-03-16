import privacy.actions
import privacy.registration
import privacy.channels.channels
import privacy.subchannels.subchannels
import privacy.notes.note_implies
import privacy.notes.used_notes
import privacy.notes.open_deposits

-- If an action was executed, it cannot be executed again.
theorem no_replay
    {crypto: Crypto} {rm: ReachableMemory crypto}
    {action: Action}
    (h: action ∈ rm.actions)
    (h_action: ∀ x, action ≠ .Withdraw x):
    ¬(run_action crypto action rm.m).success := by
  by_contra success
  cases action
  case Register inp =>
    let info := register_info crypto inp rm success
    have register_imp := RegisterImplies.from_action h
    have := register_imp.public_key ▸ info.alice_was_not_registered
    exact crypto.zero_not_public_key ⟨_, register_imp.h_kalice⟩ this
  case OpenChannel inp =>
    let info := open_channel_info crypto inp rm success
    have ⟨channel_imp⟩ := ChannelImplies.from_action h
    exact channel_imp.channel_markers info.channel_didnt_exist
  case OpenSubchannel inp =>
    let info := open_subchannel_info crypto inp rm success
    have ⟨subchannel_imp⟩ := SubchannelImplies.from_action h
    exact subchannel_imp.subchannel_marker info.old_hash_was_zero
  case CreateNote inp =>
    let info := create_note_info crypto inp rm success
    have ⟨note_imp⟩ := NoteImplies.from_action h
    exact note_imp.h_note_exists info.old_value_was_zero
  case UseNote inp =>
    let info := use_note_info crypto inp rm success
    have ⟨use_imp⟩ := UseImplies.from_action h
    have h_nc := use_imp.h_note_used
    exact h_nc info.nullifier_didnt_exist
  case OpenDeposit inp =>
    let info := open_deposit_info crypto inp rm success
    have ⟨open_deposit_imp⟩ := OpenDepositImplies.from_action h
    have := open_deposit_imp.value
    rw [open_deposit_imp.h_note_id, info.old_value] at this
    apply congrArg crypto.unpack at this
    simp only [crypto.unpack_pack, Prod.mk.injEq, true_and] at this
    exact open_deposit_imp.amount_nz this.symm
  case Withdraw inp =>
    have := h_action inp
    contradiction
