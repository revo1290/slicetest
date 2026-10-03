import { afterAll, beforeAll, expect, test } from "vitest";
import { Stub } from "../src/stub.js";
import "../src/matchers.js";

let stripe: Stub;
let mail: Stub;
const stub = (name: string) => ({ stripe, mail })[name as "stripe" | "mail"];

beforeAll(async () => {
  stripe = await Stub.start("stripe");
  mail = await Stub.start("mail");
  stripe.on("POST", "/v1/charges").reply(200, {});
  mail.on("POST", "/send").reply(202);
  await fetch(`${mail.url}/send`, { method: "POST", body: '{"to":"ops@x.test"}' });
  await fetch(`${stripe.url}/v1/charges`, { method: "POST", body: '{"amount":1}' });
  await fetch(`${mail.url}/send`, { method: "POST", body: '{"to":"ada@x.test"}' });
});
afterAll(async () => {
  await stripe.close();
  await mail.close();
});

test("passes when the calls came in this order, with others in between", () => {
  expect(stub).toHaveReceivedInOrder([
    ["stripe", "POST", "/v1/charges"],
    ["mail", "POST", "/send", { json: { to: "ada@x.test" } }],
  ]);
  expect(stub).toHaveReceivedInOrder([
    ["mail", "POST", "/send"],
    ["stripe", "POST", "/v1/charges"],
    ["mail", "POST", "/send"],
  ]);
});

test("fails with the step that didn't follow and the calls in order", () => {
  expect(() =>
    expect(stub).toHaveReceivedInOrder([
      ["stripe", "POST", "/v1/charges"],
      ["mail", "POST", "/send", { json: { to: "ops@x.test" } }],
    ]),
  ).toThrow(/✓ stripe: POST \/v1\/charges\n {2}✗ mail: POST \/send with .*\nno matching call came after #1\. Calls received, in order:\n {2}mail: POST \/send\n {2}stripe: POST \/v1\/charges\n {2}mail: POST \/send/);
  expect(stub).not.toHaveReceivedInOrder([["stripe", "POST", "/v1/refunds"]]);
});
