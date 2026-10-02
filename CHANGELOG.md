# Changelog

## Unreleased

- `db.migrate.env`, and `{{db.*}}` placeholders in `db.migrate.command`, for migration tools that don't read `DATABASE_URL` (Laravel's `DB_*`, EF Core's `--connection`, Flyway's `-url`). `{{db.adoNet}}`: the database as an ADO.NET connection string (Npgsql, MySqlConnector, `Data Source=` for SQLite), for .NET apps.
- YAML `define:` and `use:` steps: named step lists with `params`, run with `use: signed up` + `with: { email: ... }`, whose captures are visible afterwards. Unknown definitions, missing or extra params and recursion are reported with their line up front; failures inside name the path (`step 1: use signed up → step 2: POST /login`).
- `npx slicetest import session.har`: turn a HAR file (browser network panel, Charles, mitmproxy, Proxyman, Postman) into recordings for the stubs whose `upstream` it has requests for, or for `--stub <name> --upstream <url>`. Same format and filtering as `SLICETEST_RECORD`; preflights, aborted requests and binary responses are skipped, duplicates aren't added, and hosts that weren't imported are listed.
- A stub call no route answered is reported with the closest route and the first thing that kept it from matching: method, path (trailing slash, letter case, a base-URL prefix the app added or lacks), query, header, body, the JSON field and value at its path (`json.items.0.sku: expected "a", got "b"`), GraphQL operation or variables, or a `once()` / `times()` route already used up. `stub.explain(call)` returns the same text.
- Sequence diagrams: `diagram()` in a scenario returns what it did so far as a Mermaid sequence diagram (requests to the app, the stub calls made while answering each, their replies, mail and changed tables). `npx slicetest --diagrams <dir>` / `SLICETEST_DIAGRAMS` writes one Markdown page of diagrams per scenario file, and on GitHub Actions each failed scenario's diagram goes to the job summary.
- GraphQL: `stub(name).graphql("CreateIssue", { variables })` answers an operation at whatever path the app posts it to (POST bodies and GET query parameters; the name comes from `operationName` or the document), with `.data()` / `.errors()` for GraphQL-shaped replies. `http.graphql(query, variables)` calls the app's endpoint. Matchers `toHaveReceivedGraphQL(operation, variables)` and `toHaveGraphQLData(expected)`, which fails on `errors` answered with 200. Unanswered operations are reported as `GraphQL mutation CreateIssue`. YAML: `graphql:` on stub, request and received steps, `when.variables`, `reply: { data, errors }`, `{{call.variables.x}}`.

## 0.6.1

- Cookies are sent only to paths under their `Path` (a refresh token set for `Path=/auth/refresh` no longer goes with every request), longest `Path` first; without `Path`, the directory of the request that set it, as browsers do. Cookies added by hand through `http.cookies` still go everywhere. `Max-Age` now wins over `Expires` regardless of their order.
- When the app dies at start-up because its port was taken in the moment between slicetest choosing it and the app binding it (another worker or program), it is started again on another port, up to 3 times. Ports already handed out in the process are not offered again.

## 0.6.0

Tried on five real projects (Next.js with server actions, Clerk, Neon and Stripe; a Next.js aggregator of hard-coded feeds; three Spring Boot apps with GitHub, Google and springdoc), and changed wherever they didn't work as they were.

Stubbing services the app calls by a URL written in its code:

- Stubs for hard-coded hosts: `{ name: "github", hosts: ["api.github.com"] }` answers the app's calls to those hosts, over HTTPS or HTTP, without the app reading a base URL from its environment. The app is started with proxy variables and a certificate authority made for the run, in the forms Node (`NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`), OpenSSL-based runtimes and Go (`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`) and the JVM (`JAVA_TOOL_OPTIONS` with a PKCS#12 trust store) read. Other hosts are passed through and listed in the failure output. `{{proxy.url}}`, `{{proxy.ca}}`, `{{proxy.bundle}}`, `{{proxy.truststore}}`.
- Node apps also get a preload (`NODE_OPTIONS=--require`) so that `http.Agent`s made by libraries (the Stripe SDK, …) use the proxy, which `NODE_USE_ENV_PROXY` alone doesn't reach.
- `hosts` takes `*.domain` for every subdomain of a domain (connpass group feeds at `<group>.connpass.com`).
- `offline: true`: the app's HTTP(S) calls may only reach localhost and stubbed hosts; any other host is refused and the scenario fails naming it, so a forgotten stub never reaches a real service. When the host is a package registry (Maven Central, npm, the Go proxy, PyPI, …), the message explains that the command starting the app is downloading dependencies.
- Redirects to an intercepted host are followed to its stub (with `follow: true`), so OAuth logins through a provider's consent page run in a scenario. The app's cookies aren't sent there.
- `sse(events)` replies with a Server-Sent Events stream, as LLM APIs stream answers; YAML `reply: { sse: [...] }`.

Next.js:

- `http.submit(page, { button, form, fields })`: submit a form of a page the app returned, as a browser with JavaScript off would: every field with its value, hidden ones included, and the pressed button with its `formaction` / `formmethod` / `formenctype`. CSRF tokens and Next.js server actions (action id and bound arguments in hidden inputs) work without the scenario knowing about them. `fields` must name existing fields; checkboxes and radios take `true` / `false` / values. Errors list the page's forms and buttons. YAML: a `submit` step that uses the page the previous step requested.
- `app.build` (and `services.<name>.build`): a command run once per run before the app starts, while the database starts, with `app.env`'s literal values (Next.js inlines `NEXT_PUBLIC_*` at build time). Without it, `next start` served the last build and scenarios passed against stale code.
- `db: { neon: true }`: for apps on Neon's serverless driver over HTTP (`@neondatabase/serverless`, `drizzle-orm/neon-http`, `@vercel/postgres`), `{{db.url}}` is a Neon-style URL and slicetest answers the driver's HTTP queries and transaction batches from the test database, with Postgres's error fields.
- `auth.jwks` (the JWKS document) and `{{auth.publicKey}}` (PEM), for libraries that read keys from their provider's URL or the environment. The README shows Clerk with them.

Spring Boot and other slow-starting apps:

- `app.scope: "worker"`: start the app, stubs and services once per Vitest worker and keep them for all of its test files, instead of once per file. A Spring Boot suite of 8 files went from 28 s to 10 s with `workers: 2`. Sets Vitest's `isolate: false`.
- `workers`: the most Vitest workers to run (Vitest's `maxWorkers`), each with its own app and database.
- `{{db.jdbcUrl}}`, `{{db.host}}`, `{{db.port}}`, `{{db.name}}`, `{{db.user}}`, `{{db.password}}` for apps that don't take a database URL, such as Spring (`SPRING_DATASOURCE_URL`).
- `openapi: { fromApp: "/v3/api-docs" }`: check responses against, and report coverage of, the spec the running app serves (springdoc, FastAPI, NestJS), with no spec file in the repository.
- `db: false` for an app without a database: no container, no migrations, no resets, no `DATABASE_URL`; `db.*` in a scenario says the database is off, and `doctor` skips the database checks.

`slicetest init`:

- Finds the app in `backend/`, `server/`, `api/`, `app/` or `service/` when the root isn't one, and reads its migrations and `.env.example` there.
- Spring Boot (Gradle and Maven): `bootRun` after building once with `bootJar` / `package` (so workers neither compile at the same time nor download while running), `SERVER_PORT` and `SPRING_DATASOURCE_*`, the actuator health check (also from a subproject's build file), `scope: worker` in 2 workers.
- Atlas migrations from `atlas.hcl`'s `dir` (also in `atlas/` or `db/`); `podman-compose.yml`; Drizzle migrations applied as SQL from `drizzle.config`'s `out`, with a note to generate them when missing.
- `db: false` when there are no migrations, no database service and no database library; `db.neon` when Neon's driver is a dependency.
- SDKs with built-in hosts (Stripe, Anthropic, OpenAI, Resend, SendGrid, Slack, Octokit, Twilio) get stubs with `hosts`, and placeholder keys for the variables `.env.example` lists; Clerk gets a publishable key, `auth: true` and a stub; every project gets a note about `hosts` and `offline`.
- `npm run build` as `app.build` when `package.json` has a build script.
- The first scenario requests the health check path, and doesn't expect 200 at `/` when there's none.

Also:

- `slicetest()` in a `vitest.config.ts` without options reads `slicetest.config.yaml`, or the file given as a string, so the CLI and TypeScript scenarios share one config.
- Vitest 4 is supported (peer `vitest >=4`); the CLI failed with `filters.map is not a function` under it. Under Vitest 3 or older, `npx slicetest` stops with a clear message instead of running the project's own tests.
- A migration that finishes without error but leaves no tables stops the run with its output (drizzle-kit exits 0 when it can't connect).
- Containers from `containers` are removed when a worker exits without tearing down, also with Podman, where Testcontainers' reaper is off.
- Fixed: `follow: true` dropped cookies set by intermediate redirects (a login answering `302` with `Set-Cookie`), and followed redirects to other hosts. Redirects are now followed by slicetest: cookies are kept, `301`/`302`/`303` become `GET` like in browsers, `307`/`308` keep the method and body, and a redirect away from the app is returned.

## 0.5.0

- `slicetest gen` reads the spec's security: operations that need a bearer token (`http: bearer`, `oauth2`, `openIdConnect`) get `auth:` on their requests, with the required scopes in the `scope` claim, and their 401 responses become runnable scenarios without a token.
- `slicetest init` turns on `auth` when `.env.example` names a token issuer (`OIDC_ISSUER`, `AUTH0_DOMAIN`, `JWKS_URL`, `JWT_AUDIENCE`, …), pointing those variables at slicetest's issuer instead of stubbing them, and suggests it when a JWT library is a dependency.
- `db: { queries: true }`: the app connects through a proxy that reads the Postgres or MySQL wire protocol and records the SQL it runs, whatever its language or driver. `db.queries(fn)` returns the statements run during `fn` (or the whole scenario), with `repeated()` and `shapes()` to catch N+1 queries and `withoutTransactions()` to drop `BEGIN` / `COMMIT`. Failure output lists the app's SQL, most frequent first. YAML: `expect: { queries: n }` on a `request` step.
- `stub(name).chaos({ failFirst, errorRate, statuses, networkErrorRate, latency, seed })`: inject faults into a stub's answers to test the app's retries, timeouts and fallbacks. Faulted calls don't use up `once()` routes; random faults come from a seed that failure output prints (`SLICETEST_CHAOS_SEED` replays it). `stub.faults()` lists them. YAML: a `chaos` step.
- `http.webhook(path, payload, { provider, secret })`: deliver a webhook signed the way Stripe, GitHub, Slack, Shopify or Standard Webhooks (Svix, Resend, Clerk, …) sign theirs, or with a custom HMAC header. `invalidSignature` and `stale` make deliveries the app must refuse. `signWebhook()` is exported. YAML: `webhook` on a `request` step.
- `auth: true` (or `{ audience, claims }`): an OpenID Connect issuer for apps that verify JWTs, with discovery, a JWKS and RS256 keys made per run, at `{{auth.issuer}}` / `{{auth.jwks}}` / `{{auth.audience}}`. Scenarios mint tokens with `auth.token(claims)` / `auth.header(claims)`, and tokens the app must reject with `{ expired }`, `{ wrongKey }`, `{ audience }` or `{ issuer }`. `auth.rotate()` changes the signing key. `POST /token` answers the client-credentials grant. YAML: `auth` on a `request` step.
- `db.make(table, overrides)` and `db.makeMany(table, count, overrides)`: insert rows that satisfy the schema while naming only the columns the scenario cares about. Required columns get a value of their type, enums and `CHECK (... IN (...))` columns their first allowed value, and required foreign keys a parent row made the same way. Values are numbered per scenario, so they are unique and stable across runs. Postgres, MySQL and SQLite. YAML: a `make` step with `rows` and `count`.

## 0.4.0

- `npx slicetest record`: starts the app, database and stubs with a proxy in front of the app; use the app through it (a browser, curl), press Enter, and get a YAML scenario: `stub` steps with the answers the services gave, `request` steps with the responses to expect (dates and UUIDs matched by type), captures for values later requests reuse, `received` steps and a `changes` step. Static files are left out.
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
