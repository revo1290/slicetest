# Changelog

## Unreleased

- GitHub Actions: failing YAML steps are annotated on their line in the `.scenario.yaml` file, and the job summary gets the failed steps and the OpenAPI coverage table (✅ / ❌ per documented response). Coverage below `minCoverage` is annotated on the spec. No configuration.
- `slicetest init` detects more: mail catchers in compose (Mailpit, MailHog, …) and mail libraries turn on `mail`; SQLite from Prisma, Rails, Django or a driver, with `DATABASE_URL` in the framework's form; third-party API URLs in `.env.example` become stubs with `upstream` for recording, and the app's variables point at them.
- SQLite: `db: { engine: "sqlite" }` needs no server or container. Uses Node's built-in `node:sqlite` (22.5+): a migrated template copied per worker with `VACUUM INTO`, WAL mode so the app keeps its connection, resets with `DELETE` and restarted `AUTOINCREMENT` counters. The app gets `{{db.url}}` (`sqlite:///path`) and `{{db.path}}`.
- `npx slicetest doctor`: checks the config, the container runtime or database server, migrations, seed, `atlas`, `mysql2`, the app's and services' programs, OpenAPI files and recordings before a run, with what to do for each problem. Exits with 1 when something must be fixed.
- `http.concurrently(n, send)` releases `n` requests together to provoke races, and `toHaveStatuses({ 201: 1, 409: 9 })` checks how they were answered. YAML: `concurrency: n` on a `request` step with `expect.statuses`.
- `mail: true`: an in-process SMTP server at `{{mail.host}}` / `{{mail.port}}` collects the mail the app sends, decoded (RFC 2047 subjects, quoted-printable, base64, multipart text/HTML) with its links extracted. `mail.messages()`, `mail.last()` and `mail.waitFor()` in scenarios, a `mail` step in YAML, the messages in failure output and in `trace()`. YAML `request` steps accept a captured URL (`GET {{link}}`).

## 0.3.0

- `slicetest init` reads docker compose: the database service sets `db.image` / `db.engine`, and Redis, Valkey, Mongo, Elasticsearch, MinIO, RabbitMQ and other services become `containers`, with reset commands and app variables where known. A MySQL driver in the dependencies also selects MySQL.
- `containers`: dependencies such as Redis, Elasticsearch or MinIO, started per test file and reset between scenarios with a command run inside them (`reset: ["redis-cli", "FLUSHALL"]`). Reachable at `{{container.<name>}}`; `container(name).exec()` runs commands in them.
- `trace()` in the scenario context: the requests to the app, calls to stubs and database changes of the scenario so far, with dates and UUIDs masked, for `expect(await trace()).toMatchSnapshot()`. `mask()` is exported for other values. YAML: `snapshot: true`.
- `npx slicetest gen`: scenario skeletons for every documented response of the app's OpenAPI spec, with requests built from the spec, ids captured from the collection's `POST`, and `skip: true` TODOs for states the test has to arrange. `--uncovered` only generates what the last run's coverage report marked ✗.
- Recorded stubs: `{ name, upstream: "https://api.github.com" }` answers unrouted calls from `recordings/<name>.yaml`. `SLICETEST_RECORD=<name>` forwards the calls it has no recording for to the real service and records the answers, without request headers or noisy response headers. Works for apps in any language.
- MySQL: `db: { engine: "mysql" }` (or a `mysql://` URL) runs the same scenarios against MySQL 8. Workers get a clone of the migrated template (tables, foreign keys, views, triggers), resets only truncate tables that were written to, and rows are typed like Postgres's so scenarios are portable. Needs `mysql2`, plus `@testcontainers/mysql` when no `db.url` is given.

## 0.2.0

- `autoReply: true` on a stub with an OpenAPI spec answers calls that no route matches from the spec: its examples, or values built from the schema. `stub.fallback(fn)` is the underlying API.
- Fix: the matcher types (`toHaveStatus`, `toHaveReceived`, `toHaveRow`, …) are now part of the package's public types. In 0.1.0 they only resolved inside this repository, so TypeScript users of the npm package got "Property 'toHaveStatus' does not exist".
- `npx slicetest init`: detects the app's stack (Node, Django, FastAPI, Flask, Rails, Go, Rust), its migrations (Atlas, Prisma, Alembic, Django, Rails, Drizzle, Knex, SQL) and an OpenAPI file, and writes `slicetest.config.yaml` plus a first scenario.
- `services`: start workers and other processes next to the app. They're referenced as `{{service.<name>}}` / `{{service.<name>.port}}`, watched for crashes, restarted on the same port, and their scenario output appears in failures. `app.waitForLog()` / `service(name).waitForLog()` and the YAML `log` step wait for a line printed during the scenario.
- OpenAPI coverage: when `openapi` is set, the run ends with a table of the documented responses (per operation and status) that the scenarios produced, merged across workers. `openapi: { spec, minCoverage }` fails the run below a percentage.
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
