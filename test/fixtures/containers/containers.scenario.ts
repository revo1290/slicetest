import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("the app reaches a container through {{container.<name>}}", async ({ http, container }) => {
  expect((await http.post("/hits")).json).toEqual({ hits: 1 });
  expect((await http.post("/hits")).json).toEqual({ hits: 2 });
  expect((await container("cache").exec(["redis-cli", "GET", "hits"])).trim()).toBe("2");
});

scenario("reset empties the container before the next scenario", async ({ http }) => {
  expect((await http.post("/hits")).json).toEqual({ hits: 1 });
});

scenario("exec reports a failing command with its output", async ({ container }) => {
  await expect(container("cache").exec(["redis-cli", "--nope"])).rejects.toThrow(/`redis-cli --nope` in container "cache" exited with \d+/);
  expect(container("cache").address).toBe(`${container("cache").host}:${container("cache").port}`);
});
