function stripInlineComment(value) {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (quote === "'") {
      if (char === "'" && value[i + 1] === "'") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "#") return value.slice(0, i).trim();
  }
  return value.trim();
}

function parseScalar(value) {
  const scalar = stripInlineComment(value);
  if (scalar.length >= 2 && scalar[0] === '"' && scalar.at(-1) === '"') {
    try {
      return JSON.parse(scalar);
    } catch {}
  }
  if (scalar.length >= 2 && scalar[0] === "'" && scalar.at(-1) === "'") {
    return scalar.slice(1, -1).replace(/''/g, "'");
  }
  return scalar;
}

export function readAgentDefaultField(text, field, fallback = "") {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  let sectionIndent = -1;
  let childIndent = -1;

  for (const line of lines) {
    if (sectionIndent < 0) {
      const section = line.match(/^([ \t]*)agent-default-model\s*:\s*(?:#.*)?$/);
      if (section) sectionIndent = section[1].length;
      continue;
    }

    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = (line.match(/^[ \t]*/) || [""])[0].length;
    if (indent <= sectionIndent) break;
    if (childIndent < 0) childIndent = indent;
    if (indent !== childIndent) continue;

    const entry = line.slice(indent).match(/^([^:#]+?)\s*:\s*(.*)$/);
    if (!entry || entry[1].trim() !== field) continue;
    const value = parseScalar(entry[2]);
    return value || fallback;
  }

  return fallback;
}
