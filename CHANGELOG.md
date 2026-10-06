# Changelog

## 0.3.5 (2026-10-06)

- Preserve complete model evidence during argument normalization. Remove hidden reply size limits and lossy semantic guesses. Fall back to complete serialized data after repeated invalid replies.

## 0.3.4 (2026-10-06)

- Remove the retired classifier and its credential-management exports. Consumers must remove imports of those APIs; normal UI helpers retain their signatures.
- Handoff guidance preserves original language, quotes and constraints instead of requiring translation.
- Isolate tests from personal Pi settings and reject OS keychain access.
