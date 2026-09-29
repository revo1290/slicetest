import type { ResolvedOptions } from "./config.js";

declare module "vitest" {
  export interface ProvidedContext {
    slicetestOptions: ResolvedOptions;
    slicetestDb: { adminUrl: string; template: string; prefix: string; coverageDir?: string };
  }
}
