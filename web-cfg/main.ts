// main.ts
// Deno web app to edit TOML-based .conf files via HTML form with enhancements:
// - Optional formatting-preserving save (best-effort scalar patching)
// - Input type inference (date, datetime-local, color, email, url, password)
// - Directory browser (/browse)
// - Simple validation schema (min/max/pattern/enum/required/type)
// - Optional Basic Auth via --auth=user:pass

// Basic run (serves on http://localhost:8787)
// deno run --allow-read --allow-write --allow-net main.ts --root=.

// Change port
// deno run --allow-read --allow-write --allow-net main.ts --root=. --port=8080

// Enable Basic Auth (username: admin, password: s3cret)
// deno run --allow-read --allow-write --allow-net main.ts --root=. --auth=admin:s3cret

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";
import * as toml from "https://deno.land/std@0.224.0/toml/mod.ts";
// ---------------- Types and Config ----------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface AppConfig {
  root: string; // root directory for reading/writing files
  port: number; // http port
  authUser?: string;
  authPass?: string;
}

function parseArgs(args: string[]): AppConfig {
  const config: AppConfig = {
    root: Deno.cwd(),
    port: 8787,
  };
  for (const a of args) {
    if (a.startsWith("--root=")) {
      config.root = path.resolve(a.substring("--root=".length));
    }
    if (a.startsWith("--port=")) {
      config.port = Number(a.substring("--port=".length)) || 8787;
    }
    if (a.startsWith("--auth=")) {
      const cred = a.substring("--auth=".length);
      const idx = cred.indexOf(":");
      if (idx > 0) {
        config.authUser = cred.slice(0, idx);
        config.authPass = cred.slice(idx + 1);
      }
    }
  }
  return config;
}

const app = parseArgs(Deno.args);

// ---------------- Auth ----------------

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Config Editor"' },
  });
}
function checkAuth(req: Request): boolean {
  if (!app.authUser || !app.authPass) return true;
  const hdr = req.headers.get("authorization") || "";
  if (!hdr.startsWith("Basic ")) return false;
  try {
    const decoded = atob(hdr.slice("Basic ".length));
    const [u, p] = decoded.split(":");
    return u === app.authUser && p === app.authPass;
  } catch {
    return false;
  }
}

// ---------------- File helpers ----------------
function ensureInsideRoot(candidate: string, root: string) {
  const full = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  if (
    !full.startsWith(normalizedRoot + path.SEPARATOR) && full !== normalizedRoot
  ) {
    throw new Error("Path is outside the permitted root directory");
  }
  return full;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await Deno.stat(p);
    return st.isFile;
  } catch {
    return false;
  }
}

async function pickSourceFile(requested: string): Promise<string | null> {
  // If requested exists: use it. Else try .example or .template variants
  if (await fileExists(requested)) return requested;
  const variants = [`${requested}.example`, `${requested}.template`];
  for (const v of variants) {
    if (await fileExists(v)) return v;
  }
  return null;
}

async function readTomlFile(
  filePath: string,
): Promise<{ data: Json; text: string }> {
  const text = await Deno.readTextFile(filePath);

  // Accept unquoted string values on input:
  // - Lines like: key = value   -> will be treated as: key = "value"
  // - Only when value looks like a bare string that TOML would normally reject.
  // - We keep numbers, booleans, dates, arrays, inline tables, quoted strings untouched.
  // - Works per section; comments preserved.
  const relaxed = (() => {
    const lines = text.split(/\r?\n/);
    const sectionHeaderRe = /^\s*\[[^\]]+\]\s*$/;
    const assignRe =
      /^(\s*[^#\s][^=]*?[^=\s]\s*=\s*)([^#"'\[\{#][^#]*?)(\s*(#.*)?)$/;
    //            ^lhs------------^   ^candidate value^   ^trailing comment^

    function looksLikeBareString(v: string): boolean {
      const trimmed = v.trim();

      // Already quoted?
      if (trimmed.startsWith('"') || trimmed.startsWith("'")) return false;

      // Inline arrays / tables
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) return false;

      // Booleans
      if (/^(true|false)$/i.test(trimmed)) return false;

      // Numbers (int/float/_ separators)
      if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(trimmed)) {
        return false;
      }

      // Date / datetime
      if (
        /^\d{4}-\d{2}-\d{2}(?:[ tT]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/
          .test(trimmed)
      ) {
        return false;
      }

      // Empty or whitespace only — keep as-is
      if (trimmed.length === 0) return false;

      // If contains an inline comment delimiter, the assignRe already split it out;
      // here we just ensure we won't break things that already look TOML-valid.
      return true;
    }

    return lines
      .map((line) => {
        if (sectionHeaderRe.test(line)) return line; // section header
        const m = line.match(assignRe);
        if (!m) return line;

        const lhs = m[1];
        const rawVal = m[2];
        const tail = m[3] ?? "";

        if (!looksLikeBareString(rawVal)) return line;

        // Quote while preserving inner content and escapes minimally.
        const quoted = `"${
          rawVal.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')
        }"`;
        return `${lhs}${quoted}${tail}`;
      })
      .join("\n");
  })();

  const data = toml.parse(relaxed) as Json;
  return { data, text };
}

function toToml(data: Json): string {
  // On output, we always produce TOML-compliant text where string values are quoted.
  // std toml.stringify already emits quoted strings; no change needed beyond using it.
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return toml.stringify({ value: data as unknown });
  }
  return toml.stringify(data as Record<string, unknown>);
}

// ---------------- Schema (example and extensible) ----------------

type SchemaRule =
  & {
    // dotted path, e.g., "server.port"
    type?:
      | "string"
      | "number"
      | "boolean"
      | "date"
      | "datetime-local"
      | "color"
      | "email"
      | "url"
      | "password";
    required?: boolean;
    min?: number;
    max?: number;
    pattern?: string; // JS regex string for validation
    enum?: string[]; // for dropdowns (strings)
    step?: number; // for numbers
    title?: string; // friendly label override
    placeholder?: string;
  }
  & Record<string, unknown>;

// Extend this with your known keys
const SCHEMA: Record<string, SchemaRule> = {
  "server.port": {
    type: "number",
    min: 1,
    max: 65535,
    step: 1,
    required: true,
    title: "Port",
  },
  "server.host": { type: "string", required: true, placeholder: "0.0.0.0" },
  "admin.email": { type: "email", required: true },
  "theme.accent": { type: "color" },
  "auth.enabled": { type: "boolean" },
  "auth.username": { type: "string", required: true },
  "auth.password": { type: "password", required: true },
};

// ---------------- HTML rendering ----------------

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inputName(pathParts: string[]): string {
  let name = pathParts[0] ?? "";
  for (let i = 1; i < pathParts.length; i++) {
    name += `[${pathParts[i]}]`;
  }
  return name;
}

function joinPath(parts: string[]): string {
  return parts.join(".");
}

function inferTypeFromValue(
  keyPath: string[],
  value: Json,
): string | undefined {
  const key = keyPath[keyPath.length - 1]?.toLowerCase() || "";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (typeof value === "string") {
    const v = value as string;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return "date";
    if (/^\d{4}-\d{2}-\d{2}[ tT]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/.test(v)) {
      return "datetime-local";
    }
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) return "color";
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || key.includes("email")) {
      return "email";
    }
    if (/^https?:\/\//i.test(v) || key.includes("url")) return "url";
    if (/(pass|password|secret|token)$/i.test(key)) return "password";
    return "text";
  }
  return undefined;
}

function ruleFor(pathParts: string[]): SchemaRule | undefined {
  return SCHEMA[joinPath(pathParts)];
}

function renderPrimitiveInput(keyPath: string[], value: Json) {
  const name = inputName(keyPath);
  const rule = ruleFor(keyPath);
  let typeAttr: string;

  if (rule?.type) {
    typeAttr = rule.type === "boolean" ? "checkbox" : rule.type;
  } else {
    typeAttr = inferTypeFromValue(keyPath, value) || "text";
  }

  const attrs: string[] = [];
  if (rule?.required) attrs.push("required");
  if (typeAttr === "number") {
    if (rule?.min !== undefined) attrs.push(`min="${rule.min}"`);
    if (rule?.max !== undefined) attrs.push(`max="${rule.max}"`);
    if (rule?.step !== undefined) attrs.push(`step="${rule.step}"`);
    else attrs.push('step="any"');
  }
  if (rule?.pattern) attrs.push(`pattern="${escapeHtml(rule.pattern)}"`);
  if (rule?.placeholder) {
    attrs.push(`placeholder="${escapeHtml(rule.placeholder)}"`);
  }

  const labelTitle = rule?.title || keyPath[keyPath.length - 1] || "";

  if (typeAttr === "checkbox") {
    const checked = typeof value === "boolean" ? value : false;
    return `
      <label title="${escapeHtml(labelTitle)}">
        <input type="checkbox" name="${escapeHtml(name)}" ${
      checked ? "checked" : ""
    } ${attrs.join(" ")} />
      </label>
    `;
  }

  if (typeAttr === "number") {
    const numVal = typeof value === "number" && Number.isFinite(value)
      ? value
      : "";
    return `<input type="number" name="${escapeHtml(name)}" value="${numVal}" ${
      attrs.join(" ")
    } />`;
  }

  // text-like inputs
  const str =
    value === null || typeof value === "boolean" || typeof value === "number"
      ? String(value ?? "")
      : (value as string);
  return `<input type="${escapeHtml(typeAttr)}" name="${
    escapeHtml(name)
  }" value="${escapeHtml(str)}" ${attrs.join(" ")} />`;
}

function renderArray(keyPath: string[], arr: Json[]): string {
  const legend = keyPath.length ? keyPath[keyPath.length - 1] : "(array)";
  const itemsHtml = arr
    .map((v, i) => {
      const itemPath = [...keyPath, String(i)];
      return `
        <div class="array-item">
          ${renderValue(itemPath, v)}
          <button class="remove-item" data-path="${
        escapeHtml(inputName(itemPath))
      }" type="button">Remove</button>
        </div>
      `;
    })
    .join("");

  const containerName = inputName(keyPath);
  return `
    <fieldset class="array">
      <legend>${escapeHtml(legend)} (array)</legend>
      <div data-array="${escapeHtml(containerName)}">
        ${itemsHtml || '<div class="empty-note">No items</div>'}
      </div>
      <button class="add-item" data-path="${
    escapeHtml(containerName)
  }" type="button">Add item</button>
    </fieldset>
  `;
}

function renderObject(keyPath: string[], obj: Record<string, Json>): string {
  const legend = keyPath.length ? keyPath[keyPath.length - 1] : "(root)";
  const fields = Object.entries(obj)
    .map(([k, v]) => {
      const p = [...keyPath, k];
      const rule = ruleFor(p);
      const label = rule?.title || k;
      return `
        <div class="field">
          <label><span class="key">${escapeHtml(label)}</span>
            ${renderValue(p, v)}
          </label>
        </div>
      `;
    })
    .join("");

  return `
    <fieldset class="object">
      <legend>${escapeHtml(legend)}</legend>
      ${fields || '<div class="empty-note">No fields</div>'}
    </fieldset>
  `;
}

function renderValue(keyPath: string[], v: Json): string {
  if (Array.isArray(v)) {
    return renderArray(keyPath, v);
  }
  if (v !== null && typeof v === "object") {
    return renderObject(keyPath, v as Record<string, Json>);
  }
  return renderPrimitiveInput(keyPath, v);
}

function pageLayout(body: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TOML Config Editor</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1rem auto; max-width: 900px; padding: 0 1rem; }
  header { display: flex; align-items: center; gap: 1rem; }
  fieldset { margin: 1rem 0; padding: 1rem; }
  legend { font-weight: 600; }
  .field { margin: .5rem 0; display: flex; gap: .5rem; align-items: center; }
  .field > label { display: flex; gap: .5rem; align-items: center; width: 100%; }
  .field input[type=text], .field input[type=number], .field input[type=email],
  .field input[type=url], .field input[type=password], .field input[type=datetime-local],
  .field input[type=date] { width: 100%; max-width: 28rem; }
  .array-item { display: flex; align-items: center; gap: .5rem; margin: .25rem 0; }
  .empty-note { color: #666; font-style: italic; }
  .actions { display: flex; gap: .5rem; margin-top: 1rem; flex-wrap: wrap; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .tip { color: #555; font-size: 0.9rem; }
  nav a { margin-right: .5rem; }
  table.file-list { border-collapse: collapse; width: 100%; }
  table.file-list th, table.file-list td { padding: .4rem .5rem; border-bottom: 1px solid #ddd; text-align: left; }
</style>
${extraHead}
</head>
<body>
${body}
</body>
</html>`;
}

function indexPage(): string {
  const body = `
    <header>
      <h1>TOML Config Editor</h1>
      <nav>
        <a href="/browse">Browse</a>
      </nav>
    </header>
    <p>Root directory: <span class="path">${escapeHtml(app.root)}</span></p>
    <form method="get" action="/edit">
      <label>Relative path to .conf file:
        <input type="text" name="file" placeholder="config/app.conf" required />
      </label>
      <p class="tip">
        If the file does not exist, the server will try "<code>.example</code>" or "<code>.template</code>" variants.
      </p>
      <button type="submit">Open</button>
    </form>
  `;
  return pageLayout(body);
}

function browsePage(list: Array<{ rel: string; size: number }>): string {
  const rows = list
    .map(
      (f) =>
        `<tr>
      <td><a href="/edit?file=${encodeURIComponent(f.rel)}">${
          escapeHtml(f.rel)
        }</a></td>
      <td>${f.size}</td>
    </tr>`,
    )
    .join("");
  const body = `
    <header>
      <h1>Browse .conf files</h1>
      <nav>
        <a href="/">Home</a>
      </nav>
    </header>
    <p class="tip">Listing *.conf plus *.conf.example and *.conf.template under: <span class="path">${
    escapeHtml(app.root)
  }</span></p>
    <table class="file-list">
      <thead><tr><th>Path</th><th>Size (bytes)</th></tr></thead>
      <tbody>${
    rows || '<tr><td colspan="2"><em>No files found</em></td></tr>'
  }</tbody>
    </table>
  `;
  return pageLayout(body);
}

function editPage(
  fileRel: string,
  usingPath: string,
  data: Json,
  originalText: string,
): string {
  const formHtml = renderValue([], data);
  const body = `
    <header>
      <h1>Edit: <span class="path">${escapeHtml(fileRel)}</span></h1>
      <nav>
        <a href="/">Home</a>
        <a href="/browse">Browse</a>
      </nav>
    </header>
    <p class="tip">
      Source file used: <span class="path">${escapeHtml(path.relative(app.root, usingPath))}</span>
    </p>

    <fieldset>
      <legend>Original text (after input normalization)</legend>
      <textarea id="originalTextView" readonly style="width:100%;height:200px;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;">${escapeHtml(originalText)}</textarea>
    </fieldset>

    <form id="config-form">
      ${formHtml}
      <div class="actions">
        <label><input type="checkbox" id="preserveFmt" checked /> Preserve formatting and comments (best effort)</label>
        <button type="button" id="save">Save</button>
        <label>Save As:
          <input type="text" id="saveAs" placeholder="${escapeHtml(fileRel)}" />
        </label>
        <button type="button" id="save-as">Save As…</button>
        <a href="/" style="margin-left:auto">Back</a>
      </div>
      <input type="hidden" id="fileRel" value="${escapeHtml(fileRel)}" />
      <input type="hidden" id="sourcePath" value="${escapeHtml(path.relative(app.root, usingPath))}" />
      <input type="hidden" id="originalText" value="${escapeHtml(originalText)}" />
    </form>
    <script type="module">
      function pathToArray(name) {
        const firstBracket = name.indexOf('[');
        if (firstBracket === -1) return [name];
        const parts = [name.slice(0, firstBracket)];
        const re = /\\[([^\\]]*)\\]/g;
        let m, rest = name.slice(firstBracket);
        while ((m = re.exec(rest))) parts.push(m[1]);
        return parts;
      }

      function setNested(target, keys, value) {
        let obj = target;
        for (let i = 0; i < keys.length - 1; i++) {
          const k = keys[i];
          const nextK = keys[i + 1];
          const isIndex = String(Number(nextK)) === nextK && nextK !== "";
          if (!(k in obj)) obj[k] = isIndex ? [] : {};
          if (Array.isArray(obj[k]) && !isIndex) obj[k] = {};
          obj = obj[k];
        }
        const lastKey = keys[keys.length - 1];
        obj[lastKey] = value;
      }

      function coerceValue(input) {
        if (input.type === "checkbox") return input.checked;
        if (input.type === "number") {
          const n = Number(input.value);
          return Number.isFinite(n) ? n : "";
        }
        return input.value;
      }

      function formToJson(formElement) {
        const root = {};
        const inputs = formElement.querySelectorAll("input, textarea, select");
        inputs.forEach(input => {
          const { name, id } = input;
          if (!name) return;
          if (id === "saveAs" || id === "fileRel" || id === "sourcePath" || id === "originalText") return;
          const value = coerceValue(input);
          const keys = pathToArray(name);
          setNested(root, keys, value);
        });

        function normalize(node) {
          if (Array.isArray(node)) return node.map(normalize);
          if (node && typeof node === "object") {
            const keys = Object.keys(node);
            const numeric = keys.length > 0 && keys.every(k => String(Number(k)) === k);
            if (numeric) {
              const arr = [];
              const sorted = keys.map(Number).sort((a,b)=>a-b);
              for (const i of sorted) arr.push(normalize(node[String(i)]));
              return arr;
            }
            const out = {};
            for (const k of keys) out[k] = normalize(node[k]);
            return out;
          }
          return node;
        }

        return normalize(root);
      }

      // Array UI handlers: add/remove
      document.addEventListener("click", (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        if (t.matches(".add-item")) {
          const containerName = t.getAttribute("data-path");
          const holder = document.querySelector('[data-array="' + CSS.escape(containerName) + '"]');
          if (!holder) return;
          const count = holder.querySelectorAll(".array-item").length;
          const name = containerName + "[" + count + "]";
          const div = document.createElement("div");
          div.className = "array-item";
          div.innerHTML = '<input type="text" name="' + name + '" value="" /> <button class="remove-item" data-path="' + name + '" type="button">Remove</button>';
          holder.appendChild(div);
        } else if (t.matches(".remove-item")) {
          const div = t.closest(".array-item");
          if (div) div.remove();
        }
      });

      async function save(kind) {
        const form = document.getElementById("config-form");
        const data = formToJson(form);

        // Avoid TS-only 'as' assertions in browser JS:
        const fileRelEl = document.getElementById("fileRel");
        const sourcePathEl = document.getElementById("sourcePath");
        const originalTextEl = document.getElementById("originalText");
        const saveAsEl = document.getElementById("saveAs");
        const preserveEl = document.getElementById("preserveFmt");

        const fileRel = fileRelEl && "value" in fileRelEl ? fileRelEl.value : "";
        const sourcePath = sourcePathEl && "value" in sourcePathEl ? sourcePathEl.value : "";
        const originalText = originalTextEl && "value" in originalTextEl ? originalTextEl.value : "";
        const saveAs = saveAsEl && "value" in saveAsEl ? saveAsEl.value.trim() : "";
        const preserve = !!(preserveEl && "checked" in preserveEl && preserveEl.checked);

        const body = {
          fileRel,
          sourcePath,
          originalText,
          data,
          mode: kind,
          saveAs: saveAs || null,
          preserve
        };
        const res = await fetch("/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) {
          alert("Save failed: " + json.error);
          return;
        }
        alert("Saved to: " + json.savedTo + (json.preserved ? " (format preserved)" : " (reformatted)"));
      }

      document.getElementById("save")?.addEventListener("click", () => save("overwrite"));
      document.getElementById("save-as")?.addEventListener("click", () => save("saveAs"));
    </script>
  `;
  return pageLayout(body);
}

// ---------------- Best-effort formatter-preserving patching ----------------

function quoteTomlString(s: string): string {
  // Always quote strings when writing, per TOML specification.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function valueToTomlScalar(v: Json): string | null {
  if (v === null) return "null"; // Not standard TOML; would typically be omitted or empty. We keep "null" to avoid parse errors in patch; fallback will stringify properly.
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "string") return quoteTomlString(v);
  return null;
}

function patchScalarInSection(
  text: string,
  sectionPath: string[],
  key: string,
  newValToml: string,
): { text: string; patched: boolean } {
  // Find section header [a.b] (or root if sectionPath.length===0), then replace "key = old" in that section.
  const lines = text.split(/\r?\n/);
  let inSection = sectionPath.length === 0;
  const sectionHeaderRe = /^\s*\[([^\]]+)\]\s*$/;
  const targetHeader = sectionPath.join(".");
  let patched = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(sectionHeaderRe);
    if (m) {
      const hdr = m[1].trim();
      inSection = hdr === targetHeader;
      continue;
    }
    if (!inSection) continue;
    // Within the section (or root), find key = ...
    // Allow spaces, inline comments, and different quoting
    const keyRe = new RegExp(
      `^(\\s*)(${
        key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")
      })\\s*=\\s*([^#]*)(\\s*(#.*)?)$`,
    );
    const km = lines[i].match(keyRe);
    if (km) {
      const indent = km[1] ?? "";
      const tailComment = km[4] ?? "";
      lines[i] = `${indent}${key} = ${newValToml}${tailComment}`;
      patched = true;
      break;
    }
    // If we hit the next section header, stop searching
    if (lines[i].match(sectionHeaderRe)) break;
  }

  return { text: lines.join("\n"), patched };
}

function walkPatch(
  text: string,
  oldObj: any,
  newObj: any,
  pathAcc: string[] = [],
): { text: string; patchedAny: boolean } {
  let patchedAny = false;

  // For nested objects, descend into sections. For scalars at any depth, try to patch in place.
  const keys = new Set<string>([
    ...Object.keys(oldObj || {}),
    ...Object.keys(newObj || {}),
  ]);
  let outText = text;

  for (const k of keys) {
    const oldVal = oldObj ? oldObj[k] : undefined;
    const newVal = newObj ? newObj[k] : undefined;

    // Only attempt scalars; arrays/objects fallback to full stringify
    const newScalar = valueToTomlScalar(newVal as Json);
    const oldScalar = valueToTomlScalar(oldVal as Json);

    if (newScalar !== null && oldScalar !== null) {
      // scalar → scalar
      const sectionPath = pathAcc; // tables correspond to pathAcc
      const res = patchScalarInSection(outText, sectionPath, k, newScalar);
      outText = res.text;
      patchedAny = patchedAny || res.patched;
    } else if (
      newVal && typeof newVal === "object" && !Array.isArray(newVal) &&
      oldVal && typeof oldVal === "object" && !Array.isArray(oldVal)
    ) {
      // both objects → descend
      const res = walkPatch(outText, oldVal, newVal, [...pathAcc, k]);
      outText = res.text;
      patchedAny = patchedAny || res.patchedAny;
    } else {
      // Anything else (added/removed keys, arrays, complex) → skip here; caller may fallback
    }
  }

  return { text: outText, patchedAny };
}

// ---------------- HTTP handlers ----------------

function jsonHeaders() {
  return { "content-type": "application/json; charset=utf-8" };
}

async function handleIndex(req: Request): Promise<Response> {
  if (!checkAuth(req)) return unauthorized();
  return new Response(indexPage(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function collectConfFiles(
  root: string,
): Promise<Array<{ rel: string; size: number }>> {
  const out: Array<{ rel: string; size: number }> = [];
  for await (const entry of Deno.readDir(root)) {
    // recursive helper
  }
  async function walk(dir: string) {
    for await (const e of Deno.readDir(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory) {
        await walk(p);
      } else if (e.isFile) {
        const rel = path.relative(root, p);
        if (
          rel.endsWith(".conf") || rel.endsWith(".conf.example") ||
          rel.endsWith(".conf.template")
        ) {
          const st = await Deno.stat(p);
          out.push({ rel, size: st.size });
        }
      }
    }
  }
  await walk(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

async function handleBrowse(req: Request): Promise<Response> {
  if (!checkAuth(req)) return unauthorized();
  const list = await collectConfFiles(app.root);
  return new Response(browsePage(list), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleEdit(req: Request, url: URL): Promise<Response> {
  if (!checkAuth(req)) return unauthorized();
  const fileRel = url.searchParams.get("file");
  if (!fileRel) return new Response("Missing ?file=...", { status: 400 });

  const candidate = ensureInsideRoot(path.join(app.root, fileRel), app.root);
  const source = await pickSourceFile(candidate);
  if (!source) {
    const msg = pageLayout(`
      <h1>File not found</h1>
      <p>Could not find: <span class="path">${
      escapeHtml(path.relative(app.root, candidate))
    }</span></p>
      <p>Also tried: <code>.example</code> and <code>.template</code> variants.</p>
      <p><a href="/">Back</a></p>
    `);
    return new Response(msg, {
      headers: { "content-type": "text/html; charset=utf-8" },
      status: 404,
    });
  }

  try {
    const { data, text } = await readTomlFile(source);
    return new Response(
      editPage(fileRel, source, data, text),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  } catch (e: any) {
    console.error(e);
    return new Response("Failed to parse TOML: " + e.message, { status: 400 });
  }
}

async function handleSave(req: Request): Promise<Response> {
  if (!checkAuth(req)) return unauthorized();
  try {
    const payload = await req.json();
    const fileRel: string = payload.fileRel;
    const sourcePathRel: string = payload.sourcePath; // relative to root
    const mode: "overwrite" | "saveAs" = payload.mode;
    const saveAs: string | null = payload.saveAs;
    const data: Json = payload.data;
    const preserve: boolean = !!payload.preserve;
    const originalText: string | undefined = payload.originalText;

    if (!fileRel || !sourcePathRel || !mode) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: jsonHeaders() },
      );
    }

    const sourcePath = ensureInsideRoot(
      path.join(app.root, sourcePathRel),
      app.root,
    );
    const defaultTarget = ensureInsideRoot(
      path.join(app.root, fileRel),
      app.root,
    );

    let targetPath: string;
    if (mode === "overwrite") {
      targetPath = (await fileExists(defaultTarget))
        ? defaultTarget
        : sourcePath;
    } else {
      if (!saveAs) {
        return new Response(JSON.stringify({ error: "Missing saveAs name" }), {
          status: 400,
          headers: jsonHeaders(),
        });
      }
      targetPath = ensureInsideRoot(path.join(app.root, saveAs), app.root);
    }

    await Deno.mkdir(path.dirname(targetPath), { recursive: true });

    let outText: string;
    let preserved = false;

    if (preserve && originalText) {
      try {
        // Parse old object from original text to know structure (ignore errors silently)
        const oldObj = toml.parse(originalText) as Record<string, unknown>;
        const result = walkPatch(originalText, oldObj, data);
        if (result.patchedAny) {
          outText = result.text;
          preserved = true;
        } else {
          outText = toToml(data);
        }
      } catch {
        outText = toToml(data);
      }
    } else {
      outText = toToml(data);
    }

    await Deno.writeTextFile(targetPath, outText, { create: true });

    return new Response(
      JSON.stringify({
        ok: true,
        savedTo: path.relative(app.root, targetPath),
        preserved,
      }),
      {
        headers: jsonHeaders(),
      },
    );
  } catch (e: any) {
    console.error(e);
    return new Response(JSON.stringify({ error: e.message ?? String(e) }), {
      status: 500,
      headers: jsonHeaders(),
    });
  }
}

console.log(`Root: ${app.root}`);
// ---------------- Server ----------------

console.log(`Root: ${app.root}`);
console.log(
  `Listening on http://localhost:${app.port}${
    app.authUser ? " (Basic Auth enabled)" : ""
  }`,
);

serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return await handleIndex(req);
    }
    if (req.method === "GET" && url.pathname === "/browse") {
      return await handleBrowse(req);
    }
    if (req.method === "GET" && url.pathname === "/edit") {
      return await handleEdit(req, url);
    }
    if (req.method === "POST" && url.pathname === "/save") {
      return await handleSave(req);
    }

    return new Response("Not Found", { status: 404 });
  } catch (e) {
    console.error(e);
    return new Response("Internal Server Error", { status: 500 });
  }
}, { port: app.port });
