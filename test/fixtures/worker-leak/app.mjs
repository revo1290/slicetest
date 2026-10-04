import { writeFileSync } from "node:fs";
import http from "node:http";
// Tells the test which process to look for once the run is over.
writeFileSync(new URL("pid.log", import.meta.url), String(process.pid));
http.createServer((req, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready"));
