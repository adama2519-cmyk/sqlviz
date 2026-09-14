/*
 * SQLViz — SQL DDL parser
 * Parses raw CREATE TABLE statements (MySQL, PostgreSQL, SQLite flavoured)
 * into a schema model: tables, columns, types, primary keys, foreign keys.
 * Pure JS, no dependencies. Works in browser (window.SQLParser) and Node.
 */
(function (global) {
  'use strict';

  // ---- tokenizer -----------------------------------------------------------

  function stripComments(sql) {
    // Remove -- line comments and /* */ block comments, respecting '...' strings.
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
      const c = sql[i];
      const nc = sql[i + 1];
      if (c === '-' && nc === '-') {
        while (i < n && sql[i] !== '\n') i++;
        out += '\n';
      } else if (c === '#' && (i === 0 || sql[i - 1] === '\n' || sql[i - 1] === ' ')) {
        // MySQL # comment (best-effort, only when preceded by whitespace/start)
        while (i < n && sql[i] !== '\n') i++;
        out += '\n';
      } else if (c === '/' && nc === '*') {
        i += 2;
        while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i += 2;
      } else if (c === "'") {
        // string literal — copy through, don't touch comments inside
        const start = i;
        i++;
        while (i < n && sql[i] !== "'") {
          if (sql[i] === '\\') i++;
          i++;
        }
        i++; // closing quote
        out += sql.slice(start, i);
      } else if (c === '"') {
        const start = i;
        i++;
        while (i < n && sql[i] !== '"') {
          if (sql[i] === '\\') i++;
          i++;
        }
        i++;
        out += sql.slice(start, i);
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  function tokenize(str) {
    const tokens = [];
    let i = 0;
    const n = str.length;
    while (i < n) {
      const c = str[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '`') {
        let j = i + 1, val = '';
        while (j < n && str[j] !== '`') { val += str[j]; j++; }
        tokens.push({ v: val, t: 'id' });
        i = j + 1; continue;
      }
      if (c === '"') {
        let j = i + 1, val = '';
        while (j < n && str[j] !== '"') { val += str[j]; j++; }
        tokens.push({ v: val, t: 'id' });
        i = j + 1; continue;
      }
      if (c === "'") {
        let j = i + 1, val = '';
        while (j < n && str[j] !== "'") {
          if (str[j] === '\\' && j + 1 < n) { val += str[j + 1]; j += 2; continue; }
          val += str[j]; j++;
        }
        tokens.push({ v: val, t: 'str' });
        i = j + 1; continue;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(str[i + 1] || ''))) {
        let j = i;
        while (j < n && /[0-9.eE-]/.test(str[j])) j++;
        tokens.push({ v: str.slice(i, j), t: 'num' });
        i = j; continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(str[j])) j++;
        tokens.push({ v: str.slice(i, j), t: 'word' });
        i = j; continue;
      }
      // punctuation
      tokens.push({ v: c, t: 'punct' });
      i++;
    }
    return tokens;
  }

  // ---- helpers -------------------------------------------------------------

  const STOP_WORDS = new Set([
    'NOT', 'NULL', 'DEFAULT', 'PRIMARY', 'UNIQUE', 'AUTO_INCREMENT',
    'AUTOINCREMENT', 'REFERENCES', 'CHECK', 'COLLATE', 'COMMENT',
    'GENERATED', 'IDENTITY', 'CONSTRAINT'
  ]);

  // Read a possibly-qualified name like `schema.table` from tokens starting at i.
  // Returns { name, next } where name is the last segment unless keepQualified.
  function readName(tokens, i, keepQualified) {
    let parts = [];
    let j = i;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t.t === 'word' || t.t === 'id') {
        parts.push(t.v);
        j++;
      } else {
        break;
      }
      // optional dot for qualification
      if (tokens[j] && tokens[j].v === '.') {
        j++;
        continue;
      }
      break;
    }
    if (parts.length === 0) return { name: null, next: i };
    const full = parts.join('.');
    return {
      name: keepQualified ? full : parts[parts.length - 1],
      full: full,
      next: j
    };
  }

  function peek(tokens, i, val) {
    return tokens[i] && tokens[i].v.toUpperCase() === val;
  }

  // Join raw token values back into a compact type string: VARCHAR(255), DECIMAL(10,2).
  function joinTokens(parts) {
    let out = '';
    for (const p of parts) {
      if (out === '') { out = p; continue; }
      const prev = out[out.length - 1];
      if (p === ')' || p === ',' || p === '.' || p === '(') { out += p; }
      else if (prev === '(' || prev === '.' || prev === ',') { out += p; }
      else { out += ' ' + p; }
    }
    return out;
  }

  // Split a CREATE TABLE body on top-level commas.
  function splitTopLevel(body) {
    const items = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '(') { depth++; cur += c; continue; }
      if (c === ')') { depth--; cur += c; continue; }
      if (c === ',' && depth === 0) { items.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) items.push(cur);
    return items;
  }

  function findBalancedParen(str, openIdx) {
    let depth = 0;
    let inStr = null;
    for (let i = openIdx; i < str.length; i++) {
      const c = str[i];
      if (inStr) {
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function parseColumn(item) {
    const tokens = tokenize(item);
    if (!tokens.length) return null;
    const col = {
      name: null, type: '', notNull: false, pk: false, autoIncrement: false,
      unique: false, default: null, references: null
    };
    const first = readName(tokens, 0, false);
    if (!first.name) return null;
    col.name = first.name;
    let i = first.next;

    // type: consume until a STOP_WORD at top level
    let typeParts = [];
    let depth = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      const up = t.v.toUpperCase();
      if (t.t === 'punct') {
        if (t.v === '(') depth++;
        if (t.v === ')') depth--;
        if (depth < 0) depth = 0;
        typeParts.push(t.v);
        i++;
        continue;
      }
      if (depth === 0 && t.t === 'word' && STOP_WORDS.has(up)) break;
      typeParts.push(t.t === 'str' ? "'" + t.v + "'" : t.v);
      i++;
    }
    col.type = joinTokens(typeParts);

    // SERIAL / BIGSERIAL / SMALLSERIAL are implicitly auto-incrementing and NOT NULL
    const serialBt = col.type.replace(/\(.*\)/, '').trim().toUpperCase();
    if (serialBt === 'SERIAL' || serialBt === 'BIGSERIAL' || serialBt === 'SMALLSERIAL') {
      col.autoIncrement = true;
      col.notNull = true;
    }

    // constraints
    while (i < tokens.length) {
      const t = tokens[i];
      const up = t.v.toUpperCase();
      if (t.t !== 'word') { i++; continue; }
      if (up === 'NOT' && peek(tokens, i + 1, 'NULL')) { col.notNull = true; i += 2; continue; }
      if (up === 'NULL') { col.notNull = false; i += 1; continue; }
      if (up === 'PRIMARY' && peek(tokens, i + 1, 'KEY')) { col.pk = true; i += 2; continue; }
      if (up === 'UNIQUE') { col.unique = true; i += 1; if (peek(tokens, i, 'KEY')) i += 1; continue; }
      if (up === 'AUTO_INCREMENT' || up === 'AUTOINCREMENT' || up === 'IDENTITY') {
        col.autoIncrement = true; i += 1;
        // IDENTITY(1,1) / AUTOINCREMENT optional parens
        if (tokens[i] && tokens[i].v === '(') {
          let d = 0;
          while (i < tokens.length) { if (tokens[i].v === '(') d++; if (tokens[i].v === ')') { d--; if (d === 0) { i++; break; } } i++; }
        }
        continue;
      }
      if (up === 'DEFAULT') {
        i += 1;
        // read default value: literal, number, word, or function call with parens
        let dparts = [];
        let ddepth = 0;
        while (i < tokens.length) {
          const tt = tokens[i];
          const uu = tt.v.toUpperCase();
          if (ddepth === 0 && tt.t === 'word' && uu === 'ON') break;
          if (tt.v === '(') ddepth++;
          if (tt.v === ')') { ddepth--; if (ddepth < 0) break; }
          dparts.push(tt.v);
          i++;
          if (ddepth === 0 && dparts.length > 0 && (tt.t === 'num' || tt.t === 'str')) {
            // stop after a simple literal unless next starts a new clause
            break;
          }
        }
        col.default = dparts.join(' ').trim();
        // optional ON UPDATE <expr>
        if (peek(tokens, i, 'ON') && peek(tokens, i + 1, 'UPDATE')) {
          i += 2;
          let ddepth = 0;
          while (i < tokens.length) {
            const tt = tokens[i];
            if (tt.v === '(') ddepth++;
            if (tt.v === ')') { ddepth--; if (ddepth < 0) break; }
            i++;
            if (ddepth === 0) break;
          }
        }
        continue;
      }
      if (up === 'REFERENCES') {
        i += 1;
        const r = readName(tokens, i, true);
        const ref = { table: null, column: null };
        ref.table = r.full || r.name;
        i = r.next;
        // optional (col) or (col1, col2) — take first
        if (tokens[i] && tokens[i].v === '(') {
          i += 1;
          const cname = readName(tokens, i, false);
          ref.column = cname.name;
          i = cname.next;
          // skip to matching close paren
          let d = 1;
          while (i < tokens.length && d > 0) {
            if (tokens[i].v === '(') d++;
            if (tokens[i].v === ')') d--;
            i++;
          }
        }
        col.references = ref;
        // skip ON DELETE/UPDATE clauses
        while (peek(tokens, i, 'ON') && (peek(tokens, i + 1, 'DELETE') || peek(tokens, i + 1, 'UPDATE'))) {
          i += 2;
          if (tokens[i] && tokens[i].t === 'word') i += 1; // CASCADE / SET NULL (2 words) / NO ACTION
          if (peek(tokens, i, 'NULL') || peek(tokens, i, 'ACTION')) i += 1;
          if (peek(tokens, i, 'NULL') || peek(tokens, i, 'ACTION')) i += 1;
        }
        continue;
      }
      if (up === 'CHECK' || up === 'GENERATED') {
        i += 1;
        if (tokens[i] && tokens[i].v === '(') {
          let d = 0;
          while (i < tokens.length) { if (tokens[i].v === '(') d++; if (tokens[i].v === ')') { d--; if (d === 0) { i++; break; } } i++; }
        }
        // GENERATED ALWAYS AS (...) STORED — skip rest of clause tokens (words/expr)
        if (up === 'GENERATED') {
          while (i < tokens.length && tokens[i].t === 'word') {
            const w = tokens[i].v.toUpperCase();
            if (w === 'NOT' || w === 'NULL' || w === 'UNIQUE' || w === 'PRIMARY' || w === 'REFERENCES' || w === 'DEFAULT') break;
            i++;
          }
        }
        continue;
      }
      if (up === 'CONSTRAINT') {
        i += 1;
        if (tokens[i] && (tokens[i].t === 'word' || tokens[i].t === 'id')) i += 1;
        continue;
      }
      if (up === 'COLLATE') { i += 2; continue; }
      if (up === 'COMMENT') {
        i += 1;
        if (tokens[i] && tokens[i].t === 'str') i += 1;
        continue;
      }
      if (up === 'ON') { i += 2; continue; }
      // unknown — skip one
      i += 1;
    }
    return col;
  }

  // Parse one CREATE TABLE statement using raw text for the body.
  function parseCreateTable(statement) {
    const clean = stripComments(statement).trim();
    // Locate "CREATE TABLE" keyword and the name
    const m = /^CREATE\s+(TEMP(ORARY)?\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?/i.exec(clean);
    if (!m) return null;
    let rest = clean.slice(m[0].length).trim();

    // table name up to '('
    const openIdx = rest.indexOf('(');
    if (openIdx === -1) return null;
    const nameRaw = rest.slice(0, openIdx).trim();
    // strip trailing options after name (e.g., nothing here since '(' is first)
    const nameTokens = tokenize(nameRaw);
    const nr = readName(nameTokens, 0, true);
    if (!nr.name) return null;
    const table = {
      name: nr.name,
      fullName: nr.full || nr.name,
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      indexes: []
    };

    // find matching close paren
    const closeIdx = findBalancedParen(rest, openIdx);
    if (closeIdx === -1) return null;
    const body = rest.slice(openIdx + 1, closeIdx);

    const items = splitTopLevel(body);
    const colMap = {};
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const up = trimmed.toUpperCase();
      // Table-level constraints
      if (/^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|KEY|INDEX|CONSTRAINT|CHECK|EXCLUDE|PERIOD)/.test(up)) {
        if (/^PRIMARY\s+KEY/.test(up)) {
          const cols = extractColumnList(trimmed.replace(/^PRIMARY\s+KEY/i, ''));
          table.primaryKey.push(...cols);
          continue;
        }
        if (/^FOREIGN\s+KEY/.test(up)) {
          const fk = parseForeignKey(trimmed.replace(/^FOREIGN\s+KEY/i, ''));
          if (fk) table.foreignKeys.push(fk);
          continue;
        }
        if (/^CONSTRAINT/.test(up)) {
          const unwrapped = trimmed.replace(/^CONSTRAINT\s+[^\s]+/i, '').trim();
          const u2 = unwrapped.toUpperCase();
          if (/^FOREIGN\s+KEY/.test(u2)) {
            const fk = parseForeignKey(unwrapped.replace(/^FOREIGN\s+KEY/i, ''));
            if (fk) table.foreignKeys.push(fk);
          } else if (/^PRIMARY\s+KEY/.test(u2)) {
            table.primaryKey.push(...extractColumnList(unwrapped.replace(/^PRIMARY\s+KEY/i, '')));
          } else if (/^UNIQUE/.test(u2)) {
            const cols = extractColumnList(unwrapped.replace(/^UNIQUE/i, ''));
            for (const c of cols) { if (colMap[c]) colMap[c].unique = true; }
          }
          continue;
        }
        if (/^UNIQUE/.test(up)) {
          // UNIQUE [KEY] [name] (cols)
          const after = trimmed.replace(/^UNIQUE(\s+KEY)?/i, '').replace(/^[^\s(]+\s*/, '');
          const cols = extractColumnList(after);
          for (const c of cols) { if (colMap[c]) colMap[c].unique = true; }
          continue;
        }
        if (/^(KEY|INDEX)/.test(up)) {
          const cols = extractColumnList(trimmed.replace(/^(KEY|INDEX)\s*[^\s(]*/i, ''));
          if (cols.length) table.indexes.push(cols);
          continue;
        }
        // CHECK / EXCLUDE — ignore
        continue;
      }
      // Column definition
      const col = parseColumn(trimmed);
      if (col && col.name) {
        table.columns.push(col);
        colMap[col.name] = col;
      }
    }

    // Mark PK columns from inline PRIMARY KEY and table-level PK list
    for (const c of table.columns) {
      if (c.pk) table.primaryKey.push(c.name);
    }
    table.primaryKey = [...new Set(table.primaryKey)];
    for (const c of table.columns) {
      if (table.primaryKey.includes(c.name)) c.pk = true;
      c.notNull = c.notNull || c.pk;
    }

    return table;
  }

  function extractColumnList(s) {
    const open = s.indexOf('(');
    const close = findBalancedParen(s, open);
    if (open === -1 || close === -1) return [];
    const inner = s.slice(open + 1, close);
    const tokens = tokenize(inner);
    const cols = [];
    for (const t of tokens) {
      if (t.t === 'word' || t.t === 'id') cols.push(t.v);
    }
    return cols;
  }

  function parseForeignKey(s) {
    const open = s.indexOf('(');
    const close = findBalancedParen(s, open);
    if (open === -1 || close === -1) return null;
    const localCols = tokenize(s.slice(open + 1, close)).filter(t => t.t === 'word' || t.t === 'id').map(t => t.v);
    let rest = s.slice(close + 1).trim();
    if (!/^REFERENCES/i.test(rest)) return null;
    rest = rest.replace(/^REFERENCES\s+/i, '');
    const tokens = tokenize(rest);
    const r = readName(tokens, 0, true);
    if (!r.name) return null;
    const fk = { columns: localCols, refTable: r.full || r.name, refColumns: [], onDelete: null, onUpdate: null };
    let i = r.next;
    if (tokens[i] && tokens[i].v === '(') {
      i += 1;
      while (i < tokens.length && tokens[i].v !== ')') {
        if (tokens[i].t === 'word' || tokens[i].t === 'id') fk.refColumns.push(tokens[i].v);
        i++;
      }
    }
    // ON DELETE / ON UPDATE
    while (i < tokens.length) {
      if (tokens[i].t === 'word' && tokens[i].v.toUpperCase() === 'ON') {
        const kind = tokens[i + 1] ? tokens[i + 1].v.toUpperCase() : '';
        let action = [];
        i += 2;
        while (i < tokens.length && tokens[i].t === 'word' && tokens[i].v.toUpperCase() !== 'ON') {
          action.push(tokens[i].v.toUpperCase());
          i++;
        }
        const act = action.join(' ');
        if (kind === 'DELETE') fk.onDelete = act;
        else if (kind === 'UPDATE') fk.onUpdate = act;
      } else {
        i++;
      }
    }
    return fk;
  }

  function parseSQL(sqlText) {
    const cleaned = stripComments(sqlText);
    // Split statements on semicolons (respecting strings/parens minimally via findBalanced on ;).
    const statements = [];
    let cur = '';
    let inStr = null;
    for (let i = 0; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inStr) { if (c === inStr) inStr = null; cur += c; continue; }
      if (c === "'" || c === '"' || c === '`') { inStr = c; cur += c; continue; }
      if (c === ';') { if (cur.trim()) statements.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) statements.push(cur);

    const tables = [];
    const errors = [];
    const seen = new Set();
    for (const stmt of statements) {
      const s = stmt.trim();
      if (!/^CREATE\s+(TEMP(ORARY)?\s+)?TABLE\b/i.test(s)) continue;
      try {
        const table = parseCreateTable(s);
        if (!table) { errors.push({ stmt: s.slice(0, 80), error: 'Could not parse CREATE TABLE' }); continue; }
        if (seen.has(table.fullName.toLowerCase())) { continue; }
        seen.add(table.fullName.toLowerCase());
        tables.push(table);
      } catch (e) {
        errors.push({ stmt: s.slice(0, 80), error: String(e && e.message || e) });
      }
    }

    // Post-process: infer FK column targets that had no explicit referenced column (use referenced table PK if known).
    const byName = {};
    for (const t of tables) byName[t.fullName.toLowerCase()] = t;
    for (const t of tables) {
      const colByName = {};
      for (const c of t.columns) colByName[c.name.toLowerCase()] = c;
      for (const c of t.columns) {
        if (c.references && !c.references.column) {
          const rt = byName[(c.references.table || '').toLowerCase()];
          if (rt && rt.primaryKey.length) c.references.column = rt.primaryKey[0];
        }
      }
      for (const fk of t.foreignKeys) {
        // mark FK columns so the diagram can badge them
        for (const col of fk.columns) {
          const c = colByName[col.toLowerCase()];
          if (c) c.fk = true;
        }
        if (!fk.refColumns.length) {
          const rt = byName[(fk.refTable || '').toLowerCase()];
          if (rt && rt.primaryKey.length) fk.refColumns = rt.primaryKey.slice();
        }
      }
    }

    return { tables, errors };
  }

  const API = { parseSQL, stripComments, tokenize, parseCreateTable };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.SQLParser = API;
})(typeof window !== 'undefined' ? window : globalThis);
