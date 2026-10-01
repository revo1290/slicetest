// Loaded into Node apps (NODE_OPTIONS=--require) while slicetest intercepts their outbound calls.
// NODE_USE_ENV_PROXY covers fetch and the default agents; libraries that make their own
// http(s).Agent (the Stripe SDK, many API clients) would otherwise go straight to the real
// host. Agents made from here on get the proxy settings too, unless they set their own.
"use strict";
const http = require("node:http");
const https = require("node:https");
const { syncBuiltinESMExports } = require("node:module");

for (const mod of [http, https]) {
  const Original = mod.Agent;
  class Agent extends Original {
    constructor(options = {}) {
      super({ proxyEnv: process.env, ...options });
    }
  }
  mod.Agent = Agent;
}
syncBuiltinESMExports();
