# Spring Boot example

The polls API of `examples/node-api` and `examples/python-api` on Spring Boot 3.5 (Java 21, Maven, plain JDBC, PostgreSQL). `../scenarios` run against it unchanged: creating a poll and the Slack call, a failed notification that leaves no poll behind, the seed and the reset between scenarios, a one-statement vote count, and a snapshot of a whole flow that is byte for byte the Node and Python one.

Needs JDK 21, Maven, Node and Docker or Podman (or `SLICETEST_DATABASE_URL`), plus the `atlas` CLI for the TypeScript run. From the repository root:

```sh
npm ci
npm run test:spring     # builds slicetest, then runs the TypeScript scenarios and the YAML ones through the CLI
```

Or one at a time:

```sh
npx vitest run --config examples/vitest.spring.config.ts
npx slicetest --config examples/slicetest.spring.config.yaml    # after `npm run build`
```

The first run builds the jar (`mvn package`, once, before the app starts) and pulls the Postgres image. If Java isn't on the `PATH`, set `JAVA_HOME`.

What to copy into your own project: the `app` block of `examples/slicetest.spring.config.yaml`. `SERVER_PORT` and `SPRING_DATASOURCE_*` override `application.properties`; `{{db.jdbcUrl}}` is the JDBC URL; the build step keeps compilation and dependency downloads out of the app start. The app reads `SLACK_WEBHOOK_URL`, which the scenarios point at a stub.

Not identical to the Node and Python apps where the shared scenarios don't look: a malformed JSON body is a 400 here (500 in the Node app), a non-string `title` is rejected here, an unknown route answers with Spring's default error body, and the Slack call runs inside the database transaction, holding a pooled connection while it waits. The pom pins Tomcat and the PostgreSQL JDBC driver above Spring Boot's defaults because their advisories (checked on OSV, 2026-10-04) are fixed only there; the app has no authentication and is an example, not a template to deploy.
