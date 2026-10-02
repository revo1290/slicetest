import { expect, test } from "vitest";
import { interpolate } from "../src/app.js";

test("replaces placeholders", () => {
  expect(interpolate("{{stub.slack}}/hook", { "stub.slack": "http://127.0.0.1:1" })).toBe("http://127.0.0.1:1/hook");
});

test("rejects unknown placeholders and lists the available ones", () => {
  expect(() => interpolate("{{stub.mail}}", { "app.port": "1" }, "app.command")).toThrow(
    "unknown placeholder {{stub.mail}} in app.command. Available: {{app.port}}",
  );
});

test("the database URL is also given in parts and as a JDBC URL", async () => {
  const { connectionVars } = await import("../src/runtime.js");

  expect(connectionVars("postgres", "postgres://test:p%40ss@127.0.0.1:5433/slicetest_w1?sslmode=disable")).toEqual({
    "db.host": "127.0.0.1",
    "db.port": "5433",
    "db.name": "slicetest_w1",
    "db.user": "test",
    "db.password": "p@ss",
    "db.jdbcUrl": "jdbc:postgresql://127.0.0.1:5433/slicetest_w1",
    "db.adoNet": "Host=127.0.0.1;Port=5433;Database=slicetest_w1;Username=test;Password=p@ss",
  });
  expect(connectionVars("mysql", "mysql://root:a%3Bb@localhost/app")["db.adoNet"]).toBe('Server=localhost;Port=3306;Database=app;User ID=root;Password="a;b"');
  expect(connectionVars("mysql", "mysql://root:x@localhost/app")["db.jdbcUrl"]).toBe("jdbc:mysql://localhost:3306/app");
  expect(connectionVars("sqlite", "sqlite:///tmp/a.db", "/tmp/a.db")).toEqual({ "db.jdbcUrl": "jdbc:sqlite:/tmp/a.db", "db.adoNet": "Data Source=/tmp/a.db" });
});
