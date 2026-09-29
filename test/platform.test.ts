import { expect, test } from "vitest";
import { dockerHost } from "../src/container-runtime.js";
import { atlasDirUrl } from "../src/global-setup.js";

test("podman locations become DOCKER_HOST values", () => {
  expect(dockerHost("/var/folders/x/podman.sock", false)).toBe("unix:///var/folders/x/podman.sock");
  expect(dockerHost("\\\\.\\pipe\\podman-machine-default", true)).toBe("npipe:////./pipe/podman-machine-default");
});

test("atlas dirs become forward-slash file URLs relative to the root", () => {
  expect(atlasDirUrl("migrations", "/app")).toBe("file://migrations");
  expect(atlasDirUrl("file://db/migrations", "/app")).toBe("file://db/migrations");
  expect(atlasDirUrl("/app/db/migrations", "/app")).toBe("file://db/migrations");
  expect(atlasDirUrl("db\\migrations", "C:\\app")).toBe("file://db/migrations");
});
