import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { parse } from "yaml";
import { nullableToType } from "./openapi.js";

/**
 * JSON Schema checks for `toMatchSchema()` and YAML `expect.schema`: an inline
 * schema, or a file with an optional JSON pointer, such as an OpenAPI component
 * (`openapi.yaml#/components/schemas/Poll`), whose `$ref`s resolve within that file.
 */

const addFormats = ((addFormatsModule as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => void;
const cache = new Map<string, ValidateFunction>();

function ajvFor(draft2020: boolean) {
  const ajv = draft2020 ? new Ajv2020({ strict: false, allErrors: true }) : new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  // OpenAPI's own formats, which JSON Schema doesn't define.
  for (const f of ["int32", "int64", "float", "double", "byte", "binary", "password"]) ajv.addFormat(f, true);
  return ajv;
}

/** A schema file and pointer, `schemas/poll.json` or `openapi.yaml#/components/schemas/Poll`, resolved against `base`. */
export function validatorFor(ref: string, base = process.cwd()): ValidateFunction {
  const [file, pointer = ""] = ref.split("#") as [string, string?];
  const abs = path.resolve(base, file);
  const key = `${abs}#${pointer}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let doc: Record<string, any>;
  try {
    doc = parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`slicetest: can't read schema ${file}: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== "object") throw new Error(`slicetest: schema ${file} is not a JSON or YAML document`);
  const openapi = typeof doc.openapi === "string";
  if (openapi && !pointer) throw new Error(`slicetest: ${file} is an OpenAPI document; point at a schema in it, e.g. ${file}#/components/schemas/Poll`);
  // OpenAPI 3.0 schemas are a dialect of draft-04/07 with `nullable`; 3.1 and plain files are 2020-12 unless they say otherwise.
  const draft2020 = openapi ? doc.openapi.startsWith("3.1") : !/draft-0[4-7]/.test(String(doc.$schema ?? ""));
  const ajv = ajvFor(draft2020);
  ajv.addSchema(openapi && !draft2020 ? nullableToType(structuredClone(doc)) : doc, "doc");
  let validate: ValidateFunction;
  try {
    validate = ajv.compile({ $ref: `doc#${pointer}` });
  } catch (e) {
    throw new Error(`slicetest: no schema at ${ref}: ${(e as Error).message}`);
  }
  cache.set(key, validate);
  return validate;
}

const inline = new WeakMap<object, ValidateFunction>();

/** Problems with `value` against `schema` (an object, or a reference as for `validatorFor`); empty when it matches. */
export function schemaProblems(schema: object | string, value: unknown, base?: string): string[] {
  let validate: ValidateFunction;
  if (typeof schema === "string") validate = validatorFor(schema, base);
  else {
    validate = inline.get(schema) ?? ajvFor(!/draft-0[4-7]/.test(String((schema as { $schema?: unknown }).$schema ?? ""))).compile(schema);
    inline.set(schema, validate);
  }
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => {
    const extra = e.keyword === "additionalProperties" ? ` (${(e.params as { additionalProperty?: string }).additionalProperty})` : e.keyword === "enum" ? ` (${(e.params as { allowedValues?: unknown[] }).allowedValues?.map((v) => JSON.stringify(v)).join(", ")})` : "";
    return `${e.instancePath || "(root)"} ${e.message}${extra}`;
  });
}
