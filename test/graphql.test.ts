import { afterEach, beforeEach, expect, test } from "vitest";
import { graphqlOf, operations } from "../src/graphql.js";
import { Stub } from "../src/stub.js";
import "../src/matchers.js";

test("operations are read from the document, ignoring comments and strings", () => {
  expect(operations("# query Fake\nquery GetUser($id: ID!) { user(id: $id) { name(format: \"mutation X\") } }")).toEqual([{ type: "query", name: "GetUser" }]);
  expect(operations("fragment F on User { id }\nmutation Save { save { ...F } }")).toEqual([{ type: "mutation", name: "Save" }]);
  expect(operations("{ viewer { id } }")).toEqual([{ type: "query" }]);
  expect(operations("subscription { ticks }")).toEqual([{ type: "subscription", name: undefined }]);
});

test("operationName picks one of several operations", () => {
  const call = { method: "POST", query: new URLSearchParams(), json: { query: "query A { a } mutation B { b }", operationName: "B", variables: { x: 1 } } };
  expect(graphqlOf(call)).toMatchObject({ operation: "B", type: "mutation", variables: { x: 1 } });
  expect(graphqlOf({ ...call, json: { title: "not graphql" } })).toBeUndefined();
});

let stub: Stub;
beforeEach(async () => (stub = await Stub.start("api")));
afterEach(() => stub.close());

test("GET requests with query parameters are GraphQL calls too", async () => {
  stub.graphql("Poll", { variables: { id: 1 }, path: "/gql" }).data({ poll: { title: "Tea?" } });
  const q = new URLSearchParams({ query: "query Poll($id: Int) { poll(id: $id) { title } }", variables: '{"id":1}' });

  const res = await fetch(`${stub.url}/gql?${q}`);

  expect(await res.json()).toEqual({ data: { poll: { title: "Tea?" } } });
  expect(stub).toHaveReceivedGraphQL("Poll", { id: 1 });
  expect(stub.describeRoutes()).toEqual(["GraphQL Poll at /gql"]);
});

test("times() and errors() with partial data", async () => {
  stub.graphql("Save").once().errors([{ message: "conflict", extensions: { code: "CONFLICT" } }], { save: null });
  const post = () => fetch(`${stub.url}/graphql`, { method: "POST", body: JSON.stringify({ query: "mutation Save { save }" }) });

  expect(await (await post()).json()).toEqual({ errors: [{ message: "conflict", extensions: { code: "CONFLICT" } }], data: { save: null } });
  expect((await post()).status).toBe(501);
});
