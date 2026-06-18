# Sub-Account Anonymizer

Lets the privacy pool run arbitrary dapp interactions on behalf of its users without linking those
interactions back to a user.

Each user interaction is identified by a commitment. The anonymizer keeps a registry mapping every
commitment to a dedicated sub-account contract that performs the dapp calls and holds the resulting
funds, which are then settled back into the privacy pool's open notes. Driving interactions is
restricted to the privacy contract the anonymizer is configured for.
