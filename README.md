# slicetest

[![CI](https://github.com/revo1290/slicetest/actions/workflows/ci.yml/badge.svg)](https://github.com/revo1290/slicetest/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/slicetest)](https://www.npmjs.com/package/slicetest) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Tests that sit between unit tests and end-to-end tests, for apps written in any language or framework.

slicetest starts your app as a real process, points it at a real Postgres (or MySQL) and at stub servers for the services it calls, and lets you check all three sides in one scenario:

```ts
import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("creating a poll stores it and notifies Slack", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").reply(200, "ok");

  const res = await http.post("/polls", { title: "Dogs or cats?", a: "Dogs", b: "Cats" });

  expect(res).toHaveStatus(201);
  await expect(db).toHaveRow("polls", { title: "Dogs or cats?" });
  expect(stub("slack")).toHaveReceived("POST", "/hook", { json: { text: "New poll: Dogs or cats?" } });
});
```

No browser, no mocked database, no hooks inside your app. The app only has to read its port, database URL and outbound base URLs from environment variables.

## Why

- **Unit tests** mock the database and the network, so broken SQL, migrations and request payloads slip through.
- **End-to-end tests** drive a browser against a deployed stack. They are slow and hard to make deterministic.
- **slicetest** keeps the real HTTP server, the real SQL and the real migrations, and replaces only the things you don't own: third-party APIs. With OpenAPI specs, it also checks that those replacements behave like the real thing.

The database is reset between scenarios with a single `TRUNCATE ... RESTART IDENTITY CASCADE` (about 1.5 ms). The app keeps its connections, so this works with any driver or ORM. Resetting by dropping and re-creating the database takes about 130 ms, and it crashed some apps when their pooled connections were cut.

## Quick start

```sh
npx slicetest init   # detects your stack, writes slicetest.config.yaml and a first scenario
npx slicetest        # starts Postgres, migrates, starts your app, runs scenarios/*.scenario.yaml
```

`init` recognises Node (`npm start`), Django, FastAPI, Flask, Rails, Go and Rust apps; Atlas, Prisma, Alembic, Django, Rails, Drizzle, Knex and plain SQL migrations; and an `openapi.yaml`. It lists every guess as a comment in the config so you know what to check.

## What you get that's hard to find elsewhere

- **One scenario, three boundaries.** Assert on the HTTP response, the rows in the real database and the calls to third-party APIs in the same test, in any language the app is written in.
- **`db.changes()`**: a diff of every row the scenario inserted, updated or deleted. `toEqual` on it catches writes you didn't expect.
- **Stubs that can't lie.** Give a stub the provider's OpenAPI spec, and a canned reply the real service would never send fails the test.
- **Record the real service once, replay forever.** Point a stub at the real API with `SLICETEST_RECORD=1`, commit the YAML it writes, and later runs are offline and deterministic.
- **OpenAPI coverage** of your own API, per operation and status, across all scenarios.
- **Postgres or MySQL**, with the same scenarios and the same row types on both.
- **Fast resets.** `TRUNCATE` between scenarios (about 1.5 ms) with the app still running, and a cached migrated template, so the second run skips container start-up and migrations.

## Install

```sh
npm i -D slicetest vitest
```

You also need Docker or Podman. slicetest finds a running Podman machine on its own (on Windows too). Alternatively, pass `db.url` or set `SLICETEST_DATABASE_URL` to use an existing Postgres server, for example a CI service container.

### MySQL

Set `db: { engine: "mysql" }` (or give a `mysql://` URL) and install the driver:

```sh
npm i -D mysql2 @testcontainers/mysql   # the second is only needed without db.url
```

Everything works the same: `mysql:8.4` in a container, a migrated template cloned per worker (tables, foreign keys, views and triggers; stored routines are not copied), a `TRUNCATE` reset that only touches tables that were written to, and `db.*` helpers whose rows look like Postgres's (`BOOLEAN` as `true`/`false`, `BIGINT` ids as numbers, `DATETIME` in UTC). Only the SQL you write yourself differs: `?` placeholders in `db.query` and YAML `sql` steps. `db.schemas` defaults to the database in the URL. `SLICETEST_DATABASE_URL` is only used by projects on the same engine as its scheme, so a CI job can provide one Postgres server while a MySQL project starts its own container.

Works on macOS, Linux and Windows. On Windows the app's process tree is stopped with `taskkill /T`, and `app.command` / `db.migrate.command` run through `cmd.exe`.

## Configure

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { slicetest } from "slicetest/vitest";

export default defineConfig({
  plugins: [
    slicetest({
      app: {
        command: "python server.py", // any language
        env: {
          PORT: "{{app.port}}",
          DATABASE_URL: "{{db.url}}",
          SLACK_WEBHOOK_URL: "{{stub.slack}}/hook",
        },
        ready: { path: "/health" }, // or { log: "listening" }
      },
      db: {
        migrate: { atlas: { dir: "file://migrations" } }, // or { sql: "schema.sql" } / { command: "npm run migrate" }
        seed: "seed.sql", // re-applied after every reset
      },
      stubs: ["slack"],
    }),
  ],
  test: { include: ["scenarios/**/*.test.ts"] },
});
```

### How a run works

1. **Once per run.** slicetest starts `postgres:17-alpine` and migrates a template database. Locally, the container is kept running and the migrated template is cached by the contents of your migrations, so the next run with unchanged migrations skips both steps (see `db.reuse`).
2. **Once per worker.** It clones the template into the worker's own database.
3. **Once per test file.** It starts the stub servers, your `services` and your app.
4. **Before each scenario.** It truncates every table except migration bookkeeping tables (`atlas_schema_revisions`, `_prisma_migrations`, `alembic_version`, `django_migrations`, …) and extension-owned tables such as PostGIS's `spatial_ref_sys`, re-runs the seed, and clears the stubs, cookies and request history. If the app or a service crashed in the previous scenario, it is restarted.
5. **After each scenario.** The scenario fails if the app or a service crashed, the app called a stub route you didn't register, or (with `openapi`) any traffic didn't match the spec.

Database names are unique per run, so several projects or CI jobs can share one Postgres server via `db.url`.

### When a scenario fails

slicetest prints what happened during that scenario, next to Vitest's own error:

```
--- slicetest ---
stub calls with no matching route:
  mail: POST /send
    registered on mail: POST /other

requests to the app:
  POST /signup → 500 (14ms)  {"error":"internal"}

database changes during this scenario:
  users: 1 inserted
    + {"id":1,"email":"a@example.com","verified":false}
  audit_log: 1 updated
    ~ id=7  status: "pending" → "failed"

app output during this scenario:
TypeError: Cannot read properties of undefined (reading 'email')
-----------------
```

Only this scenario's app output is shown, not the whole log. The database section is a diff against the state right after the reset and seed, so you see what the app actually wrote. Requests that never got a response (for example because the app crashed) appear as `failed`.

## API

Every scenario receives `{ http, db, stub, app, service }`.

### `http` — talk to the app

```ts
const res = await http.post("/polls", { title: "x" });   // objects are sent as JSON
res.status; res.headers; res.text; res.json; res.durationMs;

await http.get("/polls", { query: { page: 2 }, headers: { accept: "text/html" } });
await http.post("/login", http.form({ user: "a", pass: "b" }));  // urlencoded; FormData, Blob and bytes also work
await http.get("/old-path", { follow: true });                    // redirects are NOT followed by default

const admin = http.with({ headers: { authorization: `Bearer ${token}` } }); // shares cookies with http
http.cookies.get("session");                                     // cookies persist within a scenario
```

Requests may only go to the app under test; absolute URLs to other hosts are rejected. Defaults for every request can be set with `http: { headers }` in the plugin config.

### `db` — arrange and inspect the real database

```ts
await db.insert("users", [{ name: "a" }, { name: "b" }]);          // returns the stored rows
const user = await db.one("users", { email: "a@example.com" });    // throws unless exactly one row
await db.rows("votes", { poll_id: [1, 2], deleted_at: null }, { orderBy: "-id", limit: 10 });
await db.count("votes", { choice: "a" });
await db.sql`SELECT * FROM users WHERE id = ${user.id}`;          // values become bind parameters
await db.query("UPDATE users SET name = $1", ["b"]);
```

In `where`, `null` means `IS NULL` and an array means `IN (...)`.

#### `db.changes()` — assert on everything the app wrote

Instead of guessing which tables to query, ask for the diff. Rows are matched by primary key, so updates show which columns changed:

```ts
await db.insert("users", { email: "a@example.com" });
await db.checkpoint();                                   // ignore what the test itself arranged

await http.post("/users/1/verify");

expect(await db.changes()).toEqual({
  users: { inserted: [], deleted: [], updated: [expect.objectContaining({ changed: ["verified"] })] },
  audit_log: { inserted: [expect.objectContaining({ action: "verify" })], updated: [], deleted: [] },
});
```

`toEqual` fails if the app wrote to a table you didn't list, which catches unexpected side effects. Each entry in `updated` has `key`, `before`, `after` and `changed`. Tables without a primary key report an update as one deleted row plus one inserted row. `bigint` columns (bigserial ids, `count(*)`) come back as numbers when they fit safely.

### `stub(name)` — fake the services the app calls

```ts
stub("github").on("GET", "/repos/:owner/:repo").reply((call) => ({ body: { name: call.params.repo } }));

stub("stripe")
  .on("POST", "/v1/charges", {
    query: { expand: "customer" },
    headers: { authorization: /^Bearer / },
    json: { amount: expect.any(Number) },   // subset match; asymmetric matchers and RegExps work anywhere
  })
  .reply(200, { id: "ch_1" });

stub("slack").on("POST", "/hook").once().reply(500);          // first call fails, then falls through…
stub("slack").on("POST", "/hook").reply(200);                 // …to this route: test your retry logic
stub("pay").on("GET", "/status").replySequence([{ status: 503 }, { status: 200 }]);
stub("pay").on("POST", "/charge").delay(5_000).reply(200);    // exercise the app's timeouts
stub("pay").on("POST", "/charge").networkError();             // drop the connection

stub("slack").calls("POST", "/hook");                         // recorded calls: method, path, params, query, headers, body, json
```

Later routes win. `path` may also be a RegExp, and `method` may be `*`. Unanswered calls get a `501` and fail the scenario.

### OpenAPI contracts — for your app and for the services you stub

Point slicetest at OpenAPI 3.0 / 3.1 files and every scenario doubles as a contract test, with no extra assertions:

```ts
slicetest({
  openapi: "openapi.yaml",                                       // your app's spec
  stubs: ["slack", { name: "stripe", openapi: "specs/stripe.yaml" }], // a provider's spec
  // ...
});
```

- **Your app's responses** must be documented (path, method, status) and match the schema.
- **The app's requests to a stub** must match the provider's spec: required query parameters, content type and request body. Spec paths are matched with or without the server's base path (`/v1`).
- **Your stubs' replies** must be something the real service could send. A stub that returns `200 { ok: true }` where the provider documents `202 { messageId }` makes tests pass against an API that doesn't exist; slicetest fails the scenario instead.

```
slicetest: traffic doesn't match the OpenAPI spec:
  app: GET /users/{id} → 200: /id must be integer
  app → mail: POST /mail/send request: body must have required property 'subject'
  stub mail reply (the real service wouldn't answer this way): POST /mail/send responded 200, which specs/mail.yaml doesn't document (documented: 202)
```

#### `autoReply`: stubs generated from the provider's spec

Add `autoReply: true` to a stub with a spec, and calls that no route matches are answered with the provider's documented example, or with values built from the schema (formats such as `email` and `date-time`, enums, `minimum`, `allOf` are respected). Register routes only for what a scenario cares about; a registered route always wins.

```ts
stubs: [{ name: "stripe", openapi: "specs/stripe.yaml", autoReply: true }],
```

Calls answered this way have `call.fallback === true`. Paths that aren't in the spec still get a 501 and fail the scenario.

At the end of the run, slicetest prints which documented responses your scenarios actually produced, merged across workers and across TypeScript and YAML scenarios:

```
slicetest: OpenAPI coverage (openapi.yaml): 8/9 documented responses (89%)
  GET    /health            200 ✓
  POST   /polls             201 ✓  400 ✓  502 ✓
  GET    /polls/{id}        200 ✓  404 ✗
  POST   /polls/{id}/votes  204 ✓  400 ✓  404 ✓
```

To fail the run below a threshold, use `openapi: { spec: "openapi.yaml", minCoverage: 100 }`. Filtered runs (`-t`, a single file) count too, so you may want `minCoverage: process.env.CI ? 100 : undefined`.

The example apps in `examples/` run every scenario against `examples/openapi.yaml` with `minCoverage: 100`, and their Slack calls against `examples/slack.openapi.yaml`.

### Recording a real service

A stub can also answer from recordings of the real service, the way VCR or Polly do, except that it works for an app in any language because the stub is a server. Give it the real base URL:

```ts
stubs: [{ name: "github", upstream: "https://api.github.com" }],
```

Record once, with real credentials in the app's environment:

```sh
SLICETEST_RECORD=github npx vitest     # or SLICETEST_RECORD=1 for every stub with an upstream
```

Calls no route matches are forwarded to `upstream` (under its path prefix, headers included) and the answers are written to `recordings/github.yaml` (`recordings:` changes the path). Later runs replay them without touching the network. A request is identified by method, path, query and body (JSON key order doesn't matter); identical requests replay their recordings in the order they were made. Only `content-type`, `location`, `retry-after`, `link` and `etag` response headers are kept, and request headers are never stored, so tokens stay out of the file; bodies are stored as sent, so review the file before committing it.

Precedence is: registered route, then recording, then `autoReply`, then a 501 that says how to record the call. Replayed calls have `call.fallback === true`, and are checked against the provider's spec when the stub has one. To refresh recordings, delete the file (or the entries) and record again.

### Matchers

Registered automatically:

```ts
expect(res).toHaveStatus(201);                                   // failure shows the response body
expect(stub("slack")).toHaveReceived("POST", "/hook", { json: { text: "hi" } });
expect(stub("slack")).toHaveReceivedTimes(1, "POST", "/hook");
expect(stub("mail")).not.toHaveReceived("POST", "/send");
await expect(db).toHaveRow("polls", { title: "x" });             // at least one row
await expect(db).toHaveRow("votes", { poll_id: 1 }, 3);          // exactly three
```

Failure messages list the calls the stub actually received, or the first rows of the table.

### Services: workers and other processes

Real apps are rarely one process. Declare the others under `services` and slicetest starts them before the app (in order), watches them like the app, and restarts one that crashed — on the same port, so URLs handed to other processes stay valid:

```ts
slicetest({
  services: {
    pricing: { command: "go run ./cmd/pricing", ready: { path: "/health" } }, // another HTTP service
    worker: { command: "bundle exec sidekiq" },                                 // no port, no ready check
  },
  app: {
    command: "node server.js",
    env: { PORT: "{{app.port}}", DATABASE_URL: "{{db.url}}", PRICING_URL: "{{service.pricing}}" },
  },
});
```

Each service gets `PORT` = `{{service.<name>.port}}` and `DATABASE_URL` unless you pass `env`. A crash fails the scenario, and each service's output during the scenario is part of the failure output.

```ts
scenario("uploading an image queues a thumbnail job", async ({ http, db, service }) => {
  await http.post("/images", { url: "https://example.com/cat.png" });

  await service("worker").waitForLog(/thumbnail \d+ done/);   // this scenario's output only
  await expect(db).toHaveRow("images", { thumbnail_ready: true });
});
```

`waitForLog(pattern, timeout = 5000)` resolves with the matching line and also works on `app`. In YAML: `- log: thumbnail \d+ done` with `from: worker` and `within: <ms>`.

### Asynchronous side effects

If the app does work in the background (a job queue, a fire-and-forget webhook), wait for the effect with Vitest's own helpers. slicetest doesn't need its own:

```ts
await vi.waitFor(() => expect(stub("mail")).toHaveReceived("POST", "/send"));
await expect.poll(() => db.count("jobs", { status: "done" })).toBe(1);
```

In YAML, add `within: <ms>` to a `db`, `sql`, `received` or `changes` step.

### Scenarios

```ts
scenario("name", async ({ http, db, stub, app }) => { ... }, timeoutMs?);
scenario.only / scenario.skip / scenario.todo
scenario.each([{ choice: "a", status: 204 }, { choice: "x", status: 400 }])(
  "voting $choice returns $status",
  async ({ choice, status }, { http }) => { ... },
);
```

Scenarios in one file share an app and a database, so they always run one at a time; `.concurrent` is rejected.

### Configuration reference

| Option | Default | |
|---|---|---|
| `app.command` | (required) | Shell command. May use `{{app.port}}` and the other placeholders. |
| `app.env` | `{ PORT, DATABASE_URL }` | Values may use `{{app.port}}`, `{{db.url}}`, `{{stub.<name>}}`. The rest of `process.env` is inherited. |
| `app.cwd` | vitest root | |
| `app.ready` | `{ path: "/" }` | Poll a path until it answers below 500, or `{ log: "listening" \| /regex/ }`. |
| `app.readyTimeout` | `30000` | |
| `db.engine` | `postgres`, or `mysql` for a `mysql://` URL | `postgres` or `mysql` (see [MySQL](#mysql)). |
| `db.migrate` | none | `{ atlas: { dir } }`, `{ sql: "file-or-dir" }` or `{ command, inputs? }` (gets `DATABASE_URL`). |
| `db.seed` | none | SQL file re-run after every reset. |
| `db.schemas` | `["public"]` | Schemas whose tables are reset. |
| `db.keep` | `[]` | Extra tables (`name` or `schema.name`) never truncated. |
| `db.url` | `$SLICETEST_DATABASE_URL`, else a container | Use an existing Postgres server (e.g. a CI service container) instead of Testcontainers. |
| `db.image` | `postgres:17-alpine` / `mysql:8.4` | |
| `db.reuse` | on, unless `CI` is set or `db.url` is given | Keep the container between runs and cache the migrated template. The cache key is the migration files' contents; for `{ command }`, list what it reads in `inputs: ["prisma/migrations"]`, or it migrates every run. Databases left by killed runs are dropped after a day. Remove the container (`docker rm -f` / `podman rm -f`) to start clean. |
| `services` | `{}` | Other processes: `{ name: { command, env?, cwd?, ready?, readyTimeout? } }`. Without `ready` a service is not waited for. |
| `stubs` | `[]` | Names of stubbed services, or `{ name, openapi?, autoReply?, upstream?, recordings? }`: check calls against the provider's spec, answer from it, or [replay recordings](#recording-a-real-service) of the real service. |
| `openapi` | none | The app's OpenAPI 3 spec, or `{ spec, minCoverage }`. Every response must match it; the run ends with a coverage report. |
| `http` | `{}` | Default `headers` / `query` for every request. |

The config is validated up front: a missing `app.command`, an ambiguous `db.migrate` or a duplicate stub name fails with a clear message instead of a timeout.

## YAML scenarios

Everything above is also available as data, for teams that don't write JavaScript. Files named `*.scenario.yaml` are picked up automatically, next to your `.test.ts` files, and run with the same app, database and stubs:

```yaml
# yaml-language-server: $schema=https://unpkg.com/slicetest/schema/scenario.schema.json
scenarios:
  - name: creating a poll stores it and notifies Slack
    steps:
      - stub: slack
        on: POST /hook
        reply: { status: 200, body: ok }

      - request: POST /polls
        json: { title: Dogs or cats?, a: Dogs, b: Cats }
        expect:
          status: 201
          json: { id: { $type: number } }
        capture: { pollId: json.id }

      - db: polls
        where: { title: Dogs or cats? }
        expect:
          rows: [{ id: "{{pollId}}", option_a: Dogs }]

      - received: slack
        call: POST /hook
        times: 1
        when:
          json: { text: "New poll: Dogs or cats?" }

      - changes:                  # and nothing else was written
          polls: { inserted: 1 }

  - name: voting {{choice}} returns {{status}}
    each:
      - { choice: a, status: 204 }
      - { choice: x, status: 400 }
    steps:
      - request: POST /polls/1/votes
        json: { choice: "{{choice}}" }
        expect: { status: "{{status}}" }
```

| Step | Keys |
|---|---|
| `stub: <name>` | `on: METHOD /path` (`:params` allowed), `when: { query, headers, json, body }`, one of `reply: { status, headers, body }` / `sequence: [...]` / `networkError: true`, plus `times`, `delay`. Replies may echo the call: `{{call.params.id}}`, `{{call.json.name}}`. |
| `request: METHOD /path` | `headers`, `query`, one of `json` / `form` / `body`, `follow`, `expect: { status, headers, json, text }`, `capture` |
| `insert: <table>` | `rows`, `capture` (from `row` / `rows`) |
| `db: <table>` | `where`, `orderBy`, `expect: { rows, count }`, `capture` |
| `sql: <query>` | `params`, `expect: { rows, count }`, `capture` |
| `received: <stub>` | `call: METHOD /path`, `when`, `times` (exact; default at least once) |
| `log: <regex>` | `from` (a service; default the app), `within` (ms, default 5000). Waits for a matching line printed during the scenario. |
| `changes: { <table>: { inserted, updated, deleted } }` | Each is a count or a list of subset rows (`updated` matches the row after the update). Tables that aren't listed must be unchanged. |
| `checkpoint: true` | Later `changes` steps only see what happens after this step. |

`db`, `sql`, `received` and `changes` steps take `within: <ms>` to retry until they pass, for effects the app applies asynchronously.

- `{{name}}` inserts a captured value or an `each` field. A string that is only `{{name}}` keeps the value's type, so `id: "{{pollId}}"` compares as a number.
- Expected `json`, `rows` and `headers` are subsets: extra keys are fine. `{ $type: number }`, `{ $regex: "^ch_" }`, `{ $contains: "..." }` and `{ $any: true }` match loosely.
- A file-level `setup:` list runs at the start of every scenario. `skip`, `only` and `timeout` work per scenario.
- Mistakes are reported with the file and line before anything runs (`polls.scenario.yaml:12: unknown key "stauts" in expect`). A failing step reports its file, line and step number. The JSON Schema in `schema/` gives editors completion and inline errors.

### Without any JavaScript: `npx slicetest`

Put the plugin options in `slicetest.config.yaml` and run the CLI. It needs Node, but no `package.json` scripts, TypeScript or Vitest config:

```yaml
# slicetest.config.yaml
app:
  command: python server.py
  env: { PORT: "{{app.port}}", DATABASE_URL: "{{db.url}}", SLACK_WEBHOOK_URL: "{{stub.slack}}/hook" }
  ready: { path: /health }
db:
  migrate: { command: alembic upgrade head }
stubs: [slack]
```

```sh
npx slicetest                 # every *.scenario.yaml under the config's directory
npx slicetest polls -t voting # filter by file and scenario name
npx slicetest --watch
```

## Examples

`examples/` has a Node app (`node:http` + `pg`) and a Python app (`http.server` + `psycopg`) with the same API. **The same scenario files (`polls.test.ts` and `polls.scenario.yaml`) run against both**:

```sh
npm test            # unit tests + both example apps
npm run test:dist   # the built package, and the CLI with examples/slicetest.config.yaml
```

## Using a coding agent

[`.claude/skills/slicetest-write-tests`](.claude/skills/slicetest-write-tests/SKILL.md) teaches Claude Code (or any agent that reads skills) how to write slicetest scenarios. Copy it into your project's `.claude/skills/`. Contributors: see [`AGENTS.md`](AGENTS.md).

## Status

Early. Postgres and MySQL. CI runs on Linux and Windows.
