# Changelog

## Unreleased

- OpenAPI coverage: when `openapi` is set, the run ends with a table of the documented responses (per operation and status) that the scenarios produced, merged across workers. `openapi: { spec, minCoverage }` fails the run below a percentage.

## 0.2.0

- OpenAPI contracts: `openapi: "openapi.yaml"` checks every response the app gives against its spec, and `stubs: [{ name, openapi }]` checks the app's requests to a stubbed service, and the stub's canned replies, against the provider's spec. Mismatches fail the scenario and are listed in the failure output. OpenAPI 3.0 (including `nullable`) and 3.1.
- `db.changes()` returns every row the scenario inserted, updated or deleted, per table, matched by primary key. `db.checkpoint()` excludes what the test arranged. A plain `toEqual` on it catches writes to tables you didn't expect.
- Failure output now includes the database changes made during the scenario.
- `db.reuse` (on by default outside CI): the Postgres container stays up between runs, and the migrated template is cached by a hash of the migration files. In the examples, a full run drops from 3.2 s to 1.7 s. `db.migrate.command` takes `inputs` to opt into the cache. Databases left behind by killed runs are cleaned up after a day.
- YAML: `changes` and `checkpoint` steps, and `within: <ms>` on `db`, `sql`, `received` and `changes` steps to wait for asynchronous effects.

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
