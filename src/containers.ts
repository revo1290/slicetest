import type { StartedTestContainer } from "testcontainers";
import type { ContainerOptions } from "./config.js";
import { configureContainerRuntime } from "./container-runtime.js";

/**
 * A container the app depends on (Redis, a search engine, an S3 emulator),
 * started for one test file and emptied between scenarios with `reset`.
 */
export class Dependency {
  private constructor(
    readonly name: string,
    private readonly container: StartedTestContainer,
    private readonly opts: ContainerOptions,
  ) {}

  static async start(name: string, opts: ContainerOptions) {
    configureContainerRuntime();
    const { GenericContainer, Wait } = await import("testcontainers");
    let definition = new GenericContainer(opts.image).withExposedPorts(opts.port);
    if (opts.env) definition = definition.withEnvironment(opts.env);
    if (opts.command) definition = definition.withCommand(opts.command);
    if (opts.ready) definition = definition.withWaitStrategy(Wait.forLogMessage(opts.ready.log));
    try {
      return new Dependency(name, await definition.start(), opts);
    } catch (e) {
      throw new Error(`slicetest: container "${name}" (${opts.image}) didn't start: ${(e as Error).message}`);
    }
  }

  get host() {
    return this.container.getHost();
  }

  /** The host port mapped to the container's `port`. */
  get port() {
    return this.container.getMappedPort(this.opts.port);
  }

  /** `host:port`, to put after a scheme: `redis://{{container.cache}}`. */
  get address() {
    return `${this.host}:${this.port}`;
  }

  /** Run a command inside the container; throws with its output unless it exits with 0. */
  async exec(command: string[]) {
    const res = await this.container.exec(command);
    if (res.exitCode !== 0) {
      throw new Error(`slicetest: \`${command.join(" ")}\` in container "${this.name}" exited with ${res.exitCode}:\n${res.output.trim()}`);
    }
    return res.stdout;
  }

  /** Start of a scenario: run the `reset` command, if any. */
  async reset() {
    if (this.opts.reset) await this.exec(this.opts.reset);
  }

  async stop() {
    await this.container.stop();
  }
}
