import { BlockIdentifier, Call } from "starknet";
import {
  SimplePrivateTransfers,
  PrivateTransfers,
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

export class SimplePrivateTransfersImpl implements SimplePrivateTransfers {
  constructor(private inner: PrivateTransfers) {}

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
    if (!isAll(amount)) {
      builder.transfer({ recipient, amount });
    }
    return builder.surplusTo(recipient, false).execute();
  }

  swap(
    fromToken: StarknetAddress,
    fromAmount: Amount,
    toToken: StarknetAddress,
    helperCall: Call
  ): Promise<ExecuteResult> {
    return this.build(fromToken)
      .withdraw({ recipient: helperCall.contractAddress, amount: fromAmount })
      .with(toToken)
      .transfer({ recipient: this.inner.user, amount: Open })
      .execute();
  }

  async discoverNotes(_params: { since?: BlockIdentifier; known?: AddressMap<Note[]> }): Promise<{
    timestamp: BlockIdentifier;
    notes: AddressMap<Note[]>;
  }> {
    // Note: SimplePrivateTransfers uses since/known params but PrivateTransfers uses cursor/tokens
    // For now, we don't convert - just use the cursor stored in registry
    return this.inner.discoverNotes({ cursor: this.registry.cursor });
  }

  async discoverChannels(...recipients: StarknetAddress[]): Promise<{
    timestamp: BlockIdentifier;
    channels: AddressMap<Channel>;
  }> {
    return this.inner.discoverChannels(recipients);
  }

  private build(token: StarknetAddress) {
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
