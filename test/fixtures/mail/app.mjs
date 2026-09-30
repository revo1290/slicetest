import http from "node:http";
import net from "node:net";

// Sends one message over SMTP the way a mail library would, without depending on one.
function sendMail({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(process.env.SMTP_PORT), process.env.SMTP_HOST);
    const lines = [
      "EHLO app",
      "MAIL FROM:<noreply@example.com>",
      `RCPT TO:<${to}>`,
      "DATA",
      `From: Example <noreply@example.com>\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${text}\r\n.`,
      "QUIT",
    ];
    socket.setEncoding("utf8");
    socket.on("data", () => {
      const next = lines.shift();
      if (next) socket.write(`${next}\r\n`);
    });
    socket.on("end", resolve);
    socket.on("error", reject);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://app");
    if (req.method === "POST" && url.pathname === "/signup") {
      const email = url.searchParams.get("email");
      // Sent after the response, like a background job would.
      setTimeout(() => sendMail({ to: email, subject: "Confirm your account", text: `Hi!\r\nConfirm: http://127.0.0.1:${process.env.PORT}/confirm/tok123` }), 100);
      return res.writeHead(202).end();
    }
    if (url.pathname.startsWith("/confirm/")) return res.writeHead(200).end(`confirmed ${url.pathname.slice(9)}`);
    res.writeHead(200).end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("app ready"));
