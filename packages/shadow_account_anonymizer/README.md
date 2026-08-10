# Shadow Account Anonymizer

Lets the privacy pool run arbitrary dapp interactions on behalf of its users without linking those
interactions back to a user.

Each user interaction is identified by a commitment. The anonymizer keeps a registry mapping every
commitment to a dedicated shadow account contract that performs the dapp calls and holds the resulting
funds, which are then settled back into the privacy pool's open notes. Driving interactions is
restricted to the privacy contract the anonymizer is configured for.

The funds reach an open note through a sub-account rather than through the user's own address, so
the anonymizer also answers the pool's screening query: given an interaction's calldata, it names
the sub-account that interaction settles its notes through, which is the address screening must
cover.
