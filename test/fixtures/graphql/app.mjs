import http from "node:http";
// A tiny GraphQL endpoint that resolves through an upstream GraphQL API (like GitHub's).
const upstream = async (body) => (await fetch(`${process.env.GITHUB_URL}/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

http
  .createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const { query = "", variables = {} } = raw ? JSON.parse(raw) : {};
    const send = (body) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (query.includes("me")) {
      // No operationName: the stub has to read the name from the document.
      const r = await upstream({ query: "# who am I\nquery Viewer { viewer { login } }" });
      return send({ data: { me: r.data?.viewer?.login ?? null } });
    }
    if (query.includes("report")) {
      const r = await upstream({ query: "mutation CreateIssue($title: String!) { createIssue(input: { title: $title }) { issue { number } } }", variables: { title: variables.title }, operationName: "CreateIssue" });
      if (r.errors) return send({ data: { report: null }, errors: r.errors.map((e) => ({ message: `github: ${e.message}`, path: ["report"] })) });
      return send({ data: { report: r.data.createIssue.issue.number } });
    }
    send({ errors: [{ message: `unknown field in ${query}` }] });
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
