// ... existing code ...

async function readTomlFile(filePath: string): Promise<{ data: Json; text: string }> {
  const text = await Deno.readTextFile(filePath);

  // Accept unquoted string values on input while preserving original text for later patching
  const relaxed = (() => {
    const lines = text.split(/\r?\n/);
    const sectionHeaderRe = /^\s*\[[^\]]+\]\s*$/;
    const assignRe =
      /^(\s*[^#\s][^=]*?[^=\s]\s*=\s*)([^#"'\[\{#][^#]*?)(\s*(#.*)?)$/;

    function looksLikeBareString(v: string): boolean {
      const trimmed = v.trim();
      if (trimmed.startsWith('"') || trimmed.startsWith("'")) return false;
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) return false;
      if (/^(true|false)$/i.test(trimmed)) return false;
      if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(trimmed)) return false;
      if (/^\d{4}-\d{2}-\d{2}(?:[ tT]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(trimmed)) return false;
      if (trimmed.length === 0) return false;
      return true;
    }

    return lines
      .map((line) => {
        if (sectionHeaderRe.test(line)) return line;
        const m = line.match(assignRe);
        if (!m) return line;
        const lhs = m[1];
        const rawVal = m[2];
        const tail = m[3] ?? "";
        if (!looksLikeBareString(rawVal)) return line;
        const quoted = `"${rawVal.trim().replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        return `${lhs}${quoted}${tail}`;
      })
      .join("\n");
  })();

  const data = toml.parse(relaxed) as Json;
  return { data, text }; // keep original text for comment-preserving patch
}

// ... existing code ...

// Best-effort formatter-preserving patching of scalars (preserves comments/spacing for touched lines)
function quoteTomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function valueToTomlScalar(v: Json): string | null {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "string") return quoteTomlString(v);
  return null;
}

function patchScalarInSection(text: string, sectionPath: string[], key: string, newValToml: string): { text: string; patched: boolean } {
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

    const keyRe = new RegExp(`^(\\s*)(${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")})\\s*=\\s*([^#]*)(\\s*(#.*)?)$`);
    const km = lines[i].match(keyRe);
    if (km) {
      const indent = km[1] ?? "";
      const tailComment = km[4] ?? "";
      lines[i] = `${indent}${key} = ${newValToml}${tailComment}`; // preserves inline comments
      patched = true;
      break;
    }
    if (lines[i].match(sectionHeaderRe)) break;
  }

  return { text: lines.join("\n"), patched };
}

function walkPatch(text: string, oldObj: any, newObj: any, pathAcc: string[] = []): { text: string; patchedAny: boolean } {
  let patchedAny = false;
  const keys = new Set<string>([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  let outText = text;

  for (const k of keys) {
    const oldVal = oldObj ? oldObj[k] : undefined;
    const newVal = newObj ? newObj[k] : undefined;

    const newScalar = valueToTomlScalar(newVal as Json);
    const oldScalar = valueToTomlScalar(oldVal as Json);

    if (newScalar !== null && oldScalar !== null) {
      const res = patchScalarInSection(outText, pathAcc, k, newScalar);
      outText = res.text;
      patchedAny = patchedAny || res.patched;
    } else if (newVal && typeof newVal === "object" && !Array.isArray(newVal) && oldVal && typeof oldVal === "object" && !Array.isArray(oldVal)) {
      const res = walkPatch(outText, oldVal, newVal, [...pathAcc, k]);
      outText = res.text;
      patchedAny = patchedAny || res.patchedAny;
    } else {
      // structural changes not patched here to avoid losing comments; handled by fallback
    }
  }

  return { text: outText, patchedAny };
}

function toToml(data: Json): string {
  // Fallback stringify (used when we can't safely patch); this will not preserve comments.
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return toml.stringify({ value: data as unknown });
    }
  return toml.stringify(data as Record<string, unknown>);
}

// ... existing code ...

async function handleSave(req: Request): Promise<Response> {
  // ... existing code ...
    let outText: string;
    let preserved = false;

    if (preserve && originalText) {
      try {
        const oldObj = toml.parse(originalText) as Record<string, unknown>;
        const result = walkPatch(originalText, oldObj, data);
        if (result.patchedAny) {
          outText = result.text; // comments and original formatting kept on patched lines/sections
          preserved = true;
        } else {
          outText = toToml(data); // fallback (may drop comments)
        }
      } catch {
        outText = toToml(data);
      }
    } else {
      outText = toToml(data);
    }
  // ... existing code ...
}
