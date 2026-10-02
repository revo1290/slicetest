/**
 * GraphQL over HTTP, as clients send it (Apollo, urql, graphql-request, gql, …):
 * a POST with `{ query, variables, operationName }`, or a GET with those as query
 * parameters. Stubs match calls by operation, and the app's own GraphQL endpoint
 * is called with `http.graphql()`.
 */

export interface GraphQLCall {
  /** `operationName` from the request, else the name in the document (`query GetUser { … }`). Undefined for an anonymous operation. */
  operation?: string;
  type: "query" | "mutation" | "subscription";
  query: string;
  variables: Record<string, unknown>;
}

const OPERATION = /(?:^|[\s}])(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/g;

/** The operations a document defines, in order. Comments and strings don't count. */
export function operations(document: string): { type: GraphQLCall["type"]; name?: string }[] {
  const code = document.replace(/"""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g, " ");
  const found: { type: GraphQLCall["type"]; name?: string }[] = [];
  for (const m of code.matchAll(OPERATION)) found.push({ type: m[1] as GraphQLCall["type"], name: m[2] });
  // `{ viewer { id } }` without a keyword is an anonymous query.
  if (found.length === 0 && /^\s*\{/.test(code)) found.push({ type: "query" });
  return found;
}

/** The GraphQL request in an HTTP call, or undefined when it isn't one. */
export function graphqlOf(call: { method: string; query: URLSearchParams; json: any }): GraphQLCall | undefined {
  let doc: unknown, name: unknown, variables: unknown;
  if (call.method === "GET") {
    doc = call.query.get("query") ?? undefined;
    name = call.query.get("operationName") ?? undefined;
    const v = call.query.get("variables");
    try {
      variables = v ? JSON.parse(v) : undefined;
    } catch {
      variables = undefined;
    }
  } else if (call.json && typeof call.json === "object" && !Array.isArray(call.json)) {
    ({ query: doc, operationName: name, variables } = call.json);
  }
  if (typeof doc !== "string") return undefined;
  const ops = operations(doc);
  const op = typeof name === "string" && name ? (ops.find((o) => o.name === name) ?? { type: "query" as const, name }) : ops[0];
  if (!op) return undefined;
  return {
    operation: typeof name === "string" && name ? name : op.name,
    type: op.type,
    query: doc,
    variables: variables && typeof variables === "object" ? (variables as Record<string, unknown>) : {},
  };
}

/** A GraphQL error list from messages or full error objects. */
export function graphqlErrors(errors: (string | { message: string; [k: string]: unknown })[]) {
  return errors.map((e) => (typeof e === "string" ? { message: e } : e));
}

/** `GraphQL mutation CreateIssue`, for failure messages. */
export function describeGraphQL(g: GraphQLCall) {
  return `GraphQL ${g.type} ${g.operation ?? "(anonymous)"}`;
}
