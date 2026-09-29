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

export interface Message {
  status?: number;
  contentType?: string;
  /** Parsed JSON when the body is JSON, else the raw text. */
  body: unknown;
  query?: URLSearchParams;
}

/**
 * An OpenAPI 3.0 / 3.1 document, used to check that real traffic matches it:
 * the app's responses against the app's own spec, and the app's calls to a
 * stubbed service (and the stub's canned replies) against that service's spec.
 */
export class OpenApiSpec {
  #ajv: Ajv;
  #validators = new Map<string, ValidateFunction>();
  #ops: { re: RegExp; op: Operation }[] = [];
  #basePaths: string[];

  private constructor(
    readonly file: string,
    private readonly doc: Record<string, any>,
  ) {
    const v31 = String(doc.openapi ?? "").startsWith("3.1");
    this.#ajv = v31 ? new Ajv2020({ strict: false, allErrors: true }) : new Ajv({ strict: false, allErrors: true });
    addFormats(this.#ajv);
    for (const f of ["int32", "int64", "float", "double", "byte", "binary", "password"]) this.#ajv.addFormat(f, true);
    this.#ajv.addSchema(v31 ? doc : nullableToType(structuredClone(doc)), "spec");

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
          .map((s: { url?: string }) => new URL(s.url ?? "/", "http://x").pathname.replace(/\/$/, ""))
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
  checkResponse(method: string, path: string, res: Message): string[] {
    const found = this.find(method, path);
    if (!found) return [`${method} ${path} is not in ${this.file}`];
    const { template, op } = found;
    const status = String(res.status);
    const responses = op.responses ?? {};
    const key = [status, `${status[0]}XX`, `${status[0]}xx`, "default"].find((k) => k in responses);
    if (!key) return [`${method} ${template} responded ${status}, which ${this.file} doesn't document (documented: ${Object.keys(responses).join(", ") || "none"})`];
    const [response, at] = this.#resolve(responses[key], ["paths", template, found.method, "responses", key]);
    return this.#checkContent(response?.content, res, [...at, "content"], `${method} ${template} → ${status}`);
  }

  /** Problems with a request the app sent to `method path`. */
  checkRequest(method: string, path: string, req: Message): string[] {
    const found = this.find(method, path);
    if (!found) return [`${method} ${path} is not in ${this.file}`];
    const { template, op } = found;
    const errors: string[] = [];
    const params = [...(this.doc.paths[template].parameters ?? []), ...(op.parameters ?? [])].map((p) => this.#deref(p));
    for (const p of params) {
      if (p?.in === "query" && p.required && !req.query?.has(p.name)) errors.push(`${method} ${template}: required query parameter "${p.name}" is missing`);
    }
    const [body, at] = this.#resolve(op.requestBody, ["paths", template, found.method, "requestBody"]);
    if (!body) return errors;
    if (req.body === "" || req.body === undefined) {
      if (body.required) errors.push(`${method} ${template}: the request body is required`);
      return errors;
    }
    return [...errors, ...this.#checkContent(body.content, req, [...at, "content"], `${method} ${template} request`)];
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

function isJson(media: string) {
  return /[/+]json$/i.test(media) || media === "*/*";
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** OpenAPI 3.0's `nullable: true` → JSON Schema's `type: [T, "null"]`. */
function nullableToType(node: any): any {
  if (Array.isArray(node)) return node.map(nullableToType);
  if (!node || typeof node !== "object") return node;
  for (const [k, v] of Object.entries(node)) node[k] = nullableToType(v);
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
