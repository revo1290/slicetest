import { expect, test } from "vitest";
import { formRequest, parseForms } from "../src/form.js";

const entries = (body: URLSearchParams | FormData | undefined) => [...(body?.entries() ?? [])];

// As Next.js 16 renders <button formAction={vote.bind(null, 1, "a")}> (nitaku's vote form).
const nextAction = `<form class="f"><button name="$ACTION_REF_0" formAction="" formEncType="multipart/form-data" formMethod="POST"><input type="hidden" name="$ACTION_0:1" value="[1,&quot;a&quot;]"/><input type="hidden" name="$ACTION_0:0" value="{&quot;id&quot;:&quot;60f15606&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/>犬</button><span>VS</span><button name="$ACTION_REF_1" formAction="" formEncType="multipart/form-data" formMethod="POST"><input type="hidden" name="$ACTION_1:1" value="[1,&quot;b&quot;]"/><input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;60f15606&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/>猫</button></form>`;

test("a Next.js server action: the pressed button's formAction settings, every hidden input and the button's name", () => {
  const req = formRequest(nextAction, { button: "猫" });

  expect(req.method).toBe("POST");
  expect(req.action).toBe("");
  expect(req.body).toBeInstanceOf(FormData);
  expect(entries(req.body)).toEqual([
    ["$ACTION_0:1", '[1,"a"]'],
    ["$ACTION_0:0", '{"id":"60f15606","bound":"$@1"}'],
    ["$ACTION_REF_1", ""],
    ["$ACTION_1:1", '[1,"b"]'],
    ["$ACTION_1:0", '{"id":"60f15606","bound":"$@1"}'],
  ]);
});

test("a CSRF-protected login form: hidden token, typed fields, checkbox and select defaults", () => {
  const html = `
    <form action="/login?next=/home" method="post" id="login">
      <input type="hidden" name="authenticity_token" value="t0k&amp;en">
      <input name="email" type="email"><input name="password" type="password" value="">
      <input type="checkbox" name="remember" value="1">
      <input type="checkbox" name="terms" checked>
      <select name="lang"><option value="en">English</option><option selected>日本語</option></select>
      <select name="tz"><option>UTC</option><option>JST</option></select>
      <textarea name="note">
line &lt;1&gt;</textarea>
      <input name="off" disabled value="x">
      <input type="submit" value="Log in">
    </form>`;

  const req = formRequest(html, { fields: { email: "a@b.test", password: "pw", remember: true } });

  expect(req).toMatchObject({ method: "POST", action: "/login?next=/home" });
  expect(req.body).toBeInstanceOf(URLSearchParams);
  expect(entries(req.body)).toEqual([
    ["authenticity_token", "t0k&en"],
    ["email", "a@b.test"],
    ["password", "pw"],
    ["remember", "1"],
    ["terms", "on"],
    ["lang", "日本語"],
    ["tz", "UTC"],
    ["note", "line <1>"],
  ]);
});

test("radios and checkboxes are checked by value", () => {
  const html = `<form method="post"><input type="radio" name="size" value="s" checked><input type="radio" name="size" value="l"><input type="checkbox" name="t" value="a"><input type="checkbox" name="t" value="b" checked><button>Go</button></form>`;

  expect(entries(formRequest(html).body)).toEqual([["size", "s"], ["t", "b"]]);
  expect(entries(formRequest(html, { fields: { size: "l", t: ["a"] } }).body)).toEqual([["size", "l"], ["t", "a"]]);
  expect(entries(formRequest(html, { fields: { t: true } }).body)).toEqual([["size", "s"], ["t", "a"], ["t", "b"]]);
});

test("GET forms put the fields in the query; unchecking with false; lists for repeated names", () => {
  const html = `<form action="/search?old=1"><input name="q"><input type="checkbox" name="tag" value="a" checked><input type="checkbox" name="tag" value="b"><button>Go</button></form>`;

  expect(formRequest(html, { fields: { q: "x y" } })).toEqual({ method: "GET", action: "/search?q=x+y&tag=a" });
  expect(formRequest(html, { fields: { tag: false } }).action).toBe("/search?q=");
  expect(formRequest(html, { fields: { tag: ["a", "b"] } }).action).toBe("/search?q=&tag=a&tag=b");
});

test("picks the form by button, id, name or index; controls with form= join their form; scripts are skipped", () => {
  const html = `
    <script>const s = "<form id='fake'>";</script>
    <form id="a" method="post" action="/a"><button name="go" value="1">Save</button></form>
    <form name="b" method="post" action="/b"><button type="button">Cancel</button><input type="image" alt="Send"></form>
    <input form="a" name="outside" value="o">`;

  expect(parseForms(html)).toHaveLength(2);
  expect(formRequest(html, { button: "Save" })).toMatchObject({ action: "/a" });
  expect(entries(formRequest(html, { button: "Save" }).body)).toEqual([["go", "1"], ["outside", "o"]]);
  expect(formRequest(html, { form: "b" })).toMatchObject({ action: "/b" });
  expect(formRequest(html, { button: "Send" })).toMatchObject({ action: "/b" });
  expect(formRequest(html, { form: 0 })).toMatchObject({ action: "/a" });
});

test("explains what is on the page when the form, button or field doesn't exist", () => {
  const html = `<form id="a" method="post" action="/a"><input name="email"><button>Save</button></form><form action="/s"><button>Search</button></form>`;

  expect(() => formRequest("<p>no forms</p>")).toThrow("the page has no <form>");
  expect(() => formRequest(html)).toThrow(/the page has 2 forms; pick one with `button` or `form`. Forms:\n  #a \(POST \/a; buttons: "Save"\)\n  form 1 \(GET \/s; buttons: "Search"\)/);
  expect(() => formRequest(html, { button: "Delete" })).toThrow('no submit button "Delete"');
  expect(() => formRequest(html, { form: "x" })).toThrow('no form "x" on the page');
  expect(() => formRequest(html, { button: "Save", fields: { emial: "x" } })).toThrow('the form has no field "emial". Fields: email');
  expect(() => formRequest(`<form><button disabled>Go</button></form>`, { button: "Go" })).toThrow("is disabled");
});
