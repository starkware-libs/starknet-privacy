import { CallDetails } from "starknet";
import {
  SimplePrivateTransfersInterface,
  PrivateTransfersInterface,
  Amount,
  Channel,
  Note,
  Open,
  PrivateRegistry,
  StarknetAddress,
  All,
  ExecuteResult,
} from "./interfaces.js"; // Assuming you moved interfaces
import { AddressMap } from "./utils/maps.js";
import { isAll } from "./utils/validation.js";

export class SimplePrivateTransfersImpl implements SimplePrivateTransfersInterface {
  constructor(private inner: PrivateTransfersInterface) {}

  get user(): StarknetAddress {
    return this.inner.user;
  }

  readonly registry: PrivateRegistry = {
    channels: new AddressMap<Channel>(),
    notes: new AddressMap<Note[]>(),
  };

  deposit(token: StarknetAddress, amount: Amount): Promise<ExecuteResult> {
    return this.build(token).deposit({ amount }).execute();
  }

  withdraw(
    token: StarknetAddress,
    recipient: StarknetAddress,
    amount: Amount | All
  ): Promise<ExecuteResult> {
    const builder = this.build(token);
    const surplustWithdraw = isAll(amount) ? true : false;
    if (!isAll(amount)) {
      builder.withdraw({ recipient, amount });
    }
    return builder.surplusTo(recipient, surplustWithdraw).execute();
  }

  transfer(
    token: StarknetAddress,
    recipient: StarknetAddress,
    amount: Amount | All
  ): Promise<ExecuteResult> {
    const builder = this.build(token);
    if (isAll(amount)) {
      // Transfer all: send everything as surplus to recipient
      return builder.surplusTo(recipient, false).execute();
    }
    // Transfer specific amount: send amount to recipient, keep surplus
    return builder.transfer({ recipient, amount }).surplusTo(this.inner.user, false).execute();
  }

  swap(
    fromToken: StarknetAddress,
    fromAmount: Amount,
    toToken: StarknetAddress,
    helperCall: CallDetails
  ): Promise<ExecuteResult> {
    return this.build(fromToken)
      .withdraw({ recipient: helperCall.contractAddress, amount: fromAmount })
      .surplusTo(this.inner.user, false) // Keep ACE surplus as private note
      .with(toToken)
      .transfer({ recipient: this.inner.user, amount: Open, depositor: helperCall.contractAddress })
      .done()
      .call(helperCall)
      .execute();
  }

  private build(token: StarknetAddress) {
    // Clear notes before refresh to avoid stale entries (already-spent notes)
    this.registry.notes.clear();
    return this.inner
      .build({
        autoDiscover: { notes: "refresh", channels: "refresh" },
        autoSetup: true,
        autoSelectNotes: "all",
        registry: this.registry,
      })
      .with(token);
  }
}
