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
  /** Values typed into the form, by field name. A name the form doesn't have is an error (a typo, usually). */
  fields?: Record<string, string | number | boolean | (string | number)[]>;
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
  options: { value: string; selected: boolean }[];
}

interface ParsedForm {
  attrs: Record<string, string>;
  controls: Control[];
}

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const RAW_TEXT = new Set(["script", "style", "template"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

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

  const add = (control: Control) => {
    const formId = control.attrs.form;
    if (formId !== undefined) orphans.push({ formId, control });
    else current?.controls.push(control);
  };
  const closeOption = (end: number) => {
    if (!option || !select) return;
    const value = option.attrs.value ?? textOf(html.slice(option.start, end));
    select.options.push({ value, selected: "selected" in option.attrs });
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
      } else {
        select = { tag, attrs: parseAttrs(m[3] ?? ""), text: "", options: [] };
        add(select);
      }
      continue;
    }
    if (tag === "option" || tag === "optgroup") {
      closeOption(m.index);
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
  for (const [name, value] of Object.entries(opts.fields ?? {})) {
    if (!names.has(name)) {
      const shown = [...names].filter((n) => !n.startsWith("$ACTION_"));
      throw new Error(`slicetest: submit: the form has no field "${name}". Fields: ${shown.join(", ") || "(none)"}`);
    }
    typed.set(name, typeof value === "boolean" ? value : (Array.isArray(value) ? value : [value]).map(String));
  }

  // The successful controls, in document order (HTML's "constructing the entry list").
  // A typed value replaces what the page had: text for a field, the checked state for
  // checkboxes and radios (true / false, or the values to check), the options of a select.
  const entries: [string, string][] = [];
  const done = new Set<string>();
  for (const c of form.controls) {
    const name = c.attrs.name;
    if (name === undefined || "disabled" in c.attrs) continue;
    if (c.tag === "button" || isSubmit(c)) {
      if (c === button) entries.push([name, c.attrs.value ?? ""]);
      continue;
    }
    const type = c.tag === "input" ? (c.attrs.type ?? "text").toLowerCase() : c.tag;
    if (type === "reset" || type === "button" || type === "file") continue;
    const want = typed.get(name);
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
      const selected = c.options.filter((o) => o.selected);
      const chosen = selected.length ? selected : "multiple" in c.attrs || c.options.length === 0 ? [] : [c.options[0]!];
      for (const o of chosen) entries.push([name, o.value]);
    } else entries.push([name, c.attrs.value ?? ""]);
  }

  const pick = (attr: string) => (button && button.attrs[`form${attr}`] !== undefined ? button.attrs[`form${attr}`] : form.attrs[attr]);
  const method = (pick("method") ?? "get").toUpperCase() === "POST" ? "POST" : "GET";
  const action = pick("action") ?? "";
  if (method === "GET") return { method, action: `${action.replace(/[?#].*$/, "")}?${new URLSearchParams(entries)}` };
  const multipart = (pick("enctype") ?? "").toLowerCase() === "multipart/form-data";
  if (!multipart) return { method, action, body: new URLSearchParams(entries) };
  const body = new FormData();
  for (const [k, v] of entries) body.append(k, v);
  return { method, action, body };
}
