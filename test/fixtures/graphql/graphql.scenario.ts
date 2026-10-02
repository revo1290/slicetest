import { expect } from "vitest";
import { scenario } from "slicetest";

const REPORT = "mutation Report($title: String!) { report(title: $title) }";

scenario("operations are matched by operationName and by the name in the document", async ({ http, stub }) => {
  stub("github").graphql("Viewer").data({ viewer: { login: "octocat" } });
  stub("github").graphql("CreateIssue", { variables: { title: "Bug" } }).data((call) => ({ createIssue: { issue: { number: call.graphql!.variables.title === "Bug" ? 42 : 0 } } }));

  expect(await http.graphql("{ me }")).toHaveGraphQLData({ me: "octocat" });
  expect(await http.graphql(REPORT, { title: "Bug" })).toHaveGraphQLData({ report: 42 });
  expect(stub("github")).toHaveReceivedGraphQL("CreateIssue", { title: "Bug" });
  expect(stub("github")).toHaveReceivedGraphQL(/^View/);
  expect(stub("github")).not.toHaveReceivedGraphQL("DeleteIssue");
});

scenario("errors() answers like a GraphQL server, and toHaveGraphQLData reports them", async ({ http, stub }) => {
  stub("github").graphql("CreateIssue").errors(["rate limited"]);

  const res = await http.graphql(REPORT, { title: "x" });
  expect(res).toHaveStatus(200);
  expect(res).not.toHaveGraphQLData();
  expect(() => expect(res).toHaveGraphQLData()).toThrow(/got errors:\n  github: rate limited \(at report\)/);
});

scenario("variables that don't match leave the call unanswered, named by its operation", async ({ stub }) => {
  stub("github").graphql("CreateIssue", { variables: { title: "Other" } }).data({});
  const res = await fetch(`${stub("github").url}/graphql`, { method: "POST", body: JSON.stringify({ query: "mutation CreateIssue { x }", variables: { title: "Bug" } }) });
  expect(res.status).toBe(501);
  expect(await res.text()).toBe("slicetest: no stub for GraphQL mutation CreateIssue (POST /graphql)");
  stub("github").reset();
});
