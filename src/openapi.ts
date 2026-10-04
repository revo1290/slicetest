import { readFile } from "node:fs/promises";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse } from "yaml";

const addFormats = ((addFormatsModule as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => void;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

interface Operation {
  /** `paths` key, e.g. `/polls/{id}`. */
  template: string;
  method: string;
  op: Record<string, any>;
}

export interface OperationSketch {
  method: string;
  template: string;
  summary?: string;
  pathParams: Record<string, unknown>;
  query: Record<string, unknown>;
  json?: unknown;
  /** Documented response keys, e.g. `201`, `4XX`, `default`. */
  responses: string[];
  /** Top-level properties of the first 2xx JSON response. */
  createdFields: string[];
  /**
   * The operation requires a bearer token (an `http: bearer`, `oauth2` or
   * `openIdConnect` security scheme), with the scopes it lists. Undefined when
   * it needs no token or accepts other credentials only.
   */
  bearer?: { scopes: string[] };
}

export interface Message {
  status?: number;
  contentType?: string;
  /** Parsed JSON when the body is JSON, else the raw text. */
  body: unknown;
  query?: URLSearchParams;
  /** Header names in lower case, as Node delivers them; undefined skips the check for required header parameters. */
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * An OpenAPI 3.0 / 3.1 document, used to check that real traffic matches it:
 * the app's responses against the app's own spec, and the app's calls to a
 * stubbed service (and the stub's canned replies) against that service's spec.
 */
interface Server {
  url?: string;
  variables?: Record<string, { default?: unknown; enum?: unknown[] }>;
}

/** A server's URL with its `{variables}` filled in: every `enum` value, else the default. */
function serverUrls(server: Server): string[] {
  let urls = [server.url ?? "/"];
  for (const [name, v] of Object.entries(server.variables ?? {})) {
    const values = [...new Set([...(v.default === undefined ? [] : [v.default]), ...(v.enum ?? [])].map(String))];
    if (values.length === 0 || !urls[0]!.includes(`{${name}}`)) continue;
    urls = urls.flatMap((u) => values.map((value) => u.replaceAll(`{${name}}`, value))).slice(0, 50);
  }
  return urls;
}

export class OpenApiSpec {
  #ajv: Ajv;
  #validators = new Map<string, ValidateFunction>();
  #ops: { re: RegExp; op: Operation }[] = [];
  #basePaths: string[];
  #documentOrder: Operation[] = [];

  private constructor(
    readonly file: string,
    private readonly doc: Record<string, any>,
  ) {
    const v31 = String(doc.openapi ?? "").startsWith("3.1");
    this.#ajv = v31 ? new Ajv2020({ strict: false, allErrors: true }) : new Ajv({ strict: false, allErrors: true });
    addFormats(this.#ajv);
    for (const f of ["int32", "int64", "float", "double", "byte", "binary", "password"]) this.#ajv.addFormat(f, true);
    this.#ajv.addSchema(v31 ? doc : nullableToType(structuredClone(doc)), "spec");

    for (const [template, item] of Object.entries<Record<string, any>>(doc.paths ?? {})) {
      for (const method of METHODS) if (item[method]) this.#documentOrder.push({ template, method, op: item[method] });
    }
    // Concrete segments before templated ones, so /polls/new wins over /polls/{id}.
    const templates = Object.keys(doc.paths ?? {}).sort((a, b) => a.split("{").length - b.split("{").length);
    for (const template of templates) {
      const re = new RegExp(`^${template.split(/\{[^}]+\}/).map(escape).join("[^/]+")}/?$`);
      for (const method of METHODS) {
        const op = doc.paths[template][method];
        if (op) this.#ops.push({ re, op: { template, method, op } });
      }
    }
    // Paths in the spec are relative to the server URL, e.g. /v1 for https://api.example.com/v1.
    this.#basePaths = [
      ...new Set(
        (doc.servers ?? [])
          .flatMap((s: Server) => serverUrls(s))
          .map((url: string) => new URL(url, "http://x").pathname.replace(/\/$/, ""))
          .filter(Boolean),
      ),
    ] as string[];
  }

  /** `file` is read; `label` (default: `file`) is how messages refer to it. */
  static async load(file: string, label = file) {
    let doc: unknown;
    try {
      doc = parse(await readFile(file, "utf8"));
    } catch (e) {
      throw new Error(`slicetest: can't read OpenAPI spec ${label}: ${(e as Error).message}`);
    }
    if (!doc || typeof doc !== "object" || !("openapi" in doc)) {
      throw new Error(`slicetest: ${label} is not an OpenAPI 3 document (no "openapi" field)`);
    }
    return new OpenApiSpec(label, doc as Record<string, any>);
  }

  find(method: string, path: string): Operation | undefined {
    const m = method.toLowerCase();
    for (const candidate of [path, ...this.#basePaths.filter((b) => path.startsWith(b)).map((b) => path.slice(b.length) || "/")]) {
      const hit = this.#ops.find((o) => o.op.method === m && o.re.test(candidate));
      if (hit) return hit.op;
    }
    return undefined;
  }

  /** Problems with a response to `method path`; empty when it matches the spec. */
  /** The documented response (`200`, `4XX`, `default`) that `status` falls under, for coverage. */
  responseKey(method: string, path: string, status: number) {
    const found = this.find(method, path);
    if (!found) return undefined;
    const key = pickResponse(found.op.responses ?? {}, status);
    return key && `${method.toUpperCase()} ${found.template} ${key}`;
  }

  /** The documented operation `method path` falls under, as `METHOD /template`, and whether the spec deprecates it. */
  operationOf(method: string, path: string) {
    const found = this.find(method, path);
    return found && { key: `${method.toUpperCase()} ${found.template}`, deprecated: found.op.deprecated === true };
  }

  /** Every documented operation as `METHOD /template`, with its `deprecated` flag. */
  operationKeys() {
    return this.#documentOrder.map(({ template, method, op }) => ({ key: `${method.toUpperCase()} ${template}`, deprecated: op.deprecated === true }));
  }

  /** Every documented response as `METHOD /template key`, in document order. */
  responseKeys() {
    return this.#documentOrder.flatMap(({ template, method, op }) =>
      Object.keys(op.responses ?? {}).map((key) => `${method.toUpperCase()} ${template} ${key}`),
    );
  }

  checkResponse(method: string, path: string, res: Message): string[] {
    const found = this.find(method, path);
    if (!found) return [`${method} ${path} is not in ${this.file}`];
    const { template, op } = found;
    const status = String(res.status);
    const responses = op.responses ?? {};
    const key = pickResponse(responses, res.status ?? 0);
    if (!key) return [`${method} ${template} responded ${status}, which ${this.file} doesn't document (documented: ${Object.keys(responses).join(", ") || "none"})`];
    const [response, at] = this.#resolve(responses[key], ["paths", template, found.method, "responses", key]);
    const label = `${method} ${template} → ${status}`;
    return [...this.#checkHeaders(label, response?.headers, [...at, "headers"], res.headers), ...this.#checkContent(response?.content, res, [...at, "content"], label)];
  }

  /**
   * A response the real service could send to `method path`: the lowest
   * documented 2xx, with its example if the spec has one, else a value built
   * from its schema. Undefined when the operation isn't in the spec.
   */
  exampleResponse(method: string, path: string): { status: number; headers?: Record<string, string>; body?: unknown } | undefined {
    const found = this.find(method, path);
    if (!found) return undefined;
    const responses = found.op.responses ?? {};
    const key = Object.keys(responses)
      .filter((k) => /^2\d\d$/.test(k))
      .sort()[0] ?? Object.keys(responses).find((k) => /^2xx$/i.test(k));
    if (!key) return undefined;
    const status = key.length === 3 && /^\d+$/.test(key) ? Number(key) : 200;
    const response = this.#deref(responses[key]);
    const content: Record<string, any> = response?.content ?? {};
    const media = Object.keys(content).find(isJson) ?? Object.keys(content)[0];
    // The headers the spec requires, so the example passes the same check the stub's replies are held to.
    const required = Object.fromEntries(
      Object.entries<any>(response?.headers ?? {})
        .map(([name, def]) => [name, this.#deref(def)] as const)
        .filter(([name, h]) => h?.required && !["content-type", "accept", "authorization"].includes(name.toLowerCase()))
        .map(([name, h]) => [name, String(h.example !== undefined ? h.example : this.#sample(h.schema))]),
    );
    if (!media) return { status, ...(Object.keys(required).length ? { headers: required } : {}) };
    const m = content[media] ?? {};
    const named = m.examples && Object.values<any>(m.examples)[0];
    const body =
      m.example !== undefined
        ? m.example
        : named !== undefined
          ? (this.#deref(named)?.value ?? null)
          : this.#sample(m.schema);
    return { status, headers: { "content-type": media === "*/*" ? "application/json" : media, ...required }, body: isJson(media) ? body : String(body ?? "") };
  }

  /**
   * Every operation with what it takes to call it: sample values for its
   * required path and query parameters and for its JSON request body, and the
   * properties of its first 2xx JSON response. Used by `slicetest gen`.
   */
  operations(): OperationSketch[] {
    return this.#documentOrder.map(({ template, method, op }) => {
      const params = [...(this.doc.paths[template].parameters ?? []), ...(op.parameters ?? [])].map((p) => this.#deref(p)).filter(Boolean);
      const sample = (p: any) => (p.example !== undefined ? p.example : p.schema ? this.#sample(p.schema) : "1");
      const pathParams = Object.fromEntries(params.filter((p: any) => p.in === "path").map((p: any) => [p.name, sample(p)]));
      const query = Object.fromEntries(params.filter((p: any) => p.in === "query" && p.required).map((p: any) => [p.name, sample(p)]));
      const body = this.#deref(op.requestBody);
      const media = body?.content && Object.keys(body.content).find(isJson);
      const m = media ? body.content[media] : undefined;
      const json = m ? (m.example !== undefined ? m.example : this.#sample(m.schema)) : undefined;
      const responses = Object.keys(op.responses ?? {});
      const ok = responses.filter((k) => /^2/.test(k)).sort()[0];
      const okContent = ok ? this.#deref(op.responses[ok])?.content : undefined;
      const okMedia = okContent && Object.keys(okContent).find(isJson);
      const okSchema = okMedia ? this.#deref(okContent[okMedia]?.schema) : undefined;
      return {
        method: method.toUpperCase(),
        template,
        summary: op.summary ?? op.operationId,
        pathParams,
        query,
        json: json ?? undefined,
        responses,
        createdFields: okSchema?.properties ? Object.keys(okSchema.properties) : [],
        bearer: this.#bearer(op.security ?? this.doc.security),
      };
    });
  }

  #bearer(security: Record<string, string[]>[] | undefined): OperationSketch["bearer"] {
    if (!Array.isArray(security) || security.length === 0) return undefined;
    // An empty requirement makes credentials optional.
    if (security.some((req) => Object.keys(req ?? {}).length === 0)) return undefined;
    const schemes = this.doc.components?.securitySchemes ?? {};
    for (const req of security) {
      for (const [name, scopes] of Object.entries(req)) {
        const s = this.#deref(schemes[name]);
        if (s && ((s.type === "http" && String(s.scheme).toLowerCase() === "bearer") || s.type === "oauth2" || s.type === "openIdConnect")) {
          return { scopes: Array.isArray(scopes) ? scopes : [] };
        }
      }
    }
    return undefined;
  }

  /** A value that satisfies `schema` (as far as a simple walk can): examples, defaults, enums, then types. */
  #sample(schema: any, depth = 0): unknown {
    const s = this.#deref(schema);
    if (!s || typeof s !== "object" || depth > 8) return null;
    if (s.example !== undefined) return s.example;
    if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    if (s.default !== undefined) return s.default;
    if (s.const !== undefined) return s.const;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if (Array.isArray(s.allOf)) {
      return Object.assign({}, ...s.allOf.map((part: unknown) => this.#sample(part, depth + 1)).filter((v: unknown) => v && typeof v === "object"));
    }
    const first = s.oneOf?.[0] ?? s.anyOf?.[0];
    if (first) return this.#sample(first, depth + 1);
    const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type;
    switch (type ?? (s.properties ? "object" : s.items ? "array" : undefined)) {
      case "object":
        return Object.fromEntries(Object.entries<any>(s.properties ?? {}).map(([k, v]) => [k, this.#sample(v, depth + 1)]));
      case "array":
        return Array.from({ length: Math.max(1, s.minItems ?? 1) }, (_, i) => {
          const items = this.#deref(s.items);
          // Equal items would break `uniqueItems`.
          return s.uniqueItems && Array.isArray(items?.enum) && items.enum.length ? items.enum[i % items.enum.length] : this.#sample(s.items, depth + 1);
        });
      case "integer":
      case "number":
        return sampleNumber(s, type === "integer");
      case "boolean":
        return true;
      case "string":
        return sampleString(s);
      default:
        return null;
    }
  }

  /** Problems with a request the app sent to `method path`. */
  checkRequest(method: string, path: string, req: Message): string[] {
    const found = this.find(method, path);
    if (!found) return [`${method} ${path} is not in ${this.file}`];
    const { template, op } = found;
    const errors: string[] = [];
    const listed: [any, string[]][] = [
      ...(this.doc.paths[template].parameters ?? []).map((p: any, i: number) => this.#resolve(p, ["paths", template, "parameters", String(i)])),
      ...(op.parameters ?? []).map((p: any, i: number) => this.#resolve(p, ["paths", template, found.method, "parameters", String(i)])),
    ];
    for (const [p, at] of listed) {
      if (p?.in === "query") {
        if (p.required && !req.query?.has(p.name)) errors.push(`${method} ${template}: required query parameter "${p.name}" is missing`);
        const values = req.query?.getAll(p.name) ?? [];
        if (values.length && p.schema) errors.push(...this.#checkValues(`${method} ${template}`, `query parameter "${p.name}"`, values, p.schema, [...at, "schema"]));
      }
      // Authorization, Accept and Content-Type are the transport's business, whatever the spec lists.
      const skipped = ["authorization", "accept", "content-type"];
      if (p?.in === "header" && p.required && req.headers && !skipped.includes(p.name.toLowerCase()) && req.headers[p.name.toLowerCase()] === undefined) {
        errors.push(`${method} ${template}: required header "${p.name}" is missing`);
      }
    }
    const [body, at] = this.#resolve(op.requestBody, ["paths", template, found.method, "requestBody"]);
    if (!body) return errors;
    if (req.body === "" || req.body === undefined) {
      if (body.required) errors.push(`${method} ${template}: the request body is required`);
      return errors;
    }
    return [...errors, ...this.#checkContent(body.content, req, [...at, "content"], `${method} ${template} request`)];
  }

  /** A query parameter's or header's values as strings, held to its schema after reading them as the type it declares. */
  #checkValues(label: string, subject: string, values: string[], schema: any, pointer: string[]): string[] {
    const [node, at] = this.#resolve(schema, pointer);
    const one = (raw: string, node: any, at: string[], where: string) => {
      if (!["string", "integer", "number", "boolean"].includes(node?.type) && !node?.enum) return [];
      const validate = this.#validator(at);
      const value = (node.type === "integer" || node.type === "number") && raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : node.type === "boolean" && (raw === "true" || raw === "false") ? raw === "true" : raw;
      if (validate(value)) return [];
      return [`${label}: ${subject}${where} ${validate.errors![0]!.message} (got ${JSON.stringify(raw)})`];
    };
    if (node?.type !== "array") return one(values[0]!, node, at, "");
    const [items, itemsAt] = this.#resolve(node.items, [...at, "items"]);
    // One value may carry the whole list (`?ids=1,2`, explode: false). Many servers accept it for the exploded default too, so it isn't held against the spec.
    const list = values.length > 1 ? values : values.flatMap((v) => v.split(","));
    return list.flatMap((raw, i) => one(raw, items, itemsAt, ` item ${i + 1}`));
  }

  /** The headers a response documents: the required ones must be there, and what is there must fit its schema. */
  #checkHeaders(label: string, documented: Record<string, any> | undefined, at: string[], actual: Message["headers"]): string[] {
    if (!documented || !actual) return [];
    const errors: string[] = [];
    for (const [name, def] of Object.entries(documented)) {
      // The spec says to ignore these three when they are listed.
      if (["content-type", "accept", "authorization"].includes(name.toLowerCase())) continue;
      const [h, hat] = this.#resolve(def, [...at, name]);
      const raw = actual[name.toLowerCase()];
      if (raw === undefined) {
        if (h?.required) errors.push(`${label}: required header "${name}" is missing`);
      } else if (h?.schema) {
        errors.push(...this.#checkValues(label, `header "${name}"`, [Array.isArray(raw) ? raw.join(", ") : raw], h.schema, [...hat, "schema"]));
      }
    }
    return errors;
  }

  #checkContent(content: Record<string, any> | undefined, msg: Message, pointer: string[], label: string): string[] {
    if (!content || Object.keys(content).length === 0) return [];
    const type = (msg.contentType ?? "").split(";")[0]!.trim().toLowerCase();
    // Without a content-type (e.g. a stub replying with a bare string) there's nothing to hold the body to.
    if (!type) return [];
    const media =
      Object.keys(content).find((k) => k.toLowerCase() === type) ??
      Object.keys(content).find((k) => k.endsWith("/*") && type.startsWith(k.slice(0, -1))) ??
      Object.keys(content).find((k) => k === "*/*");
    if (!media) return [`${label}: content-type "${type || "(none)"}" is not one of ${Object.keys(content).join(", ")}`];
    if (!content[media]?.schema || !isJson(media)) return [];
    if (typeof msg.body === "string") return [`${label}: body is not valid JSON`];
    const validate = this.#validator([...pointer, media, "schema"]);
    if (validate(msg.body)) return [];
    return (validate.errors ?? []).slice(0, 5).map((e) => `${label}: ${e.instancePath || "body"} ${e.message}${e.params && "additionalProperty" in e.params ? ` "${e.params.additionalProperty}"` : ""}`);
  }

  #validator(pointer: string[]) {
    const ref = `spec#/${pointer.map((p) => p.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
    let v = this.#validators.get(ref);
    if (!v) {
      v = this.#ajv.compile({ $ref: ref });
      this.#validators.set(ref, v);
    }
    return v;
  }

  /** Follow a local `$ref` such as `#/components/responses/NotFound`. */
  #deref(node: any): any {
    return this.#resolve(node, [])[0];
  }

  /** The node behind any `$ref`s, and its location in the document (for compiling schemas under it). */
  #resolve(node: any, at: string[], depth = 0): [any, string[]] {
    if (!node || typeof node.$ref !== "string" || !node.$ref.startsWith("#/") || depth > 10) return [node, at];
    const pointer = node.$ref
      .slice(2)
      .split("/")
      .map((p: string) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    const target = pointer.reduce((cur: any, key: string) => cur?.[key], this.doc);
    return this.#resolve(target, pointer, depth + 1);
  }
}

const FORMATS: Record<string, string> = {
  "date-time": "2026-01-01T00:00:00Z",
  date: "2026-01-01",
  time: "00:00:00Z",
  email: "user@example.com",
  uri: "https://example.com",
  url: "https://example.com",
  uuid: "00000000-0000-4000-8000-000000000000",
  hostname: "example.com",
  ipv4: "192.0.2.1",
  ipv6: "2001:db8::1",
};

function sampleString(s: { format?: string; minLength?: number; maxLength?: number; pattern?: string }) {
  let base = (s.format && FORMATS[s.format]) ?? "string";
  // A cut-off date or address would break its format as much as the length, so only plain strings are shortened.
  if (!s.format && s.maxLength !== undefined && base.length > s.maxLength) base = base.slice(0, s.maxLength);
  return base.length >= (s.minLength ?? 0) ? base : base.padEnd(s.minLength!, "x");
}

/** A number inside the schema's bounds (3.0's `exclusiveMinimum: true` and 3.1's numeric form), on its `multipleOf` step. */
function sampleNumber(s: any, integer: boolean) {
  const bound = (value: string, exclusive: string) => {
    if (typeof s[exclusive] === "number") return { at: s[exclusive] as number, open: true };
    if (typeof s[value] === "number") return { at: s[value] as number, open: s[exclusive] === true };
    return undefined;
  };
  const lo = bound("minimum", "exclusiveMinimum");
  const hi = bound("maximum", "exclusiveMaximum");
  let n = 0;
  if (lo) n = lo.open ? lo.at + 1 : lo.at;
  else if (hi) n = hi.open ? hi.at - 1 : Math.min(0, hi.at);
  // The step past an open lower bound can overshoot a close upper one.
  if (lo && hi && (hi.open ? n >= hi.at : n > hi.at)) n = lo.open ? (lo.at + hi.at) / 2 : lo.at;
  if (typeof s.multipleOf === "number" && s.multipleOf > 0) {
    n = Math.ceil(n / s.multipleOf) * s.multipleOf;
    if (lo?.open && n <= lo.at) n += s.multipleOf;
  }
  return integer ? Math.ceil(n) : n;
}

function pickResponse(responses: Record<string, unknown>, status: number) {
  const s = String(status);
  return [s, `${s[0]}XX`, `${s[0]}xx`, "default"].find((k) => k in responses);
}

/**
 * Coverage report: which documented responses the scenarios produced.
 * `hits` are `responseKey()` values collected from every worker.
 */
export function formatCoverage(spec: OpenApiSpec, hits: Set<string>) {
  const keys = spec.responseKeys();
  const byOp = new Map<string, string[]>();
  for (const k of keys) {
    const i = k.lastIndexOf(" ");
    const op = k.slice(0, i);
    byOp.set(op, [...(byOp.get(op) ?? []), k.slice(i + 1)]);
  }
  const width = Math.max(0, ...[...byOp.keys()].map((op) => op.indexOf(" ") > -1 ? op.length - op.indexOf(" ") - 1 : 0));
  const lines = [...byOp].map(([op, statuses]) => {
    const i = op.indexOf(" ");
    const marks = statuses.map((s) => `${s} ${hits.has(`${op} ${s}`) ? "✓" : "✗"}`).join("  ");
    return `  ${op.slice(0, i).padEnd(6)} ${op.slice(i + 1).padEnd(width)}  ${marks}`;
  });
  const covered = keys.filter((k) => hits.has(k)).length;
  const percent = keys.length ? Math.round((covered / keys.length) * 100) : 100;
  const markdown = [
    `### slicetest: OpenAPI coverage ${percent}%`,
    "",
    `${covered} of ${keys.length} documented responses in \`${spec.file}\` were produced by a scenario.`,
    "",
    "| Operation | Responses |",
    "|---|---|",
    ...[...byOp].map(([op, statuses]) => `| \`${op}\` | ${statuses.map((s) => `${hits.has(`${op} ${s}`) ? "✅" : "❌"} ${s}`).join(" ")} |`),
    "",
  ].join("\n");
  return { covered, total: keys.length, percent, markdown, text: `slicetest: OpenAPI coverage (${spec.file}): ${covered}/${keys.length} documented responses (${percent}%)\n${lines.join("\n")}` };
}

function isJson(media: string) {
  return /[/+]json$/i.test(media) || media === "*/*";
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** OpenAPI 3.0's `nullable: true` → JSON Schema's `type: [T, "null"]`. */
export function nullableToType(node: any): any {
  if (Array.isArray(node)) return node.map(nullableToType);
  if (!node || typeof node !== "object") return node;
  for (const [k, v] of Object.entries(node)) node[k] = nullableToType(v);
  // 3.0 writes `minimum: 0, exclusiveMinimum: true`; JSON Schema (and Ajv) want `exclusiveMinimum: 0`.
  for (const [flag, bound] of [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]] as const) {
    if (typeof node[flag] !== "boolean") continue;
    if (node[flag] && typeof node[bound] === "number") {
      node[flag] = node[bound];
      delete node[bound];
    } else delete node[flag];
  }
  if (node.nullable === true) {
    if (node.enum && !node.enum.includes(null)) node.enum = [...node.enum, null];
    if (typeof node.type === "string") node.type = [node.type, "null"];
    else if (!node.type) {
      const inner = { ...node };
      delete inner.nullable;
      return { anyOf: [inner, { type: "null" }] };
    }
  }
  return node;
}

/**
 * Which of a provider's operations the app called during the run: its dependency
 * surface on that API, with the operations the provider has deprecated flagged.
 */
export function formatUsage(name: string, spec: OpenApiSpec, used: Set<string>) {
  const ops = spec.operationKeys().filter((o) => used.has(o.key));
  const deprecated = ops.filter((o) => o.deprecated);
  const width = Math.max(0, ...ops.map((o) => o.key.length));
  const text = [
    `slicetest: the app used ${ops.length} of ${spec.operationKeys().length} operations of ${name} (${spec.file})${deprecated.length ? `, ${deprecated.length} deprecated` : ""}`,
    ...ops.map((o) => `  ${o.key.padEnd(width)}${o.deprecated ? "  ⚠ deprecated" : ""}`),
  ].join("\n");
  const markdown = [
    `### slicetest: ${name} API usage`,
    "",
    `The app called ${ops.length} of ${spec.operationKeys().length} operations in \`${spec.file}\`${deprecated.length ? `, **${deprecated.length} deprecated**` : ""}.`,
    "",
    ...ops.map((o) => `- \`${o.key}\`${o.deprecated ? " ⚠️ deprecated" : ""}`),
    "",
  ].join("\n");
  return { text, markdown, deprecated: deprecated.map((o) => o.key) };
}

/** Where a spec fetched from the app (`openapi.fromApp`) is kept for the coverage report. */
export function appSpecFile(coverageDir: string) {
  return `${coverageDir}.spec.json`;
}
