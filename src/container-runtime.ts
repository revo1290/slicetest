import { execFileSync } from "node:child_process";

/**
 * Testcontainers talks to the Docker API. When Docker isn't configured but a
 * Podman machine is running, point Testcontainers at Podman's socket (macOS,
 * Linux) or named pipe (Windows).
 */
export function configureContainerRuntime(platform = process.platform) {
  if (process.env.DOCKER_HOST) return;
  const windows = platform === "win32";
  try {
    const field = windows ? "PodmanPipe" : "PodmanSocket";
    const location = execFileSync("podman", ["machine", "inspect", "--format", `{{.ConnectionInfo.${field}.Path}}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    if (!location || location === "<no value>") return;
    process.env.DOCKER_HOST = dockerHost(location, windows);
    // Ryuk needs a privileged socket mount that rootless Podman usually refuses.
    process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";
  } catch {
    // No podman; let Testcontainers find Docker on its own.
  }
}

/** `\\.\pipe\podman-machine-default` → `npipe:////./pipe/podman-machine-default`. */
export function dockerHost(location: string, windows: boolean) {
  return windows ? `npipe://${location.replace(/\\/g, "/")}` : `unix://${location}`;
}

/** Testcontainers declares Node.js 22.22+; below that its HTTP library fails when it loads. */
export function nodeTooOldForContainers(version = process.versions.node) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major < 22 || (major === 22 && minor < 22);
}

/** Loads a Testcontainers module; on an old Node.js, says that is the reason instead of showing the library's TypeError. */
export async function loadContainers<T>(load: () => Promise<T>, version = process.versions.node): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (!nodeTooOldForContainers(version)) throw e;
    throw new Error(
      `slicetest: Node.js ${version} can't load the container library (${(e as Error).message}). Starting a database or a dependency in a container needs Node.js 22.22 or later: upgrade Node.js, or use a database server you run yourself (SLICETEST_DATABASE_URL or db.url; no containers are then started for it).`,
      { cause: e },
    );
  }
}
