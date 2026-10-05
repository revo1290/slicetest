import { waitBudget } from "./deadline.js";
import { decodeEntities } from "./form.js";
import net from "node:net";
import type { AddressInfo } from "node:net";

/**
 * An SMTP server that accepts every message and keeps it, so scenarios can
 * check the mail an app sends (sign-up confirmations, password resets,
 * receipts) without a real mail server. Apps in any language reach it at
 * `{{mail.host}}:{{mail.port}}` with no TLS; any credentials are accepted.
 */
export interface Mail {
  from: string;
  /** Envelope recipients (RCPT TO), which include Cc and Bcc. */
  to: string[];
  subject: string;
  /** The text/plain part, decoded. */
  text: string;
  /** The text/html part, decoded, if there is one. */
  html?: string;
  /** Header names are lower-case. Repeated headers are joined with ", ". */
  headers: Record<string, string>;
  /** Every http(s) URL in the text and HTML parts, in order, without duplicates. */
  links: string[];
  raw: string;
}

/**
 * Which messages to look at. Strings match the address exactly (`to`, `from`,
 * case-insensitive) or as a substring (`subject`, `text`, `html`); RegExps test the value.
 */
export interface MailFilter {
  to?: string | RegExp;
  from?: string | RegExp;
  subject?: string | RegExp;
  text?: string | RegExp;
  html?: string | RegExp;
}

export class Mailbox {
  #messages: Mail[] = [];
  #waiters = new Set<() => void>();
  #sockets = new Set<net.Socket>();

  private constructor(private readonly server: net.Server) {}

  static async start() {
    const box: Mailbox = new Mailbox(net.createServer((socket) => box.#session(socket)));
    await new Promise<void>((resolve, reject) => {
      box.server.once("error", reject);
      box.server.listen(0, "127.0.0.1", resolve);
    });
    return box;
  }

  get host() {
    return "127.0.0.1";
  }

  get port() {
    return (this.server.address() as AddressInfo).port;
  }

  /** `smtp://127.0.0.1:<port>`, for libraries configured with a URL. */
  get url() {
    return `smtp://${this.host}:${this.port}`;
  }

  /** Messages received during this scenario, oldest first. */
  messages(filter: MailFilter = {}) {
    return this.#messages.filter((m) => matches(m, filter));
  }

  /** The most recent message matching `filter`, or undefined. */
  last(filter: MailFilter = {}) {
    return this.messages(filter).at(-1);
  }

  /**
   * The first message matching `filter`, waiting up to `within` ms for the app
   * to send it. Fails with the messages that did arrive.
   */
  async waitFor(filter: MailFilter = {}, { within: wanted = 5000 } = {}): Promise<Mail> {
    const { ms: within, note } = waitBudget(wanted);
    const deadline = Date.now() + within;
    for (;;) {
      const found = this.messages(filter)[0];
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`slicetest: no mail matching ${describeFilter(filter)} within ${within}ms${note}\n${this.describe()}`);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.#waiters.add(done);
      });
    }
  }

  /** One line per message received this scenario, for failure output. */
  describe() {
    if (this.#messages.length === 0) return "mail sent during this scenario: (none)";
    return `mail sent during this scenario:\n${this.#messages.map((m) => `  ${m.from} → ${m.to.join(", ")}: ${JSON.stringify(m.subject)}`).join("\n")}`;
  }

  reset() {
    this.#messages = [];
  }

  async close() {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  #receive(mail: Mail) {
    this.#messages.push(mail);
    for (const w of [...this.#waiters]) w();
  }

  /** A minimal SMTP (RFC 5321) session: no TLS, AUTH accepted, one message per MAIL … DATA. */
  #session(socket: net.Socket) {
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => {});
    const reply = (line: string) => socket.write(`${line}\r\n`);
    let buffer = "";
    let from = "";
    let to: string[] = [];
    let data: string[] | undefined;
    let auth: "login-user" | "login-pass" | "plain" | undefined;

    reply("220 slicetest ESMTP");
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (data) {
          if (line === ".") {
            this.#receive(parseMail(data.join("\r\n"), from, to));
            data = undefined;
            reply("250 OK: queued");
          } else data.push(line.startsWith(".") ? line.slice(1) : line);
          continue;
        }
        if (auth) {
          auth = auth === "login-user" ? "login-pass" : undefined;
          reply(auth ? "334 UGFzc3dvcmQ6" : "235 Authentication successful");
          continue;
        }
        const [verb = "", ...rest] = line.split(" ");
        const arg = rest.join(" ");
        switch (verb.toUpperCase()) {
          case "EHLO":
            reply("250-slicetest");
            reply("250-AUTH PLAIN LOGIN");
            reply("250-8BITMIME");
            reply("250-SMTPUTF8");
            reply("250 SIZE 52428800");
            break;
          case "HELO":
            reply("250 slicetest");
            break;
          case "AUTH": {
            const [mech = "", initial] = arg.split(" ");
            if (mech.toUpperCase() === "LOGIN") {
              auth = initial ? "login-pass" : "login-user";
              reply(initial ? "334 UGFzc3dvcmQ6" : "334 VXNlcm5hbWU6");
            } else if (initial) reply("235 Authentication successful");
            else {
              auth = "plain";
              reply("334 ");
            }
            break;
          }
          case "MAIL":
            from = address(arg);
            to = [];
            reply("250 OK");
            break;
          case "RCPT":
            to.push(address(arg));
            reply("250 OK");
            break;
          case "DATA":
            if (to.length === 0) reply("503 RCPT first");
            else {
              data = [];
              reply("354 End data with <CR><LF>.<CR><LF>");
            }
            break;
          case "RSET":
            from = "";
            to = [];
            reply("250 OK");
            break;
          case "NOOP":
            reply("250 OK");
            break;
          case "QUIT":
            reply("221 Bye");
            socket.end();
            break;
          default:
            reply(`502 ${verb} not implemented`);
        }
      }
    });
  }
}

function address(arg: string) {
  const m = /<([^>]*)>/.exec(arg) ?? /:\s*(\S+)/.exec(arg);
  return (m?.[1] ?? "").trim();
}

function matches(mail: Mail, f: MailFilter) {
  const addr = (want: string | RegExp | undefined, values: string[]) =>
    want === undefined || values.some((v) => (typeof want === "string" ? v.toLowerCase() === want.toLowerCase() : test(want, v)));
  const text = (want: string | RegExp | undefined, value: string | undefined) =>
    want === undefined || (value !== undefined && (typeof want === "string" ? value.includes(want) : test(want, value)));
  return addr(f.to, mail.to) && addr(f.from, [mail.from]) && text(f.subject, mail.subject) && text(f.text, mail.text) && text(f.html, mail.html);
}

function test(re: RegExp, s: string) {
  re.lastIndex = 0;
  return re.test(s);
}

function describeFilter(f: MailFilter) {
  const parts = Object.entries(f).map(([k, v]) => `${k}: ${v instanceof RegExp ? String(v) : JSON.stringify(v)}`);
  return parts.length ? `{ ${parts.join(", ")} }` : "(any)";
}

interface Part {
  headers: Record<string, string>;
  body: string;
}

/** Headers are unfolded and lower-cased; the body is everything after the blank line. */
function splitPart(raw: string): Part {
  const end = raw.search(/\r?\n\r?\n/);
  const head = end < 0 ? raw : raw.slice(0, end);
  const body = end < 0 ? "" : raw.slice(end).replace(/^\r?\n\r?\n/, "");
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { headers, body };
}

export function parseMail(raw: string, from: string, to: string[]): Mail {
  const top = splitPart(raw);
  const texts: { type: string; text: string }[] = [];
  const walk = (part: Part) => {
    const type = (part.headers["content-type"] ?? "text/plain").toLowerCase();
    const boundary = /boundary="?([^";]+)"?/i.exec(part.headers["content-type"] ?? "")?.[1];
    if (type.startsWith("multipart/") && boundary) {
      const pieces = part.body.split(new RegExp(`\\r?\\n?--${escape(boundary)}(?:--)?[ \\t]*\\r?\\n?`));
      for (const piece of pieces.slice(1)) if (piece.trim()) walk(splitPart(piece));
      return;
    }
    if (!type.startsWith("text/") || /attachment/i.test(part.headers["content-disposition"] ?? "")) return;
    texts.push({ type, text: decodeBody(part) });
  };
  walk(top);
  const text = texts.find((t) => t.type.startsWith("text/plain"))?.text;
  const html = texts.find((t) => t.type.startsWith("text/html"))?.text;
  const headerFrom = /<([^>]+)>/.exec(top.headers.from ?? "")?.[1] ?? top.headers.from;
  return {
    from: from || headerFrom || "",
    to: to.length ? to : (top.headers.to ?? "").split(",").map((a) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim()).filter(Boolean),
    subject: decodeWords(top.headers.subject ?? ""),
    text: text ?? (html ? htmlToText(html) : ""),
    html,
    headers: Object.fromEntries(Object.entries(top.headers).map(([k, v]) => [k, decodeWords(v)])),
    links: links([text ?? "", html ?? ""].join("\n")),
    raw,
  };
}

function charsetOf(part: Part) {
  return /charset="?([^";]+)"?/i.exec(part.headers["content-type"] ?? "")?.[1] ?? "utf-8";
}

function decodeBody(part: Part) {
  const enc = (part.headers["content-transfer-encoding"] ?? "").toLowerCase();
  const bytes =
    enc === "base64" ? Buffer.from(part.body.replace(/\s+/g, ""), "base64")
    : enc === "quoted-printable" ? quotedPrintable(part.body)
    : Buffer.from(part.body, "utf8");
  return decodeCharset(bytes, charsetOf(part)).replace(/\r\n/g, "\n").replace(/\n$/, "");
}

function quotedPrintable(s: string) {
  const bytes: number[] = [];
  const src = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "=" && /^[0-9A-F]{2}$/i.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(src[i]!, "utf8"));
  }
  return Buffer.from(bytes);
}

function decodeCharset(bytes: Buffer, charset: string) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

/** RFC 2047 encoded words: `=?UTF-8?B?...?=` and `=?ISO-2022-JP?Q?...?=`. */
function decodeWords(s: string) {
  return s
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, enc: string, text: string) => {
      const bytes = enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : quotedPrintable(text.replace(/_/g, " "));
      return decodeCharset(bytes, charset);
    });
}

function htmlToText(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // One pass: replacing `&amp;` first turned the text `&lt;` (sent as `&amp;lt;`) into `<`.
    .replace(/&[^;\s]+;/g, (e) => decodeEntities(e))
    .trim();
}

function links(s: string) {
  const found = (s.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).map((u) => u.replace(/&amp;/g, "&").replace(/[.,;:!?]+$/, ""));
  return [...new Set(found)];
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
