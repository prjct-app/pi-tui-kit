# Changelog

## 0.3.4 (2026-10-06)

- Remove the retired classifier and its credential-management exports. Consumers must remove imports of those APIs; normal UI helpers retain their signatures.
- Handoff guidance preserves original language, quotes and constraints instead of requiring translation.
- Isolate tests from personal Pi settings and reject OS keychain access.
