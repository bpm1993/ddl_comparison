// DDL Comparison - parses DDL schemas and renders a GitHub-style diff.

(function () {
  "use strict";

  // ---------- Parser ----------
  // Splits a comma-separated list of field definitions, respecting <...>, (...), and backticks.
  // Each element is one field at the current level.
  function splitTopLevel(ddl) {
    const parts = [];
    let depthAngle = 0;
    let depthParen = 0;
    let inBacktick = false;
    let buf = "";

    for (let i = 0; i < ddl.length; i++) {
      const ch = ddl[i];

      if (ch === "`") {
        inBacktick = !inBacktick;
        buf += ch;
        continue;
      }
      if (inBacktick) {
        buf += ch;
        continue;
      }

      if (ch === "<") depthAngle++;
      else if (ch === ">") depthAngle = Math.max(0, depthAngle - 1);
      else if (ch === "(") depthParen++;
      else if (ch === ")") depthParen = Math.max(0, depthParen - 1);

      if (ch === "," && depthAngle === 0 && depthParen === 0) {
        const trimmed = buf.trim();
        if (trimmed) parts.push(trimmed);
        buf = "";
        continue;
      }

      buf += ch;
    }
    const tail = buf.trim();
    if (tail) parts.push(tail);
    return parts;
  }

  // Splits a single field definition into (name, type, suffix).
  // Top-level field syntax:   `name` TYPE [NOT NULL] [COMMENT '...']
  // Struct field syntax:      `name`: TYPE
  // Returns { name, type, suffix } where type may itself be a complex expression.
  function splitField(def, isStructField) {
    // Extract name (backticked or bare)
    let rest = def.trim();
    let name = "";
    const bt = rest.match(/^`([^`]+)`/);
    if (bt) {
      name = bt[1];
      rest = rest.slice(bt[0].length).trim();
    } else {
      const m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (m) {
        name = m[1];
        rest = rest.slice(m[0].length).trim();
      }
    }
    // Struct field uses ':' separator
    if (isStructField && rest.startsWith(":")) rest = rest.slice(1).trim();

    // Now rest is "TYPE [extras]". Split type from suffix by finding the end of the type.
    const { type, suffix } = splitTypeAndSuffix(rest);
    return { name, type, suffix };
  }

  // Walks the string, captures the type (including any <...> and (...) groups) and returns
  // anything after as suffix (e.g. "NOT NULL", "COMMENT '...'").
  function splitTypeAndSuffix(s) {
    let depthAngle = 0;
    let depthParen = 0;
    let inBacktick = false;
    let inString = false;
    let typeEnd = s.length;
    let seenTypeStart = false;

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "`") { inBacktick = !inBacktick; continue; }
      if (inBacktick) continue;

      if (ch === "<") depthAngle++;
      else if (ch === ">") depthAngle = Math.max(0, depthAngle - 1);
      else if (ch === "(") depthParen++;
      else if (ch === ")") depthParen = Math.max(0, depthParen - 1);

      if (!/\s/.test(ch)) seenTypeStart = true;

      if (seenTypeStart && /\s/.test(ch) && depthAngle === 0 && depthParen === 0) {
        typeEnd = i;
        break;
      }
    }
    return {
      type: s.slice(0, typeEnd).trim(),
      suffix: s.slice(typeEnd).trim(),
    };
  }

  // Returns the inner content of a wrapping pair, e.g. peelWrapper("STRUCT<...>", "<", ">") -> "..."
  // Returns null if the head keyword/wrapper doesn't match.
  function peelStruct(type) {
    const m = type.match(/^STRUCT\s*<([\s\S]*)>\s*$/i);
    return m ? m[1] : null;
  }
  function peelArrayOfStruct(type) {
    // ARRAY<STRUCT<...>>
    const m = type.match(/^ARRAY\s*<\s*([\s\S]*)\s*>\s*$/i);
    if (!m) return null;
    const inner = m[1].trim();
    const struct = peelStruct(inner);
    return struct; // null if inner isn't a struct
  }
  function peelMap(type) {
    // MAP<K, V> - if V is a struct/array-of-struct, we could expand. For now,
    // we expose only V when it's complex.
    const m = type.match(/^MAP\s*<([\s\S]*)>\s*$/i);
    if (!m) return null;
    // split K,V at top-level
    const parts = splitTopLevel(m[1]);
    if (parts.length !== 2) return null;
    return { key: parts[0].trim(), value: parts[1].trim() };
  }

  // Flattens the DDL into a list of rows: { depth, name, type, suffix, raw, path, kind }
  // - kind: 'field' | 'struct-open' | 'array-struct-open' | 'map-value-open'
  // For complex types we emit a "header" row + child rows. The header shows the wrapper
  // (e.g. "STRUCT" / "ARRAY<STRUCT>"), and children are indented.
  function flattenFields(defs, depth, parentPath, isStructLevel) {
    const rows = [];
    for (const def of defs) {
      const { name, type, suffix } = splitField(def, isStructLevel);
      const path = parentPath ? `${parentPath}.${name}` : name;

      const structInner = peelStruct(type);
      const arrayStructInner = peelArrayOfStruct(type);
      const mapParts = peelMap(type);
      const mapValueStruct = mapParts ? peelStruct(mapParts.value) || peelArrayOfStruct(mapParts.value) : null;

      if (structInner !== null) {
        rows.push({
          depth, name, path,
          type: "STRUCT",
          suffix,
          raw: def,
          kind: "struct",
          isComposite: true,
        });
        const childDefs = splitTopLevel(structInner);
        rows.push(...flattenFields(childDefs, depth + 1, path, true));
      } else if (arrayStructInner !== null) {
        rows.push({
          depth, name, path,
          type: "ARRAY<STRUCT>",
          suffix,
          raw: def,
          kind: "array-struct",
          isComposite: true,
        });
        const childDefs = splitTopLevel(arrayStructInner);
        rows.push(...flattenFields(childDefs, depth + 1, path, true));
      } else if (mapValueStruct !== null) {
        rows.push({
          depth, name, path,
          type: `MAP<${mapParts.key}, STRUCT>`,
          suffix,
          raw: def,
          kind: "map-struct",
          isComposite: true,
        });
        const childDefs = splitTopLevel(mapValueStruct);
        rows.push(...flattenFields(childDefs, depth + 1, path, true));
      } else {
        rows.push({
          depth, name, path,
          type,
          suffix,
          raw: def,
          kind: "field",
          isComposite: false,
        });
      }
    }
    return rows;
  }

  function parseDDL(ddl) {
    const topDefs = splitTopLevel(ddl);
    const rows = flattenFields(topDefs, 0, "", false);
    return rows.map((r, idx) => ({ ...r, index: idx, normalized: normalizeRow(r) }));
  }

  function normalizeRow(r) {
    // Composite headers compare on (name, kind) only - children carry the rest.
    if (r.isComposite) return `${r.kind}::${r.suffix.replace(/\s+/g, " ").trim()}`;
    return `${(r.type || "").replace(/\s+/g, " ").trim()} ${(r.suffix || "").replace(/\s+/g, " ").trim()}`.trim();
  }

  // ---------- Diff ----------
  // Match rows by full path. Preserves A's order; B-only rows get slotted near their B predecessor.
  function diff(rowsA, rowsB) {
    const byPathB = new Map();
    rowsB.forEach((r) => byPathB.set(r.path, r));

    const usedB = new Set();
    const result = [];

    for (const a of rowsA) {
      const b = byPathB.get(a.path);
      if (b) {
        usedB.add(a.path);
        if (a.normalized === b.normalized) {
          result.push({ type: "unchanged", a, b });
        } else {
          result.push({ type: "modified", a, b });
        }
      } else {
        result.push({ type: "removed", a, b: null });
      }
    }

    const added = rowsB.filter((r) => !usedB.has(r.path));

    for (const addedRow of added) {
      const bIndex = addedRow.index;
      let insertAfter = -1;
      for (let j = bIndex - 1; j >= 0; j--) {
        const prevPath = rowsB[j].path;
        const anchorPath = insertionAnchorPath(prevPath, addedRow.path);
        insertAfter = findLastPathInResult(result, anchorPath);
        if (insertAfter !== -1) {
          break;
        }
      }
      const newRow = { type: "added", a: null, b: addedRow };
      if (insertAfter === -1) {
        result.splice(Math.min(bIndex, result.length), 0, newRow);
      } else {
        result.splice(insertAfter + 1, 0, newRow);
      }
    }

    return result;
  }

  function insertionAnchorPath(prevPath, addedPath) {
    const addedParent = parentPath(addedPath);
    if (!addedParent) return prevPath;
    if (prevPath === addedParent || isAncestorPath(prevPath, addedPath)) return prevPath;
    if (isAncestorPath(addedParent, prevPath)) return immediateChildPath(prevPath, addedParent);
    return prevPath;
  }

  function findLastPathInResult(rows, path) {
    let index = -1;
    for (let i = 0; i < rows.length; i++) {
      const aPath = rows[i].a && rows[i].a.path;
      const bPath = rows[i].b && rows[i].b.path;
      if (isSameOrDescendantPath(aPath, path) || isSameOrDescendantPath(bPath, path)) {
        index = i;
      }
    }
    return index;
  }

  function parentPath(path) {
    const idx = path.lastIndexOf(".");
    return idx === -1 ? "" : path.slice(0, idx);
  }

  function isAncestorPath(ancestor, path) {
    return Boolean(ancestor) && path.startsWith(`${ancestor}.`);
  }

  function isSameOrDescendantPath(path, parent) {
    return Boolean(path) && (path === parent || isAncestorPath(parent, path));
  }

  function immediateChildPath(path, parent) {
    const rest = path.slice(parent.length + 1);
    const nextDot = rest.indexOf(".");
    return nextDot === -1 ? path : `${parent}.${rest.slice(0, nextDot)}`;
  }

  // ---------- Render helpers ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // Token-level diff for "modified" rows
  function tokenize(def) {
    const tokens = [];
    const re = /`[^`]*`|<|>|\(|\)|,|:|[A-Za-z0-9_]+|\s+/g;
    let m;
    while ((m = re.exec(def)) !== null) tokens.push(m[0]);
    return tokens;
  }

  function tokenDiff(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ type: "eq", value: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", value: a[i] }); i++; }
      else { out.push({ type: "add", value: b[j] }); j++; }
    }
    while (i < n) out.push({ type: "del", value: a[i++] });
    while (j < m) out.push({ type: "add", value: b[j++] });
    return out;
  }

  function renderInline(diffTokens, side) {
    const keep = side === "left" ? "del" : "add";
    // Keep only "eq" and the relevant side's changes.
    let filtered = diffTokens.filter((tk) => tk.type === "eq" || tk.type === keep);

    // Whitespace-only tokens marked as "keep" would render as empty highlight bands;
    // demote them to "eq" so they merge with surrounding plain text.
    filtered = filtered.map((tk) =>
      tk.type !== "eq" && /^\s+$/.test(tk.value) ? { type: "eq", value: tk.value } : tk
    );

    // Promote whitespace-only "eq" tokens that sit BETWEEN two "keep" tokens to "keep",
    // so e.g. "NOT", " ", "NULL" merges into a single highlight span.
    filtered = filtered.map((tk, i, arr) => {
      if (tk.type !== "eq" || !/^\s+$/.test(tk.value)) return tk;
      const prev = arr[i - 1];
      const next = arr[i + 1];
      if (prev && next && prev.type === keep && next.type === keep) {
        return { type: keep, value: tk.value };
      }
      return tk;
    });

    // Merge consecutive tokens of the same type into a single span/string.
    const parts = [];
    let i = 0;
    while (i < filtered.length) {
      const type = filtered[i].type;
      let value = "";
      while (i < filtered.length && filtered[i].type === type) {
        value += filtered[i].value;
        i++;
      }
      if (type === "eq") parts.push(escapeHtml(value));
      else parts.push(`<span class="token-diff">${escapeHtml(value)}</span>`);
    }
    return parts.join("");
  }

  // Builds the visual line for a row at given depth.
  // depth=0 has no indent; deeper levels show "│  " guides + leaf marker.
  function lineHtml(row, inlineHtml) {
    const indent = indentHtml(row.depth);
    const namePart = `<span class="col-name">${escapeHtml(row.name)}</span>`;
    const typePart = inlineHtml != null
      ? inlineHtml
      : `${escapeHtml(row.type)}${row.suffix ? " " + escapeHtml(row.suffix) : ""}`;
    const wrapper = row.isComposite ? ` <span class="composite-tag">${escapeHtml(wrapperLabel(row))}</span>` : "";
    return `${indent}${namePart} ${typePart}${wrapper}`;
  }

  function wrapperLabel(row) {
    if (row.kind === "struct") return "{ struct }";
    if (row.kind === "array-struct") return "[ array<struct> ]";
    if (row.kind === "map-struct") return "{ map<…, struct> }";
    return "";
  }

  function indentHtml(depth) {
    if (depth <= 0) return "";
    let html = "";
    for (let i = 0; i < depth - 1; i++) html += `<span class="indent-guide">│  </span>`;
    html += `<span class="indent-guide">└─ </span>`;
    return html;
  }

  // For the inline (token-level) diff inside a "modified" row, we diff the type+suffix only,
  // since the name is unchanged (we only match by path).
  function modifiedInline(row, side) {
    const aText = `${row.a.type} ${row.a.suffix}`.trim();
    const bText = `${row.b.type} ${row.b.suffix}`.trim();
    if (aText === bText) {
      return side === "left" ? escapeHtml(aText) : escapeHtml(bText);
    }
    const tokens = tokenDiff(tokenize(aText), tokenize(bText));
    return renderInline(tokens, side);
  }

  // ---------- Render ----------
  function renderDiff(rows) {
    const body = document.getElementById("diff-body");
    body.innerHTML = "";

    if (rows.length === 0) {
      body.innerHTML = '<div class="empty-state">Nenhuma coluna encontrada.</div>';
      return;
    }

    let lnA = 0, lnB = 0;

    for (const row of rows) {
      const leftCell = document.createElement("div");
      const rightCell = document.createElement("div");
      leftCell.className = "diff-cell left";
      rightCell.className = "diff-cell right";

      if (row.type === "unchanged") {
        lnA++; lnB++;
        leftCell.innerHTML = cellHtml(lnA, " ", lineHtml(row.a));
        rightCell.innerHTML = cellHtml(lnB, " ", lineHtml(row.b));
      } else if (row.type === "modified") {
        lnA++; lnB++;
        leftCell.classList.add("modified");
        rightCell.classList.add("modified");
        const leftLine = lineHtml(row.a, modifiedInline(row, "left"));
        const rightLine = lineHtml(row.b, modifiedInline(row, "right"));
        leftCell.innerHTML = cellHtml(lnA, "~", leftLine);
        rightCell.innerHTML = cellHtml(lnB, "~", rightLine);
      } else if (row.type === "removed") {
        lnA++;
        leftCell.classList.add("removed");
        rightCell.classList.add("empty");
        leftCell.innerHTML = cellHtml(lnA, "-", lineHtml(row.a));
        rightCell.innerHTML = cellHtml("", "", "");
      } else if (row.type === "added") {
        lnB++;
        leftCell.classList.add("empty");
        rightCell.classList.add("added");
        leftCell.innerHTML = cellHtml("", "", "");
        rightCell.innerHTML = cellHtml(lnB, "+", lineHtml(row.b));
      }

      body.appendChild(leftCell);
      body.appendChild(rightCell);
    }
  }

  function cellHtml(ln, sign, code) {
    return `<span class="ln">${ln}</span><span class="sign">${sign}</span><span class="code">${code}</span>`;
  }

  function renderSummary(rows) {
    const counts = { added: 0, removed: 0, modified: 0, unchanged: 0 };
    for (const r of rows) counts[r.type]++;
    const el = document.getElementById("summary");
    el.innerHTML = `
      <div class="summary-item"><span class="badge added">+${counts.added}</span> added</div>
      <div class="summary-item"><span class="badge removed">-${counts.removed}</span> removed</div>
      <div class="summary-item"><span class="badge modified">~${counts.modified}</span> modified</div>
      <div class="summary-item"><span class="badge unchanged">${counts.unchanged}</span> unchanged</div>
    `;
    el.classList.remove("hidden");
  }

  // ---------- Theme ----------
  const THEME_KEY = "ddl-diff-theme";
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = theme === "dark" ? "☀ Light" : "☾ Dark";
  }
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const theme = saved || (prefersDark ? "dark" : "light");
    applyTheme(theme);
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  // ---------- Wire up UI ----------
  function compare() {
    const a = document.getElementById("ddl-a").value.trim();
    const b = document.getElementById("ddl-b").value.trim();
    const rowsA = parseDDL(a);
    const rowsB = parseDDL(b);
    const rows = diff(rowsA, rowsB);
    renderSummary(rows);
    renderDiff(rows);
    document.getElementById("diff").classList.remove("hidden");
  }

  const SAMPLE_A = "id BIGINT NOT NULL,name STRING,email STRING,created_at TIMESTAMP,profile STRUCT<age: INT, city: STRING, address: STRUCT<street: STRING, zip: STRING>>";
  const SAMPLE_B = "id BIGINT NOT NULL,name STRING NOT NULL,updated_at TIMESTAMP,profile STRUCT<age: INT, city: STRING, country: STRING, address: STRUCT<street: STRING, zip: STRING, number: INT>>,tags ARRAY<STRUCT<key: STRING, value: STRING>>";

  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
    document.getElementById("compare-btn").addEventListener("click", compare);
    document.getElementById("sample-btn").addEventListener("click", () => {
      document.getElementById("ddl-a").value = SAMPLE_A;
      document.getElementById("ddl-b").value = SAMPLE_B;
      compare();
    });
    document.getElementById("clear-btn").addEventListener("click", () => {
      document.getElementById("ddl-a").value = "";
      document.getElementById("ddl-b").value = "";
      document.getElementById("diff").classList.add("hidden");
      document.getElementById("summary").classList.add("hidden");
    });
  });
})();
