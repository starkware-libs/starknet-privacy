# 10. Contract Versioning and Layout Compatibility

## 10.1 Binding to Contract Address

The discovery service is bound to a specific, whitelisted privacy pool contract address. This provides:

- Protection against queries to arbitrary contracts.
- Implicit versioning: different contract addresses imply different deployments.

## 10.2 Handling Proxy Contracts and Upgrades

If the privacy pool uses a proxy pattern (constant address, upgradeable implementation), storage layout changes require special handling:

**Detection:** The service should track a layout version indicator. Options include:

- A dedicated storage slot containing layout version.
- Monitoring for upgrade transactions on the proxy.
- Configuration-based version bumps.

**Transition handling:** When a layout change is detected:

1. Determine the block height at which the upgrade occurred.
2. For blocks before the upgrade: use the old slot calculation logic.
3. For blocks at or after the upgrade: use the new slot calculation logic.
4. Maintain both calculation libraries until old blocks are no longer queried.

**Configuration:** Layout versions should be configurable:

```yaml
contract:
  address: "0x..."
  layout_versions:
    - version: 1
      from_block: 0
      to_block: 100000
    - version: 2
      from_block: 100001
      to_block: null  # current
```

## 10.3 Failure Mode

If the service detects that storage reads are returning unexpected data (e.g., decryption consistently fails for all users, structure probing returns impossible values), it should:

1. Log an alert indicating possible layout mismatch.
2. Return `SERVICE_UNAVAILABLE` with a message indicating contract compatibility issue.
3. Require manual intervention to update layout configuration.
