import http from "node:http";
// Serves its own spec, as springdoc (/v3/api-docs) or FastAPI (/openapi.json) do.
const spec = {
  openapi: "3.1.0",
  info: { title: "items", version: "1" },
  paths: {
    "/items/{id}": {
      get: {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          200: { description: "an item", content: { "application/json": { schema: { type: "object", required: ["id", "name"], properties: { id: { type: "integer" }, name: { type: "string" } } } } } },
          404: { description: "no such item" },
        },
      },
    },
  },
};
http
  .createServer((req, res) => {
    const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/v3/api-docs") return json(200, spec);
    if (req.url === "/items/1") return json(200, { id: 1, name: "one" });
    if (req.url === "/items/2") return json(200, { id: "2" }); // breaks the spec it serves
    json(404, { error: "not found" });
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
