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
