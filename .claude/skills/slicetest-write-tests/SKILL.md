---
name: slicetest-write-tests
description: Write slicetest scenarios (TypeScript or *.scenario.yaml) that drive an app over HTTP with a real Postgres and stubbed outbound APIs. Use when adding or fixing slice tests in a project that uses slicetest.
---

# Writing slicetest scenarios

slicetest runs the app as a real process against a real Postgres and stub servers. A scenario checks three boundaries: the HTTP response, the rows in the database, and the calls to third-party APIs. The full reference is the package README (`node_modules/slicetest/README.md`).

## Before writing

1. Find the config: `slicetest.config.yaml` (YAML scenarios / CLI) or the `slicetest(...)` plugin in `vitest.config.ts`. Note the `stubs`, `services` and `openapi` it declares; a scenario can only use stubs that are declared there.
2. Match the project: if it has `*.scenario.yaml` files, write YAML; if it has `*.test.ts` scenarios, write TypeScript. If it has neither, run `npx slicetest init`.
3. Read the endpoint's handler and the migration for the tables it touches, so assertions use real column names.

## TypeScript

```ts
import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("creating a poll stores it and notifies Slack", async ({ http, db, stub }) => {
  stub("slack").on("POST", "/hook").reply(200, "ok");         // arrange stubs before the request

  const res = await http.post("/polls", { title: "Dogs or cats?", a: "Dogs", b: "Cats" });

  expect(res).toHaveStatus(201);
  expect(await db.changes()).toEqual({
    polls: { inserted: [expect.objectContaining({ title: "Dogs or cats?" })], updated: [], deleted: [] },
  });
  expect(stub("slack")).toHaveReceived("POST", "/hook", { json: { text: "New poll: Dogs or cats?" } });
});
```

## YAML

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
        expect: { status: 201 }
      - changes:
          polls: { inserted: 1 }
      - received: slack
        call: POST /hook
        times: 1
```

## Guidelines

- Arrange data with `db.insert` (YAML: `insert:`), then `db.checkpoint()` (YAML: `checkpoint: true`) so `changes` only shows what the app wrote.
- Prefer `db.changes()` / `changes:` over querying single tables: it also fails on writes you didn't expect.
- Cover failure paths of outbound APIs: `.once().reply(500)` then a success route for retries, `.delay(ms)` for timeouts, `.networkError()` for dropped connections.
- For background work use `vi.waitFor` / `expect.poll` (YAML: `within: <ms>`), or `service("worker").waitForLog(/.../)` (YAML: `log:`). Never add fixed sleeps.
- Don't reset the database or clear stubs yourself; slicetest does it before every scenario. Don't use `.concurrent`.
- Every call the app makes to a stub must match a registered route (or `autoReply`), otherwise the scenario fails with a 501.
- For endpoints where two users could collide (bookings, stock, votes, payments), add a race scenario: `http.concurrently(10, ...)` plus `toHaveStatuses` and a database check (YAML: `concurrency:` with `expect.statuses`).
- When the config has `mail: true`, check the mail the app sends with `await mail.waitFor({ to, subject })` (YAML: `mail:` step) and follow `links[0]` instead of reading tokens from the database.
- If `openapi` has `minCoverage`, add scenarios for the documented statuses the coverage table marks with ✗.

## Running

```sh
npx slicetest                    # YAML scenarios via the CLI
npx slicetest polls -t voting    # filter by file and scenario name
npx vitest run                   # TypeScript scenarios via the Vitest plugin
```

When a scenario fails, read the `--- slicetest ---` block: it lists the requests, unmatched stub calls, database changes and the app's output during that scenario. Fix the cause in the app or the scenario; don't loosen assertions to make it pass.
