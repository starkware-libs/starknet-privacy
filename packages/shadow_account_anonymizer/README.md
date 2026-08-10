# Shadow Account Anonymizer

Lets the privacy pool run arbitrary dapp interactions on behalf of its users without linking those
interactions back to a user.

Each user interaction is identified by a commitment. The anonymizer keeps a registry mapping every
commitment to a dedicated shadow account contract that performs the dapp calls and holds the resulting
funds, which are then settled back into the privacy pool's open notes. Driving interactions is
restricted to the privacy contract the anonymizer is configured for.

Screening covers the shadow account an interaction runs through, not the anonymizer itself. The
funds reach an open note through that account rather than through the user's own address, so
`privacy_invoke_with_computation` returns its address along with the deposits it settles, and the
privacy contract screens that address when the anonymizer's policy is `Delegated`.
