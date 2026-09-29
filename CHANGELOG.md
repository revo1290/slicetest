# Changelog

## 0.1.0

First public release.

- Vitest plugin: starts your app as a real process, a real Postgres (Testcontainers or `db.url`), and stub servers for outbound APIs.
- The database is reset between scenarios with `TRUNCATE ... RESTART IDENTITY CASCADE`, skipping migration bookkeeping and extension tables. The seed is re-applied after each reset.
- Migrations with Atlas, plain SQL, or any command.
- `http`, `db` and `stub` helpers, and the matchers `toHaveStatus`, `toHaveReceived`, `toHaveReceivedTimes` and `toHaveRow`.
- Stubs support path params, query/header/JSON conditions, `once`/`times`, `delay`, `networkError` and `replySequence`.
- Scenarios fail when the app crashes or calls an unregistered stub route. Crashed apps are restarted for the next scenario.
- Failure output shows the scenario's requests, the app's output during the scenario, and unmatched stub calls.
- YAML scenarios (`*.scenario.yaml`) with a JSON Schema, and the `slicetest` CLI for running them without JavaScript.
- macOS, Linux and Windows.
