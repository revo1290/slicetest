# What slicetest's checks do and don't guarantee

Each check below catches a defined kind of mistake. None of them proves the app is correct. For every one: what it catches, an example, and what it can't catch, with an example. This is read from the implementation (`src/openapi.ts`, `src/recording.ts`, `src/db.ts`, `src/trace.ts`) and its tests, not measured on real projects.

## OpenAPI: your app's responses

With `openapi: openapi.yaml`, every response the app gives to `http` during a scenario is checked against the spec.

| Catches | Can't catch |
|---|---|
| A status the spec doesn't document for that operation (`GET /polls/{id} responded 500, which openapi.yaml doesn't document`). | A response with the right shape and the wrong value: `{ "total": 100 }` where it should be `120` passes if `total` is a number. |
| A JSON body that breaks the schema: wrong type, missing required property, enum mismatch (`/id must be integer`). | Extra fields, unless the schema says `additionalProperties: false`: JSON Schema allows them by default. |
| A content type the response doesn't list. | Response headers. Only the body and its content type are checked. |
| A path or method that isn't in the spec at all. | A body that isn't JSON (HTML, CSV, files): only its content type is compared. A response without a content type isn't held to a body schema. |
| | A spec that is wrong or incomplete. The check compares the app with the spec; if both are wrong the same way, it passes. A spec the app generates for itself (`openapi.fromApp`) often misses error responses and nullable fields, which shows up as failures, but it can also describe a bug as the contract. |

## OpenAPI: the services you stub

With `stubs: [{ name, openapi }]`, the app's calls to the stub and the stub's replies are checked against the provider's spec. What this gives is narrower than a stub that can't lie: **a reply you wrote can't contradict what the spec documents**.

| Catches | Can't catch |
|---|---|
| A stub reply with a status or body the spec doesn't document (`200 { ok: true }` where the spec documents `202 { messageId }`). | The real provider behaving differently from its published spec: undocumented errors, outdated spec, fields it stopped sending. |
| A required query parameter the app didn't send; a missing required body; a body that breaks the request schema; a wrong request content type. | Required request headers (authorization), path and cookie parameters: only query parameters and the body are checked. |
| An operation that isn't in the spec (the call fails the scenario). | Whether the values make sense to the provider: a well-formed `customer: "cus_nope"` that doesn't exist, a currency it doesn't support, rate limits, idempotency. |
| | A stub reply without a content type: its body isn't compared. |

`autoReply` answers calls from the spec's examples or values built from its schemas. Those are valid per the spec, not necessarily what your code needs: register routes for the replies a scenario depends on.

## Recording and replay

A recorded stub replays what the real service answered **at the time of recording**, for requests identical in method, path, query and body. Credential-named values (`api_key`, `password`, …) are redacted before the comparison, so requests that differ only in those match.

| Catches | Can't catch |
|---|---|
| The app's request changed: no recording matches, the call gets a 501 (unless `autoReply` answers from the spec instead) and the scenario fails with a hint to record again. | The real service changing after the recording: a renamed field, a new error, a removed endpoint. Replays are offline, so nothing notices. |
| Replies that contradict the provider's spec, when the stub also has one. | Recordings that were never right: recorded with a wrong account, a sandbox that behaves unlike production. |
| | Secrets stored in places the redaction doesn't look at. Request headers are never stored and well-known credential names in the query or body become `[redacted]`; everything else is stored as sent. Review the file before committing it. |

To keep recordings honest, re-record on a schedule (delete the entries, run once with `SLICETEST_RECORD`) and review the diff, or check the real service with a separate contract test. slicetest doesn't do either on its own.

## `trace()` and snapshots

`expect(await trace()).toMatchSnapshot()` pins the requests to the app and their responses, the calls to stubs with the replies' statuses, the mail, and the database changes, with dates and UUIDs masked (the exact fields are below).

| Catches | Can't catch |
|---|---|
| A change in what the trace holds, as a diff in review: a new outbound call, a different status or response body, an extra row, a column written differently. The trace has, per request to the app: method, path and query, status and response body; per stub call: method, path and query, request body and the reply's status; the mail; the database changes. | Whether the pinned behavior is right. A snapshot records what the app does today, bugs included; the first run and every `-u` accept whatever it shows. |
| | Anything not in the trace: request bodies and headers sent to the app, response headers (a cookie attribute), reply bodies and headers of a stub, logs, files, other stores. Only the last 20 requests to the app are kept. Masked values (dates, UUIDs) aren't checked. |

A snapshot update is a change to what the tests expect, so review it like a change to an assertion. The same goes for scenarios produced by `slicetest gen` and `slicetest record`: they start from the spec or from what the app did, so a misunderstanding in either is copied into the expected values.

## `db.changes()`

A diff of the database between the start of the scenario (after reset and seed, or the last `checkpoint()`) and now, matched by primary key.

| Catches | Can't catch |
|---|---|
| A write to a table the test didn't list, when asserted with `toEqual`; which columns an update changed. | A row written and deleted again inside the scenario: it's a net diff, only the end state counts. |
| An insert that should have happened and didn't. | Tables outside `db.schemas` (default `public`), tables in `db.keep`, migration bookkeeping tables, and columns in `db.ignoreChanges` / `ignore`. |
| | Tables the app creates while a test file runs: the table list is read once per test file (per worker with `app.scope: worker`), so such a table is neither reset nor diffed in that file. |
| | Writes to anything but the database: Redis, files, a queue. |
| | Reads. A query that returns the wrong rows changes nothing. |

A table without a primary key reports an update as one deleted row plus one inserted row.

## OpenAPI coverage

The report counts **documented responses of your app's spec**: each `METHOD /path` + status key the spec lists (`200`, `404`, `4XX`, `default`) is covered when a scenario's `http` request got a response that falls under it, crediting only the most specific key: the exact status, else `4XX`, else `default`. A 404 on an operation that documents both `404` and `default` covers `404` only. The percentage is covered keys over all keys in the spec.

| Counts | Doesn't count |
|---|---|
| A `404` on `GET /polls/{id}` that some scenario produced. | Lines or branches of your code, or business rules. 100% means every documented response was seen once, not that the behavior behind each was tested. |
| | How many different inputs reached a response, or whether the scenario that produced it asserted anything about it. |
| | Responses to requests that didn't go through the scenario's `http` client, and undocumented responses (those fail the scenario instead). |

A run filtered by file, `-t`, `--tag` or a shard prints its coverage marked as partial and doesn't enforce `minCoverage`.

## Unexpected stub calls and unused routes

| Catches | Can't catch |
|---|---|
| A call to a stub that no registered route (or recording, or `autoReply`) answers: the scenario fails with the closest route and why it differed. | A call the app should have made and didn't, unless a route is registered and `strictStubs` is on (or `toHaveReceived` is asserted). |
| With `strictStubs`, a registered route the app never called. | Calls to hosts no stub covers, unless `offline: true` refuses them. A client that ignores proxy settings goes around `hosts` and `offline`. |

## Tests written by an AI agent

An agent that misreads a requirement tends to misread it in the code and in the test, and the test passes. Contract checks and snapshots don't catch that: they compare the app with the spec and with itself. Before merging generated scenarios:

- Review the expected values against the acceptance criteria, not against the app's output.
- Treat snapshot updates (`-u`) and `gen` / `record` output as code changes to be reviewed.
- Prefer assertions on what the requirement states (`db.changes()` with the exact rows, `toHaveReceived` with the exact payload) over `toMatchSnapshot` alone.
