# Phase 4 mutation checks

Each row breaks one protection in a scratch copy of the contracts and runs the named suites; KILLED means at least one test failed (the protection is tested, not just present). Run 2026-10-05 with `scratchpad/mutate.py` (patterns and suites below).

| mutation | result |
|---|---|
| M1 reserved assets not excluded from free liquidity | KILLED |
| M2 sigma step limit removed | KILLED |
| M3 deposits mint at the lower NAV | KILLED |
| M4 non-canonical report accepted | KILLED |
| M5 factory-market check removed | KILLED |
| M6 onlyVenue removed | KILLED |
| M8 redemptions paid at the upper NAV | KILLED |
| M9 ended-unresolved round not blocking settlement | KILLED |
| M10 settle window unlimited (no expiry) | KILLED |
| M11 venue ignores the limit price | KILLED |
| M12 venue accepts any report window | KILLED |
| M14 loss ceiling room ignored | KILLED |
| M15 pair cap removed | KILLED |
| M7 breaker never trips | KILLED |
| M13 price bounds on fills removed | KILLED |
15 of 15 mutations killed. Suites per mutation: M1 VaultFlows+VaultFuzz; M2/M5/M15 VaultInventory; M3 VaultFuzz; M4/M9/M10 VaultFlows; M6 VaultInventory+VaultInvariants; M7 VaultInventory+ForwardVenue; M8 VaultFuzz+VaultE2E; M11/M12/M13 ForwardVenue; M14 ForwardVenue+VaultInvariants.
