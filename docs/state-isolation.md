# State between scenarios, and running in parallel

A scenario is independent of the ones before it only for the state slicetest resets. This page says which state that is, what isn't, and which settings cover the rest. The behavior below is pinned by `test/isolation.test.ts` and the scenarios in `test/fixtures/isolation/`.

## What each scenario starts from

Everything marked "reset" happens at the **start** of the next scenario, so it also applies after a scenario that failed, timed out or crashed the app.

| State | Before each scenario | Notes |
|---|---|---|
| Database rows | Reset | Every ordinary table in `db.schemas` (default `public`) is truncated with `RESTART IDENTITY CASCADE`, except migration bookkeeping tables and `db.keep`; `db.seed` runs again. Rows inserted by migrations are truncated too: put shared rows in the seed. Postgres's `CASCADE` also empties tables that reference a truncated one, in any schema and even if listed in `db.keep`. SQLite has one schema, so `db.schemas` doesn't apply. The table list is read once per test file (once per worker with `app.scope: worker`): a table the app creates while that file runs is neither reset nor diffed in it. Roles and extensions aren't touched. |
| Stubs, recordings, mail, auth issuer's token counter, query log, `hosts` bookkeeping | Reset | Routes, calls, `once()` counters, chaos, collected mail. A stub's routes registered by a failed scenario don't reach the next. A key switched with `auth.rotate()` stays rotated for the rest of the file. |
| The scenario's `http` client | Reset | Cookies and request history. |
| Extra `containers` | Reset only if `reset` is set | Without a `reset` command (`["redis-cli", "FLUSHALL"]`), what the app wrote there stays. |
| The app process | **Kept** | Unless it crashed (restarted), `restart: scenario` is set, or `idle` timed out (restarted). Anything the app holds in memory survives: caches, singletons, static fields, scheduled timers. See below. |
| `services` (workers, other APIs) | **Kept** | Same as the app; `restart`, `reset` and `idle` can be set on each service. A worker's own queue or files are not reset by slicetest. |
| Background work started by the previous scenario | **Not waited for** | slicetest can't know when your app considers a job done. Set `idle` for that. |
| Files, other stores, other processes, global resources | **Not touched** | A temp directory the app writes to, a Redis the app uses that isn't a declared container, a fixed port, an external service. Reset them yourself (`containers.<name>.reset`, a `reset` endpoint) or keep them out of the test. |

The database being reset doesn't mean the app's *view* of it is. An app that cached a query result keeps serving it after the table was emptied; an app that wrote a row late writes it into the next scenario's empty table. Both are reproduced in `test/fixtures/isolation/leak.scenario.ts`, and the default configuration fails both.

## Choosing a setting

Three settings, on `app` and on each of `services`:

```yaml
app:
  command: node server.js
  restart: scenario                  # stop the process before the reset, start it after
  reset: { path: /__test/reset }     # POST: the app drops its caches and cancels its timers
  idle:  { path: /__test/idle }      # GET: 2xx once no background work is left, else 503
```

| Setting | What it handles | Cost / limits |
|---|---|---|
| `restart: scenario` | Everything held in that process's memory: caches, singletons, pending timers, in-flight work. The process is stopped before anything is reset, so it can't write into the reset database, and it boots against the reset database and seed. | One process start per scenario. In the isolation fixture (a small Node app on SQLite) a scenario took about 85 ms with it, about 5 ms by default and about 25 ms with a `reset` endpoint, in one run on a laptop; a JVM app takes seconds to start (see [Spring Boot](../README.md#spring-boot-and-other-jvm-apps)). The boot counts toward the scenario's timeout (Vitest's `testTimeout`, 5 s by default): set it above the app's start-up time. The first scenario of a file restarts the app that was started moments before, so that boot is paid twice: a restarted app must boot against the reset database and seed, which the first start didn't have. Doesn't touch other processes (workers, queues), containers without `reset`, or files. |
| `reset: { path }` | Whatever the app's own endpoint clears. Called after the database and the other dependencies were reset, before the scenario. `path` is a path on the app (no `//`, backslash or spaces), `method` defaults to `POST`; redirects aren't followed and a status of 300 or more fails the scenario. | Only as complete as the endpoint. Work in flight at that moment can still write between the database reset and the call: for in-flight work use `idle` or `restart`. The endpoint must exist only in test configuration (check an environment variable), never in production. |
| `idle: { path, timeout }` | Late writes: polled after each scenario until it answers 2xx, so work started by a scenario finishes inside that scenario. After `timeout` (default 5000 ms, at most 600000), or the time the test's own timeout leaves, every process that is still busy fails the scenario together and is restarted before the next one. If a scenario failed or timed out before this ran, the next scenario asks each such process once and restarts those still busy. | Waits for background work; it doesn't clear caches. The app has to report its own pending work. Don't use a fixed sleep as the completion condition. |

What each covers. The cache and delayed-write columns are tested (`test/isolation.test.ts`); that `restart` and `idle` also apply to a service, restarting every busy process once, is tested with a busy app and a busy worker; the other cells follow from the design:

| | Cache in the app | Delayed in-process write | Worker or queue in another process | Files |
|---|---|---|---|---|
| default | ✗ | ✗ | ✗ | ✗ |
| `restart: scenario` | ✓ | ✓ | only for a `service` that has it too | ✗ |
| `reset` | ✓ if the endpoint clears it | ✓ if it cancels it | only for a `service` that has it | ✗ |
| `idle` | ✗ | ✓ | only for a `service` that has it | ✗ |
| `reset` + `idle` | ✓ | ✓ | only for a `service` that has them | ✗ |

Order of what happens around a scenario:

1. If the previous scenario failed or timed out before its `idle` check, ask each such process once whether it is idle; those that aren't are restarted in step 2.
2. Stop the processes that are to restart: the app first, then services in reverse order.
3. Reset the database and seed, stubs, recordings, mail, the auth issuer, the query log, intercepted-host bookkeeping, containers with `reset`, and the `http` client.
4. Start the stopped processes: services in order, on their old ports, then the app.
5. Call each `reset` endpoint.
6. Run the scenario.
7. Check that the app and services are alive, wait for `idle`, then check unmatched stub calls, OpenAPI mismatches and the other after-scenario failures.

A process that crashed in the previous scenario goes through steps 2 and 4 like any other restart, so it now boots against the reset database; before, it was restarted ahead of the reset.

If the app can run only one instance (a fixed port, a lock file), `restart` works but anything outside the process still has to be cleared by you.

### Waiting for background work inside a scenario

For a job the scenario itself needs to see finished, wait for the effect: `expect.poll(() => db.count("jobs", { status: "done" })).toBe(1)`, `vi.waitFor(...)`, `service("worker").waitForLog(/.../)`, or `within:` in YAML. `idle` is the safety net for work a scenario didn't wait for.

## Scenario order

With the reset in place, scenarios in a file give the same result in file order and in a shuffled order: `test/fixtures/isolation/order.scenario.ts` runs four scenarios that each leave rows, a cookie, a stub route and a cached count behind, in file order and with three seeded shuffles (`--sequence.shuffle.tests --sequence.seed=N`). With the default process reuse and an app that caches, the same file fails from the second scenario on, which is the intended signal: that suite depends on order.

## Running in parallel

Three different things are called parallel:

| Level | Supported | What it means |
|---|---|---|
| Requests at the same time inside one scenario (`http.concurrently(n, …)`, YAML `concurrency: n`) | Yes | They share the scenario's app, database and stubs on purpose: it's how races are tested. They are released together; the order they reach the app in isn't controlled, so a pass shows the app handled this interleaving, not that no race exists. |
| Test files at the same time (Vitest workers) | Yes | Each worker has its own database, cloned from the migrated template; each file has its own stubs, mail server, issuer, containers and services, and its own app process (or one per worker with `app.scope: worker`). `workers` caps how many. |
| Scenarios of one file at the same time (`.concurrent`, `sequence.concurrent`) | No | They share one app, one database and one set of stubs, so each scenario is refused with `scenarios share one app and database per file, so they can't run concurrently`. |

Who owns what when files run in parallel:

| Resource | Owner |
|---|---|
| Database | One per Vitest worker (unique name per run), reset between scenarios. Several projects or CI jobs can share one Postgres server through `db.url`. |
| Stub servers, mail server, auth issuer, query-log proxy, intercepting proxy | One set per test file (per worker with `scope: worker`), on free ports. |
| App and `services` processes | One per test file, or per worker with `scope: worker`; ports chosen at start. |
| Extra `containers` | One per test file (per worker with `scope: worker`). |
| The database server, the migrated template | Shared, read-only once built. |
| OpenAPI coverage, recordings, API usage | Written per test file and merged when the run ends. |
| Anything outside slicetest: a hard-coded port, a file path, a database or queue the app names itself, an external service | Shared by every worker. Parallel files will collide there; give each worker its own, or run with `workers: 1`. |

What is tested for parallel files: with two workers and two files running at once (each waits for the other's marker before asserting), each file sees only its own rows, its own stub calls and its own app process; with one worker, the same pair runs one after the other. Containers, the mail server and the issuer are separate instances per file by construction; there is no concurrent regression for them yet.
