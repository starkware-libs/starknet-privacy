#!/usr/bin/env python3
"""Generate per-slide narration MP3s for the OTC hackathon video using edge-tts."""

import asyncio
import edge_tts

VOICE = "en-US-AndrewMultilingualNeural"
RATE = "+0%"

SCRIPTS = {
    "slide-1": (
        "Private OTC on Starknet. "
        "Atomic peer-to-peer trades. No escrow. No third party. No funds ever locked. "
        "Both sides keep their balances private. Both legs settle in a single transaction."
    ),
    "slide-2-demo-vo": (
        "Here's the protocol in action. "
        "Two browsers — Alice on the left, Bob on the right. "
        "Each has a balance in the privacy pool. Amounts encrypted on chain, visible to them in the UI. "
        "Alice wants to give one hundred USD for zero point zero zero five B-T-C. "
        "She picks a trade ID, fills in her offer and her ask, selects Bob as the counterparty. "
        "Bob fills in the opposite leg — same trade ID. "
        "They've agreed on terms off chain. Each clicks submit. "
        "The order doesn't matter — whoever lands second triggers settlement. "
        "Both legs apply in a single transaction. Watch the balances flip. "
        "Alice has the B-T-C. Bob has the USD. "
        "Now the audit tab. Reconstructed live from on-chain data — nothing read from local storage. "
        "The salt column holds the trade ID. "
        "Click verify, the app fetches the originating transaction, confirms it routed through the OTC contract, "
        "and recovers the trade ID from the calldata. Exportable as J-SON for an accountant. "
        "And finally — tampering. Bob changes his amount mid-trade. "
        "The transaction reverts at fee estimation, before any funds move. "
        "The conditional check catches the mismatch."
    ),
    "slide-3": (
        "What did we change in the privacy pool? One thing. "
        "We split the apply actions entrypoint into two — store actions, and apply stored actions. "
        "Proof verification happens at store time. Execution happens later, at apply time. "
        "That's the change. "
        "Everything else our app does is built on top — applying both legs atomically in one transaction, "
        "and using the existing invoke external hook for a conditional check."
    ),
    "slide-4": (
        "What this gives you. "
        "Private — amounts and tokens encrypted on chain. Only the two parties decrypt them. "
        "Atomic — both legs settle in a single transaction, or neither does. "
        "Peer to peer — no third party, no escrow, no lock window. "
        "Permissionless — no identity checks. Anyone can submit the transactions. Only valid proofs settle. "
        "Symmetric — both sides submit the same call, no initiator role. "
        "And order independent — whoever lands second automatically settles both."
    ),
    "slide-5": (
        "How does this work? "
        "Each proof commits to two things at once — transferring tokens to the counterparty, "
        "and checking the counterparty also transferred you, scoped to the same trade ID. "
        "A naive implementation creates a chicken and egg deadlock. "
        "If Alice's transaction needs Bob's note on chain, and Bob's needs Alice's, neither can go first. "
        "The OTC helper contract breaks it. "
        "The check becomes — counterparty transferred me directly… or… counterparty committed to transfer me in the helper. "
        "Two branches, same condition. "
        "When the first leg runs, the other's commitment is in the helper. "
        "When the second runs, the first's notes are already on chain. "
        "The result — a check that's on chain, private, and bound to the exact agreed token and amount."
    ),
    "slide-6": (
        "It works. And it can't be cheated. "
        "Order agnostic settlement — Alice first, Bob first, or both at the same time. "
        "The trade settles in every case. "
        "Tamper evident — try to send a different token than agreed, the transaction reverts. "
        "Try to send a smaller amount, reverts. "
        "Try to send to a different recipient, reverts. "
        "Try to use a different trade ID, the two legs never pair up. "
        "In each failure case, no funds ever move. "
        "The condition catches the mismatch at fee estimation, before any state changes."
    ),
    "slide-7": (
        "What's next. Match maker integration. "
        "Today Alice and Bob have to know each other. With a match maker in front, they don't. "
        "Each posts a conditional offer. "
        "The match maker finds the counterparty, adds the only missing piece — "
        "a proof of transfer to Alice and transfer to Bob — and settles. "
        "Neither party sees who they traded with. "
        "Put the match maker inside an enclave, and even it doesn't see the details. "
        "Atomic. No lock. Zero trust. Executed on the fly."
    ),
}


async def render(slide_name: str, text: str) -> None:
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE)
    out_path = f"/home/yonatan/workspace/starknet-privacy2/video_assets/{slide_name}.mp3"
    await communicate.save(out_path)
    print(f"  ✓ {slide_name}.mp3")


async def main() -> None:
    print(f"Voice: {VOICE}")
    print(f"Rate:  {RATE}")
    print("Rendering:")
    for name, text in SCRIPTS.items():
        await render(name, text)
    print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
