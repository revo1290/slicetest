# slicetest against JUnit + Testcontainers + WireMock

The same checks on the same app, written both ways, with the numbers and the failure output kept. **This page gives no verdict.** It is one machine, one small app and two test suites written by the same author (the maintainer's tooling, not a Spring specialist's), so it shows what can be measured and what the raw data looks like, not which approach is better. Raw data: [`results/`](results/).

## What is compared

| | A | B |
|---|---|---|
| Tests | JUnit 5, `@SpringBootTest(RANDOM_PORT)` (real HTTP), Testcontainers PostgreSQL, WireMock 3.13.2 | slicetest 0.9.0 + Vitest 5.0.2 |
| App | `../spring-boot-api` inside the test JVM | the same app, built as a jar and started as a process |
| Database | `postgres:17-alpine`, the migration in `../migrations`, `TRUNCATE … RESTART IDENTITY` and `../seed.sql` before each case | the same image, migration and seed; the reset is slicetest's |
| Outbound stub | WireMock (`http2PlainDisabled`) | slicetest stub |
| Code | `../spring-boot-api/src/test/java/example/polls/` | `slicetest/polls-comparison.test.ts`, `vitest.config.ts` |

Cases (the same assertions on both sides; the DB side of each case is "exactly these rows changed", which is `db.changes()` for B and a hand-written snapshot diff for A):

| ID | Case |
|---|---|
| C1 | Creating a poll: 201, exactly one `polls` row and nothing else changed, Slack called once with the exact text |
| C2 | Slack answers 500: 502, nothing changed, Slack was called once |
| C3 | Slack drops the connection: 502, nothing changed |
| C4 | A poll without options: 400, nothing changed, Slack not called |
| C5 | Voting `a` and `b`: 204 twice, exactly two `votes` rows |
| C6 | Invalid choice: 400; unknown poll: 404; nothing changed |
| C7 | The aggregate counts each choice |
| C8 | Ten simultaneous votes: all 204, ten rows |
| C9 | Every case starts from the seed (random order: it checks the reset whenever it runs after a case that leaves rows behind) |

Not compared: the duplicate-request and state-residue cases of the plan this work started from (not in the repository). This app has no idempotency rule and keeps no in-memory state, so there is nothing to compare; slicetest's own state-isolation tests are in [`docs/state-isolation.md`](../../docs/state-isolation.md). Also not in the common set: slicetest-only checks (OpenAPI contract, SQL statement counts, `trace()` snapshots, which `../spring-boot-api` is checked with in `../scenarios`). A has no equivalent without more libraries, and none was added.

## Run it

```sh
# B
npx vitest run --config examples/comparison/vitest.config.ts

# A (Podman: point Testcontainers at its socket; with Docker, neither variable is needed)
cd examples/spring-boot-api
DOCKER_HOST=unix://$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}') TESTCONTAINERS_RYUK_DISABLED=true mvn test

# Both, many times, and the fault injection
node examples/comparison/measure.mjs          # COLD=3 WARM=20 by default; writes results/<date>-measure.json
node examples/comparison/diagnose.mjs         # writes results/<date>-diagnose.json
```

Needs JDK 21, Maven, Node, Podman or Docker, and the dependencies already downloaded (see below). The two test commands work with either container runtime; the scripts don't: they call `podman machine inspect`, `measure.mjs` also macOS's `sw_vers`, and both default `JAVA_HOME` to Homebrew's `openjdk@21`.

## Setup measured (2026-10-04)

| | |
|---|---|
| Machine | Apple M5, 10 cores, 16 GiB, macOS 26.6.2 (arm64); Podman 5.8.2 client / 5.7.1 machine with 4 CPUs and 3814 MiB |
| Load | Other work was running: the 1, 5 and 15 minute load averages at the start were 9.3, 7.4 and 6.5 on 10 cores. Nothing was stopped. |
| Versions | Spring Boot 3.5.16 (with Tomcat 10.1.60 and the PostgreSQL JDBC driver 42.7.12 pinned in the pom, newer than its defaults), Testcontainers (Java) 1.21.4, WireMock 3.13.2, JDK 21.0.11, Maven 3.9.12, Node 24.13.0, Vitest 5.0.2, slicetest 0.9.0 with the uncommitted changes of this branch |
| Workers | A: one JVM, one test class, run serially. B: `workers: 1`. |
| Warm | Maven's local repository and the `postgres:17-alpine` image already on the machine; the Podman machine already running. **Image pulls and dependency downloads are not measured.** |
| Order | Every run is shuffled with a recorded seed (A: `junit.jupiter.execution.order.random.seed=i`, B: `--sequence.shuffle.tests --sequence.seed=i`, `i` = 1…20). A and B alternate run by run. |
| Reuse | A starts a new container each run (Testcontainers' reuse is opt-in and off). B has two settings: `reuse off` (a new container and a migration each run, which is what CI does) and slicetest's local default, `reuse on` (the container and the migrated template are kept). |
| Time | Wall clock of the whole command, including JVM / Node start. B's includes its `mvn package` (incremental after the first run); A's includes Maven's compile and surefire. |
| Cold | `spring-boot-api/target` removed first. |

## Results

Wall-clock seconds. n is small and the machine was busy: read these as ranges, not as ratios.

| Run | n | Median | Min – max | Failed runs |
|---|---|---|---|---|
| A cold | 3 | 5.48 | 5.34 – 5.56 | 0 |
| A warm | 20 | 5.01 | 4.63 – 5.55 | 0 |
| B cold, reuse off | 3 | 4.14 | 3.98 – 4.40 | 0 |
| B warm, reuse off | 20 | 4.00 | 3.62 – 5.18 | 0 |
| B warm, reuse on | 20 | 3.35 | 3.08 – 3.62 | 0 |

All 66 runs passed all 9 cases, with 20 different shuffle seeds per side. That is the evidence for "no flaky failure seen in these runs", nothing more: 20 runs can't rule out a rare failure, and no percentile is claimed. The two sides don't do the same work: A runs the app inside the test JVM, B starts it as a process and talks to it over HTTP from Node, so the difference is not "the cost of slicetest".

### Code and setup

Non-blank, non-comment lines (imports included), counted by `measure.mjs`:

| | Environment and helpers | Cases |
|---|---|---|
| A | `ApiTestEnvironment.java` 107 | `PollsApiTest.java` 94 |
| B | `vitest.config.ts` 29 | `polls-comparison.test.ts` 55 |

A also needs five test-scope dependencies in `pom.xml` and a `junit-platform.properties` (random order). B's config includes how to build and start the app and map its environment variables, which A doesn't need because the app runs in the JVM. Fewer lines are not a better test: the A helper is where the DB snapshot diff, the container, the reset and the concurrency helper live, and a team that already has them pays nothing for them.

### What went wrong while setting each side up

Recorded from the maintainer's notes of the session (only the `http2PlainDisabled` line is also in the code); none of it is in the data. Both sides were written by the same author, so this is not a measure of how long a newcomer needs.

- **A.** Testcontainers needed `DOCKER_HOST` pointed at Podman's socket and Ryuk disabled. The first run failed two cases with `I/O error on POST request … Received RST_STREAM: Stream cancelled`: the app's JDK `HttpClient` offers an h2c upgrade that WireMock's server mishandles; `http2PlainDisabled(true)` fixed it.
- **B.** The first config used `examples/` as its root, so slicetest also picked up the YAML scenarios there (one failed for lack of `db.queries`). Moving the root to `comparison/` fixed it. The Spring app itself needed no change for either side.

## Fault injection

Six faults, applied to a copy of the app (`mutations/mutations.json`), each run through both suites. A fault counts as detected only when a named case fails; a build or start-up error stops the harness instead.

| Fault | A fails | B fails |
|---|---|---|
| M1 the notification runs after the commit: a failed Slack call keeps the poll | C2, C3 | C2, C3 |
| M2 creating a poll also writes a stray vote | C1 | C1 |
| M3 the Slack text loses the options | C1 | C1 |
| M4 Slack is called twice | C1 | C1 |
| M5 the aggregate swaps `a` and `b` | C7 | C7 |
| M6 a vote for an unknown poll answers 204 instead of 404 | C6 | C6 |

Both detect all six, at the same cases. What differs is what the failure output shows (the full output of each is in `results/`):

| Fault | A | B |
|---|---|---|
| M1, M2 | The names of the tables that changed (`Expecting empty but was: ["polls"]`, `["polls", "votes"]` vs `["polls"]`). | The rows: each inserted row with its columns, per table. |
| M4 | `Expected exactly 1 requests matching the following pattern but received 2`, with the pattern. | The same count, then every call the stub received, with its body. |
| M3 | `No requests exactly matched. Most similar request was:` with the expected and the closest actual request side by side. | The calls the stub received, with their bodies. |
| M5, M6 | The expected and actual value (`expected: 404 but was: 204`). | The same, plus the response body (M6) or a diff of the JSON (M5). |

Some of this is the author's A helper, not Spring's tooling: A's snapshot helper reports table names because that is what the case asserts, and could print rows. What was **not** measured: the time a person needs to find the cause from either output, and whether knowing the faults in advance (the same author wrote the faults, the suites and this page) changes it. That needs people who didn't write them.

## What this doesn't show

- Whether either approach is faster, cheaper to maintain or more stable on other apps, machines or team sizes. One app, one machine, 20 runs.
- Anything about maintenance when the API changes: no such change was made and compared.
- First-time setup effort for someone who didn't write both suites, or setup with images and dependencies not yet downloaded.
- The effect of the machine being busy: the load was not controlled.
- B in a project that already has A: the table above is what each costs to have, not what B adds to a team that already runs A.
