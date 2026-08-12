# Shadow Account Anonymizer

Lets the privacy pool run arbitrary dapp interactions on behalf of its users without linking those
interactions back to a user.

Each user interaction is identified by a commitment. The anonymizer keeps a registry mapping every
commitment to a dedicated shadow account contract that performs the dapp calls and holds the resulting
funds, which are then settled back into the privacy pool's open notes. Driving interactions is
restricted to the privacy contract the anonymizer is configured for.

The class hash shadow accounts are deployed with is fixed at construction. `ShadowAccountClassHashEIC`
replaces it: attach it as the EIC of an anonymizer upgrade, passing the new class hash as the single
init-data element. Shadow accounts already deployed keep their code; only later deployments use the
new class hash.

`ShadowAccountsMigrationEIC` carries the registry across the `sub_accounts` → `shadow_accounts`
rename: attached as the EIC of an anonymizer upgrade with empty init data, it copies every entry
verbatim into the new storage variable, leaving the old one in place. Re-running it adds no
duplicate keys.

An upgrade carries one EIC, so migrating a contract deployed before the rename takes two upgrades:
run `ShadowAccountsMigrationEIC` first, then `ShadowAccountClassHashEIC`. In that order the registry
is populated before the class hash is set, so between the two upgrades every known commitment still
resolves to its recorded shadow account, and only a first-time commitment reverts on deploying
against a zero class hash. The reverse order leaves a window where a known commitment misses the
empty registry and gets a second shadow account deployed at the address the new class hash computes,
orphaning the funds held by the first one.
