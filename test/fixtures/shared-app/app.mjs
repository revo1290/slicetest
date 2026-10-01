import { appendFileSync } from "node:fs";
import http from "node:http";
// Counts its starts in a file the build step empties, so scenarios can tell if it was restarted.
appendFileSync(new URL("starts.log", import.meta.url), `${process.pid}\n`);
http.createServer((req, res) => res.end(JSON.stringify({ pid: process.pid }))).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
