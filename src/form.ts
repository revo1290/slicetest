/**
 * Submitting an HTML form the way a browser with JavaScript off does: every
 * successful control of the form, plus the button that was pressed. This is
 * what makes hidden fields work without the test knowing about them: CSRF
 * tokens (Django, Rails, Laravel) and Next.js / Remix server actions, whose
 * forms carry the action id and bound arguments in hidden inputs.
 */

export interface SubmitOptions {
  /**
   * The submit button to press, by its text, `value`, `name` or `id`. Pressing it
   * also picks its form. Default: the form's only submit button, or none.
   */
  button?: string;
  /** The form, by `id`, `name` or position (0-based), when the page has several and no `button` picks one. */
  form?: string | number;
  /**
   * Values typed into the form, by field name. A name the form doesn't have is an error (a typo, usually).
   * A file input takes a `Blob` / `File` (its name is the file name sent), and the form must be multipart.
   */
  fields?: Record<string, string | number | boolean | (string | number)[] | Blob>;
}

export interface FormRequest {
  method: "GET" | "POST";
  /** Path (and query) relative to the page. */
  action: string;
  body?: URLSearchParams | FormData;
}

interface Control {
  tag: "input" | "button" | "select" | "textarea";
  attrs: Record<string, string>;
  /** Text content: a button's label, a textarea's value. */
  text: string;
  /** For select: its options. */
  options: { value: string; label: string; selected: boolean; disabled: boolean }[];
}

interface ParsedForm {
  attrs: Record<string, string>;
  controls: Control[];
}

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const RAW_TEXT = new Set(["script", "style", "template"]);
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", yen: "¥", euro: "€", middot: "·", times: "×",
};

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s: string) {
  const attrs: Record<string, string> = {};
  for (const m of s.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

const textOf = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** The forms of a page with their controls, in document order. Controls with a `form="id"` attribute join that form. */
export function parseForms(html: string): ParsedForm[] {
  const forms: ParsedForm[] = [];
  const byId = new Map<string, ParsedForm>();
  const orphans: { formId: string; control: Control }[] = [];
  let current: ParsedForm | undefined;
  let open: { control: Control; start: number } | undefined;
  let select: Control | undefined;
  let option: { attrs: Record<string, string>; start: number } | undefined;
  let groupDisabled = false;

  // Controls inside a disabled <fieldset> are disabled too (and not submitted).
  const fieldsets: boolean[] = [];
  const add = (control: Control) => {
    if (fieldsets.includes(true)) control.attrs.disabled ??= "";
    const formId = control.attrs.form;
    if (formId !== undefined) orphans.push({ formId, control });
    else current?.controls.push(control);
  };
  const closeOption = (end: number) => {
    if (!option || !select) return;
    const label = textOf(html.slice(option.start, end));
    select.options.push({ value: option.attrs.value ?? label, label, selected: "selected" in option.attrs, disabled: "disabled" in option.attrs || groupDisabled });
    option = undefined;
  };

  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    if (!m[2]) continue; // comment
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (!closing && RAW_TEXT.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, TAG.lastIndex);
      TAG.lastIndex = end < 0 ? html.length : end;
      continue;
    }
    if (tag === "fieldset") {
      if (closing) fieldsets.pop();
      else fieldsets.push("disabled" in parseAttrs(m[3] ?? ""));
      continue;
    }
    if (tag === "form") {
      if (closing) current = undefined;
      else if (!current) {
        current = { attrs: parseAttrs(m[3] ?? ""), controls: [] };
        forms.push(current);
        if (current.attrs.id) byId.set(current.attrs.id, current);
      }
      continue;
    }
    if (tag === "button" || tag === "textarea") {
      if (closing) {
        if (open?.control.tag === tag) {
          open.control.text = tag === "textarea" ? decodeEntities(html.slice(open.start, m.index)).replace(/^\r?\n/, "") : textOf(html.slice(open.start, m.index));
          open = undefined;
        }
      } else {
        const control: Control = { tag, attrs: parseAttrs(m[3] ?? ""), text: "", options: [] };
        add(control);
        open = { control, start: TAG.lastIndex };
        if (tag === "textarea") {
          // Its content is text, not markup.
          const end = html.toLowerCase().indexOf("</textarea", TAG.lastIndex);
          TAG.lastIndex = end < 0 ? html.length : end;
        }
      }
      continue;
    }
    if (tag === "select") {
      if (closing) {
        closeOption(m.index);
        select = undefined;
        groupDisabled = false;
      } else {
        select = { tag, attrs: parseAttrs(m[3] ?? ""), text: "", options: [] };
        add(select);
      }
      continue;
    }
    if (tag === "option" || tag === "optgroup") {
      closeOption(m.index);
      if (tag === "optgroup") groupDisabled = !closing && "disabled" in parseAttrs(m[3] ?? "");
      if (tag === "option" && !closing && select) option = { attrs: parseAttrs(m[3] ?? ""), start: TAG.lastIndex };
      continue;
    }
    if (tag === "input" && !closing) add({ tag, attrs: parseAttrs(m[3] ?? ""), text: "", options: [] });
  }
  for (const { formId, control } of orphans) byId.get(formId)?.controls.push(control);
  return forms;
}

const isSubmit = (c: Control) =>
  (c.tag === "button" && (c.attrs.type ?? "submit").toLowerCase() === "submit") || (c.tag === "input" && ["submit", "image"].includes((c.attrs.type ?? "").toLowerCase()));

const label = (c: Control) => (c.tag === "button" ? c.text : (c.attrs.value ?? (c.attrs.type?.toLowerCase() === "image" ? (c.attrs.alt ?? "") : "Submit")));

function describe(form: ParsedForm, i: number) {
  const name = form.attrs.id ? `#${form.attrs.id}` : form.attrs.name ? `name=${form.attrs.name}` : `form ${i}`;
  const buttons = form.controls.filter(isSubmit).map((b) => JSON.stringify(label(b)));
  return `${name} (${(form.attrs.method ?? "get").toUpperCase()} ${form.attrs.action || "<this page>"}; buttons: ${buttons.join(", ") || "none"})`;
}

/** Works out the request a browser would send for this page's form. */
export function formRequest(html: string, opts: SubmitOptions = {}): FormRequest {
  const forms = parseForms(html);
  const list = () => (forms.length ? forms.map((f, i) => `  ${describe(f, i)}`).join("\n") : "  (none)");
  if (forms.length === 0) throw new Error("slicetest: submit: the page has no <form>");

  let form: ParsedForm | undefined;
  if (opts.form !== undefined) {
    form = typeof opts.form === "number" ? forms[opts.form] : forms.find((f) => f.attrs.id === opts.form || f.attrs.name === opts.form);
    if (!form) throw new Error(`slicetest: submit: no form ${JSON.stringify(opts.form)} on the page. Forms:\n${list()}`);
  }

  let button: Control | undefined;
  if (opts.button !== undefined) {
    const want = opts.button.trim();
    const matches = (b: Control) => [label(b).trim(), b.attrs.value, b.attrs.name, b.attrs.id].includes(want);
    const candidates = (form ? [form] : forms).flatMap((f) => f.controls.filter((c) => isSubmit(c) && matches(c)).map((c) => ({ f, c })));
    if (candidates.length === 0) throw new Error(`slicetest: submit: no submit button ${JSON.stringify(want)}${form ? " in that form" : ""}. Forms:\n${list()}`);
    if (candidates.length > 1 && new Set(candidates.map((x) => x.f)).size > 1) {
      throw new Error(`slicetest: submit: ${candidates.length} forms have a button ${JSON.stringify(want)}; pick one with \`form\`. Forms:\n${list()}`);
    }
    form = candidates[0]!.f;
    button = candidates[0]!.c;
  }
  if (!form) {
    if (forms.length > 1) throw new Error(`slicetest: submit: the page has ${forms.length} forms; pick one with \`button\` or \`form\`. Forms:\n${list()}`);
    form = forms[0]!;
  }
  if (!button) {
    const submits = form.controls.filter(isSubmit);
    if (submits.length === 1) button = submits[0];
  }
  if (button && "disabled" in button.attrs) throw new Error(`slicetest: submit: the button ${JSON.stringify(label(button))} is disabled`);

  const names = new Set(form.controls.filter((c) => c.attrs.name !== undefined && !isSubmit(c) && c.tag !== "button").map((c) => c.attrs.name!));
  const typed = new Map<string, string[] | boolean>();
  const files = new Map<string, Blob>();
  const fileInputs = new Set(form.controls.filter((c) => c.tag === "input" && c.attrs.type?.toLowerCase() === "file").map((c) => c.attrs.name));
  for (const [name, value] of Object.entries(opts.fields ?? {})) {
    if (!names.has(name)) {
      const shown = [...names].filter((n) => !n.startsWith("$ACTION_"));
      throw new Error(`slicetest: submit: the form has no field "${name}". Fields: ${shown.join(", ") || "(none)"}`);
    }
    if (fileInputs.has(name) !== value instanceof Blob) {
      throw new Error(
        fileInputs.has(name)
          ? `slicetest: submit: "${name}" is a file input; give it a file (a Blob or File, or { file: path } in YAML)`
          : `slicetest: submit: "${name}" isn't a file input, so it can't take a file`,
      );
    }
    if (value instanceof Blob) files.set(name, value);
    else typed.set(name, typeof value === "boolean" ? value : offered(form, name, (Array.isArray(value) ? value : [value]).map(String)));
  }

  // The successful controls, in document order (HTML's "constructing the entry list").
  // A typed value replaces what the page had: text for a field, the checked state for
  // checkboxes and radios (true / false, or the values to check), the options of a select.
  const entries: [string, string | Blob][] = [];
  const done = new Set<string>();
  // A name shared by checkboxes and a hidden field (Rails' check_box sends `0` unless the box is checked): typing checks the boxes.
  const boxed = new Set(form.controls.filter((c) => c.tag === "input" && ["checkbox", "radio"].includes(c.attrs.type?.toLowerCase() ?? "")).map((c) => c.attrs.name));
  for (const c of form.controls) {
    const name = c.attrs.name;
    if (c === button && c.attrs.type?.toLowerCase() === "image") {
      // An image button sends the click position, as name.x / name.y (x / y without a name).
      const prefix = name ? `${name}.` : "";
      entries.push([`${prefix}x`, "0"], [`${prefix}y`, "0"]);
      continue;
    }
    if (name === undefined || "disabled" in c.attrs) continue;
    if (c.tag === "button" || isSubmit(c)) {
      if (c === button) entries.push([name, c.attrs.value ?? ""]);
      continue;
    }
    const type = c.tag === "input" ? (c.attrs.type ?? "text").toLowerCase() : c.tag;
    if (type === "reset" || type === "button") continue;
    if (type === "file") {
      // With no file chosen, browsers still send the field: an empty file without a name.
      const file = files.get(name);
      if (!done.has(name)) entries.push([name, file ?? new File([], "", { type: "application/octet-stream" })]);
      done.add(name);
      continue;
    }
    const want = type === "checkbox" || type === "radio" || !boxed.has(name) ? typed.get(name) : undefined;
    if (type === "checkbox" || type === "radio") {
      const value = c.attrs.value ?? "on";
      const checked = want === undefined ? "checked" in c.attrs : typeof want === "boolean" ? want : want.includes(value);
      if (checked) entries.push([name, value]);
    } else if (want !== undefined) {
      // Every value goes out at the first control of that name.
      if (!done.has(name)) for (const v of want === true ? ["on"] : want === false ? [] : want) entries.push([name, v]);
      done.add(name);
    } else if (c.tag === "textarea") entries.push([name, c.text]);
    else if (c.tag === "select") {
      // With nothing selected, a single select shows its first option that isn't disabled; disabled options are never sent.
      // A single select keeps only the last option marked selected.
      const marked = c.options.filter((o) => o.selected);
      const selected = "multiple" in c.attrs ? marked : marked.slice(-1);
      const first = c.options.find((o) => !o.disabled);
      const chosen = selected.length ? selected : "multiple" in c.attrs || !first ? [] : [first];
      for (const o of chosen) if (!o.disabled) entries.push([name, o.value]);
    } else entries.push([name, type === "hidden" && name === "_charset_" ? "UTF-8" : (c.attrs.value ?? "")]);
    // Text controls with a `dirname` also send their direction; left-to-right is what a test page has.
    if (c.attrs.dirname && (c.tag === "textarea" || ["text", "search", "tel", "url", "email"].includes(type))) entries.push([c.attrs.dirname, "ltr"]);
  }

  const pick = (attr: string) => (button && button.attrs[`form${attr}`] !== undefined ? button.attrs[`form${attr}`] : form.attrs[attr]);
  const method = (pick("method") ?? "get").toUpperCase() === "POST" ? "POST" : "GET";
  const action = pick("action") ?? "";
  const multipart = method === "POST" && (pick("enctype") ?? "").toLowerCase() === "multipart/form-data";
  if (files.size && !multipart) {
    throw new Error(`slicetest: submit: the form sends ${method === "GET" ? "a GET" : "urlencoded"} data, which can't carry files; a browser would send only the file name. Upload forms need method="post" enctype="multipart/form-data"`);
  }
  // Outside multipart, a file field is sent as its file name (empty when none was chosen), as browsers do.
  // Browsers send line breaks as CRLF; URLSearchParams would keep a bare "\n".
  for (const e of entries) {
    e[0] = crlf(e[0]);
    if (typeof e[1] === "string") e[1] = crlf(e[1]);
  }
  const plain = () => new URLSearchParams(entries.map(([k, v]) => [k, typeof v === "string" ? v : ((v as File).name ?? "")]));
  if (method === "GET") return { method, action: `${action.replace(/[?#].*$/, "")}?${plain()}` };
  if (!multipart) return { method, action, body: plain() };
  const body = new FormData();
  for (const [k, v] of entries) {
    if (typeof v === "string") body.append(k, v);
    else body.append(k, v, (v as File).name ?? "blob");
  }
  return { method, action, body };
}

const crlf = (s: string) => s.replace(/\r\n|\r|\n/g, "\r\n");

/**
 * Typed values for a select, radios or checkboxes, checked against what the page offers: a browser can't pick
 * anything else. A select option may be named by its label too; it is sent as its value.
 */
function offered(form: ParsedForm, name: string, values: string[]): string[] {
  const controls = form.controls.filter((c) => c.attrs.name === name && !("disabled" in c.attrs));
  const select = controls.find((c) => c.tag === "select");
  if (select) {
    const usable = select.options.filter((o) => !o.disabled);
    return values.map((v) => {
      const o = usable.find((x) => x.value === v) ?? usable.find((x) => x.label === v);
      if (o) return o.value;
      const off = select.options.filter((x) => x.disabled).map((x) => x.value);
      throw new Error(`slicetest: submit: the select "${name}" has no option ${JSON.stringify(v)} (options: ${usable.map((x) => `${x.value} ${JSON.stringify(x.label)}`).join(", ") || "none"}${off.length ? `; disabled: ${off.join(", ")}` : ""})`);
    });
  }
  for (const type of ["radio", "checkbox"]) {
    const boxes = controls.filter((c) => c.tag === "input" && c.attrs.type?.toLowerCase() === type);
    if (!boxes.length) continue;
    const have = boxes.map((c) => c.attrs.value ?? "on");
    const bad = values.find((v) => !have.includes(v));
    if (bad !== undefined) throw new Error(`slicetest: submit: no ${type === "radio" ? "radio button" : "checkbox"} "${name}" has the value ${JSON.stringify(bad)} (values: ${have.join(", ")})`);
  }
  return values;
}

/** Fields as `application/x-www-form-urlencoded`: lists repeat the key, nested objects use bracket keys (`metadata[order]`). */
export function encodeForm(fields: Record<string, unknown>) {
  const out = new URLSearchParams();
  const add = (key: string, v: unknown) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      const nested = v.some((x) => x !== null && typeof x === "object");
      v.forEach((x, i) => add(nested ? `${key}[${i}]` : key, x));
    } else if (typeof v === "object" && !(v instanceof Date)) {
      for (const [k, x] of Object.entries(v)) add(`${key}[${k}]`, x);
    } else out.append(key, v instanceof Date ? v.toISOString() : String(v));
  };
  for (const [k, v] of Object.entries(fields)) add(k, v);
  return out;
}
