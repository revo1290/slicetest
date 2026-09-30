import { expect } from "vitest";
import { scenario } from "slicetest";

scenario("signing up sends a confirmation mail whose link works", async ({ http, mail }) => {
  expect(await http.post("/signup?email=alice@example.com")).toHaveStatus(202);
  const message = await mail.waitFor({ to: "alice@example.com", subject: "Confirm" });
  expect(message.text).toContain("Hi!");
  expect((await http.get(message.links[0]!)).text).toBe("confirmed tok123");
});

scenario("mail from earlier scenarios is gone, and the trace lists what was sent", async ({ http, mail, trace }) => {
  expect(mail.messages()).toEqual([]);
  await http.post("/signup?email=bob@example.com");
  await mail.waitFor();
  expect((await trace()).mail).toEqual([{ from: "noreply@example.com", to: ["bob@example.com"], subject: "Confirm your account", text: expect.stringContaining("Confirm:") }]);
});
