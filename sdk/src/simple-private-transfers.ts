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
import { toBigInt } from "./utils/convert.js";
import { toHex } from "./utils/convert.js";
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

  /**
   * Settlement of the last operation queued on this instance, so operations never interleave
   * their use of the single shared `registry`. Settles regardless of outcome, so a failed
   * operation still lets the queue drain.
   *
   * Ordering only — this does not make note selection disjoint. `execute` returns a proof for the
   * caller to submit, so a caller that needs operation N+1 to see N's change note must submit N
   * and let it land; two operations proved before either is submitted spend the same notes.
   */
  private queueTail: Promise<void> = Promise.resolve();

  deposit(token: StarknetAddress, amount: Amount): Promise<ExecuteResult> {
    return this.enqueue(() => this.build(token).deposit({ amount }).execute());
  }

  withdraw(
    token: StarknetAddress,
    recipient: StarknetAddress,
    amount: Amount | All
  ): Promise<ExecuteResult> {
    return this.enqueue(() => {
      const builder = this.build(token);
      if (isAll(amount)) {
        // Withdraw all: send everything as surplus to recipient's public balance
        // TODO(Avi): no-op today — resolveNotes only enters a token into `balances` via
        // deposits/useNotes/withdraws/createNotes, so a bare surplusTo with no other action
        // on the token never selects notes or emits a withdraw. Needs a fix in internal/compiler.ts.
        return builder.surplusTo(recipient, true).execute();
      }
      // Withdraw specific amount: pay recipient publicly, keep surplus as a private note
      return builder.withdraw({ recipient, amount }).surplusTo(this.inner.user, false).execute();
    });
  }

  transfer(
    token: StarknetAddress,
    recipient: StarknetAddress,
    amount: Amount | All
  ): Promise<ExecuteResult> {
    return this.enqueue(() => {
      const builder = this.build(token);
      if (isAll(amount)) {
        // Transfer all: send everything as surplus to recipient
        return builder.surplusTo(recipient, false).execute();
      }
      // Transfer specific amount: send amount to recipient, keep surplus
      return builder.transfer({ recipient, amount }).surplusTo(this.inner.user, false).execute();
    });
  }

  swap(
    fromToken: StarknetAddress,
    fromAmount: Amount,
    toToken: StarknetAddress,
    executor: StarknetAddress
  ): Promise<ExecuteResult> {
    return this.enqueue(() => {
      const toTokenAddress = toBigInt(toToken);
      return this.build(fromToken)
        .withdraw({ recipient: executor, amount: fromAmount })
        .surplusTo(this.inner.user, false) // Keep ACE surplus as private note
        .with(toToken)
        .transfer({ recipient: this.inner.user, amount: Open })
        .done()
        .invoke(({ openNotes, withdrawals }) => {
          return {
            contractAddress: toHex(executor),
            calldata: [
              withdrawals[0].token,
              toTokenAddress,
              withdrawals[0].amount,
              openNotes[0].noteId,
            ],
          };
        })
        .execute();
    });
  }

  /**
   * Runs `operation` once every operation already queued on this instance has finished, keeping
   * call order. The caller still sees the operation's own rejection.
   */
  private enqueue(operation: () => Promise<ExecuteResult>): Promise<ExecuteResult> {
    const queuedOperation = this.queueTail.then(operation);
    this.queueTail = queuedOperation.then(
      () => undefined,
      () => undefined
    );
    return queuedOperation;
  }

  private build(token: StarknetAddress) {
    // Cleared together, since `autoDiscover: "refresh"` refills all of it: the cursor records how
    // far discovery scanned, so keeping it while dropping notes hides everything it accounted for.
    this.registry.notes.clear();
    this.registry.channels.clear();
    delete this.registry.cursor;
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
