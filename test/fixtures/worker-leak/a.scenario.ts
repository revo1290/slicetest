import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("the app of a worker is running", async ({ http }) => {
  expect((await http.get("/")).text).toBe("ok");
});
