import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { Mailbox, parseMail } from "../src/mail.js";

const exec = promisify(execFile);
let box: Mailbox;

beforeAll(async () => {
  box = await Mailbox.start();
});
beforeEach(() => box.reset());
afterAll(() => box.close());

/** Speak SMTP line by line, waiting for each reply. */
async function send(lines: string[]) {
  const socket = net.connect(box.port, box.host);
  socket.setEncoding("utf8");
  const replies: string[] = [];
  let pending = "";
  const next = () =>
    new Promise<string>((resolve) => {
      const onData = (d: string) => {
        pending += d;
        // Multi-line replies ("250-...") end with a line using a space after the code.
        const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(pending);
        if (!m) return;
        socket.off("data", onData);
        replies.push(pending);
        resolve(pending);
        pending = "";
      };
      socket.on("data", onData);
    });
  await next();
  let inData = false;
  for (const line of lines) {
    socket.write(`${line}\r\n`);
    if (line === "DATA") inData = true;
    else if (inData && line === ".") inData = false;
    else if (inData) continue;
    await next();
  }
  socket.end();
  return replies;
}

test("a message sent over SMTP is kept with its envelope, headers and body, dot-stuffing undone", async () => {
  await send([
    "EHLO test",
    "MAIL FROM:<shop@example.com>",
    "RCPT TO:<alice@example.com>",
    "RCPT TO:<audit@example.com>",
    "DATA",
    "From: Shop <shop@example.com>",
    "To: alice@example.com",
    "Subject: Your order",
    "",
    "Thanks!",
    "..leading dot",
    "Track it at https://shop.example.com/orders/42.",
    ".",
    "QUIT",
  ]);
  const mail = box.last()!;
  expect(mail).toMatchObject({
    from: "shop@example.com",
    to: ["alice@example.com", "audit@example.com"],
    subject: "Your order",
    text: "Thanks!\n.leading dot\nTrack it at https://shop.example.com/orders/42.",
    links: ["https://shop.example.com/orders/42"],
  });
  expect(mail.headers.from).toBe("Shop <shop@example.com>");
  expect(box.messages({ to: "AUDIT@example.com" })).toHaveLength(1);
  expect(box.messages({ to: "bob@example.com" })).toHaveLength(0);
  expect(box.messages({ subject: /order$/ })).toHaveLength(1);
});

test("waitFor waits for a message that arrives later, and reports what arrived when none matches", async () => {
  const waiting = box.waitFor({ subject: "later" }, { within: 2000 });
  setTimeout(() => void send(["HELO x", "MAIL FROM:<a@x>", "RCPT TO:<b@x>", "DATA", "Subject: later", "", "hi", ".", "QUIT"]), 50);
  expect((await waiting).to).toEqual(["b@x"]);
  await expect(box.waitFor({ subject: "never" }, { within: 100 })).rejects.toThrow(/no mail matching \{ subject: "never" \} within 100ms\nmail sent during this scenario:\n {2}a@x → b@x: "later"/);
});

test("multipart messages with encoded words, base64 and quoted-printable parts are decoded", () => {
  const raw = [
    "From: =?UTF-8?B?44K344On44OD44OX?= <shop@example.com>",
    "Subject: =?UTF-8?B?44GU5rOo5paH?=",
    " =?UTF-8?Q?=E3=81=82=E3=82=8A=E3=81=8C=E3=81=A8=E3=81=86?=",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "=E3=81=94=E7=A2=BA=E8=AA=8D: https://app.example.com/confirm?token=3Dabc&x=3D1",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from('<p>Hi <a href="https://app.example.com/confirm?token=abc&amp;x=1">confirm</a></p>').toString("base64"),
    "--b1--",
    "",
  ].join("\r\n");
  const mail = parseMail(raw, "", ["alice@example.com"]);
  expect(mail.subject).toBe("ご注文ありがとう");
  expect(mail.headers.from).toBe("ショップ <shop@example.com>");
  expect(mail.from).toBe("shop@example.com");
  expect(mail.text).toBe("ご確認: https://app.example.com/confirm?token=abc&x=1");
  expect(mail.html).toContain('<a href="https://app.example.com/confirm?token=abc&amp;x=1">');
  expect(mail.links).toEqual(["https://app.example.com/confirm?token=abc&x=1"]);
});

test("an HTML-only message gets a text version", () => {
  const mail = parseMail("Content-Type: text/html\r\n\r\n<p>Hello&nbsp;<b>you</b></p><p>Bye</p>", "a@x", ["b@x"]);
  expect(mail.text).toBe("Hello&nbsp;you\nBye");
});

test("a real SMTP client (Python's smtplib, with login and a UTF-8 HTML message) is understood", async () => {
  const script = `
import smtplib, sys
from email.message import EmailMessage
m = EmailMessage()
m["From"] = "App <noreply@example.com>"
m["To"] = "花子 <hanako@example.com>"
m["Subject"] = "パスワードの再設定"
m.set_content("再設定はこちら: http://127.0.0.1:3000/reset/xyz\\n")
m.add_alternative('<p><a href="http://127.0.0.1:3000/reset/xyz">再設定</a></p>', subtype="html")
with smtplib.SMTP("127.0.0.1", int(sys.argv[1])) as s:
    s.login("user", "secret")
    s.send_message(m)
`;
  await exec(process.platform === "win32" ? "python" : "python3", ["-c", script, String(box.port)]);
  const mail = await box.waitFor({ to: "hanako@example.com" });
  expect(mail).toMatchObject({ from: "noreply@example.com", subject: "パスワードの再設定", text: "再設定はこちら: http://127.0.0.1:3000/reset/xyz" });
  expect(mail.links).toEqual(["http://127.0.0.1:3000/reset/xyz"]);
});
