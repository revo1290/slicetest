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

test("file inputs: an empty file when none is given, the given File in a multipart form", async () => {
  const page = `<form method="post" action="/avatar" enctype="multipart/form-data">
    <input name="caption" value="me"><input type="file" name="avatar"><button>Upload</button></form>`;

  const none = formRequest(page).body as FormData;
  expect((none.get("avatar") as File).name).toBe("");
  expect((none.get("avatar") as File).size).toBe(0);

  const sent = formRequest(page, { fields: { avatar: new File(["png!"], "me.png", { type: "image/png" }) } }).body as FormData;
  const file = sent.get("avatar") as File;
  expect([file.name, file.type, await file.text()]).toEqual(["me.png", "image/png", "png!"]);
  expect(sent.get("caption")).toBe("me");

  expect(() => formRequest(page, { fields: { avatar: "me.png" } })).toThrow('"avatar" is a file input; give it a file');
  expect(() => formRequest(page, { fields: { caption: new Blob(["x"]) } })).toThrow('"caption" isn\'t a file input');
});

test("a file in a urlencoded form is refused; without one, the field is sent empty as browsers do", () => {
  const page = `<form method="post" action="/a"><input type="file" name="doc"><button>Go</button></form>`;
  expect(String(formRequest(page).body)).toBe("doc=");
  expect(() => formRequest(page, { fields: { doc: new File(["x"], "x.txt") } })).toThrow("can't carry files");
});

test("an image button sends the click position", () => {
  const page = `<form method="post" action="/pay"><input name="amount" value="5"><input type="image" name="pay" src="pay.png" alt="Pay"></form>`;
  expect(String(formRequest(page, { button: "Pay" }).body)).toBe("amount=5&pay.x=0&pay.y=0");
});

test("controls in a disabled fieldset aren't sent, and its buttons can't be pressed", () => {
  const page = `<form method="post" action="/a"><input name="keep" value="1">
    <fieldset disabled><input name="locked" value="2"><fieldset><input name="nested" value="3"></fieldset><button name="b">Locked</button></fieldset>
    <fieldset><input name="open" value="4"></fieldset><button>Go</button></form>`;
  expect(String(formRequest(page, { button: "Go" }).body)).toBe("keep=1&open=4");
  expect(() => formRequest(page, { button: "Locked" })).toThrow("is disabled");
});

test("selects skip disabled options and keep one selection, as browsers do: a disabled placeholder isn't sent", () => {
  const html = `<form method="post">
    <select name="plan"><option disabled>Choose a plan</option><option value="free">Free</option><option value="pro">Pro</option></select>
    <select name="size"><option value="" disabled selected>Pick a size</option><option>S</option></select>
    <select name="tier"><optgroup label="Old" disabled><option value="legacy">Legacy</option></optgroup><option value="new">New</option></select>
    <select name="one"><option selected>a</option><option selected>b</option></select>
    <select name="many" multiple><option selected>a</option><option selected disabled>b</option><option selected>c</option></select>
    <button>Save</button></form>`;

  expect(String(formRequest(html).body)).toBe("plan=free&tier=new&one=b&many=a&many=c");
  expect(String(formRequest(html, { fields: { size: "S" } }).body)).toBe("plan=free&size=S&tier=new&one=b&many=a&many=c");
});

test("a browser fills in _charset_ and the dirname fields of text controls", () => {
  const html = `<form method="post"><input type="hidden" name="_charset_" value="x"><input name="q" dirname="q.dir" value="a">
    <textarea name="body" dirname="body.dir">hi</textarea><input type="checkbox" name="c" dirname="c.dir" checked><input type="hidden" name="h" dirname="h.dir" value="1"></form>`;

  expect(entries(formRequest(html).body)).toEqual([
    ["_charset_", "UTF-8"],
    ["q", "a"],
    ["q.dir", "ltr"],
    ["body", "hi"],
    ["body.dir", "ltr"],
    ["c", "on"],
    ["h", "1"],
  ]);
  expect(entries(formRequest(html, { fields: { q: "b" } }).body)).toContainEqual(["q.dir", "ltr"]);
});

test("a typed choice must be one the page offers: a select by value or label, radios and checkboxes by value", () => {
  const html = `<form method="post">
    <select name="plan"><option value="free">Free</option><option value="pro">Pro plan</option><option value="old" disabled>Old</option></select>
    <input type="radio" name="size" value="s" checked><input type="radio" name="size" value="l">
    <input type="checkbox" name="t" value="a"><button>Go</button></form>`;

  expect(entries(formRequest(html, { fields: { plan: "Pro plan" } }).body)).toEqual([["plan", "pro"], ["size", "s"]]);
  expect(() => formRequest(html, { fields: { plan: "team" } })).toThrow('submit: the select "plan" has no option "team" (options: free "Free", pro "Pro plan"; disabled: old)');
  expect(() => formRequest(html, { fields: { plan: "old" } })).toThrow('has no option "old"');
  expect(() => formRequest(html, { fields: { size: "xl" } })).toThrow('submit: no radio button "size" has the value "xl" (values: s, l)');
  expect(() => formRequest(html, { fields: { t: ["b"] } })).toThrow('submit: no checkbox "t" has the value "b" (values: a)');
});

test("line breaks are sent as CRLF, as browsers send them", () => {
  const html = `<form method="post"><textarea name="note">a\nb</textarea><input name="x"><button>Go</button></form>`;
  expect(entries(formRequest(html, { fields: { x: "c\nd\re" } }).body)).toEqual([["note", "a\r\nb"], ["x", "c\r\nd\r\ne"]]);
  const multipart = html.replace('method="post"', 'method="post" enctype="multipart/form-data"');
  expect(entries(formRequest(multipart).body)).toEqual([["note", "a\r\nb"], ["x", ""]]);
});
