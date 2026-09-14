/* SQLViz — schema → code generators (Prisma, TypeScript, SQLAlchemy/Python).
 * Pure functions: take the parsed schema model and return a string.
 * Works in browser (window.SchemaGen) and Node (module.exports).
 */
(function (global) {
  'use strict';

  function baseType(t) {
    const cleaned = String(t || '').replace(/\(.*\)/, '').trim();
    return (cleaned.split(/\s+/)[0] || '').toUpperCase();
  }
  function typeLen(t) { const m = (t || '').match(/\(\s*(\d+)/); return m ? m[1] : null; }

  function camel(s) {
    return String(s).replace(/_([a-zA-Z0-9])/g, (m, c) => c.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase());
  }
  function pascal(s) {
    const c = camel(s);
    return c.charAt(0).toUpperCase() + c.slice(1);
  }

  // ---- TypeScript ----------------------------------------------------------
  function tsType(col) {
    const b = baseType(col.type);
    if (['INT', 'INTEGER', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'SERIAL', 'SMALLSERIAL', 'BIGINT', 'BIGSERIAL', 'FLOAT', 'REAL', 'DOUBLE', 'DECIMAL', 'NUMERIC', 'MONEY'].includes(b)) return 'number';
    if (['BOOLEAN', 'BOOL'].includes(b)) return 'boolean';
    if (['DATE', 'DATETIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'TIME'].includes(b)) return 'Date';
    if (['BLOB', 'BYTEA', 'BINARY', 'VARBINARY'].includes(b)) return 'Uint8Array';
    if (['JSON', 'JSONB'].includes(b)) return 'Record<string, unknown>';
    return 'string';
  }

  function typescript(tables) {
    const out = [];
    for (const t of tables) {
      out.push('export interface ' + pascal(t.name) + ' {');
      for (const c of t.columns) {
        out.push('  ' + camel(c.name) + (c.notNull ? '' : '?') + ': ' + tsType(c) + ';');
      }
      out.push('}');
      out.push('');
    }
    return out.join('\n').trimEnd() + '\n';
  }

  // ---- Prisma --------------------------------------------------------------
  function prismaType(col) {
    const b = baseType(col.type);
    if (['INT', 'INTEGER', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'SERIAL', 'SMALLSERIAL'].includes(b)) return 'Int';
    if (['BIGINT', 'BIGSERIAL'].includes(b)) return 'BigInt';
    if (['FLOAT', 'REAL', 'DOUBLE'].includes(b)) return 'Float';
    if (['DECIMAL', 'NUMERIC', 'MONEY'].includes(b)) return 'Decimal';
    if (['BOOLEAN', 'BOOL'].includes(b)) return 'Boolean';
    if (['DATE', 'DATETIME', 'TIMESTAMP', 'TIMESTAMPTZ'].includes(b)) return 'DateTime';
    if (['JSON', 'JSONB'].includes(b)) return 'Json';
    if (['BLOB', 'BYTEA', 'BINARY', 'VARBINARY'].includes(b)) return 'Bytes';
    return 'String';
  }

  function prismaDefault(c) {
    const d = c.default;
    if (d == null) return null;
    const up = String(d).toUpperCase();
    if (up === 'CURRENT_TIMESTAMP' || up === 'NOW()') return 'now()';
    if (/^-?\d+(\.\d+)?$/.test(String(d))) return String(d);
    if (/^'.*'$/.test(String(d))) return String(d);
    if (/^true$/i.test(String(d))) return 'true';
    if (/^false$/i.test(String(d))) return 'false';
    return null;
  }

  function prisma(tables) {
    const byName = {};
    tables.forEach(t => { byName[t.fullName.toLowerCase()] = t; });

    // relation field name: "author_id" → "author", "parent_id" → "parent"
    function relField(localCol, parentName) {
      const base = camel(localCol).replace(/Id$/, '');
      return base || camel(parentName);
    }

    // gather single-column relations (column-level references + table-level FKs)
    const relations = []; // {child, parent, local, refCol, field, name}
    for (const t of tables) {
      const add = (local, refTable, refCol) => {
        const parent = byName[(refTable || '').toLowerCase()];
        if (!parent) return; // external reference — keep as scalar only
        const field = relField(local, parent.name);
        relations.push({ child: t, parent, local, refCol: refCol || (parent.primaryKey[0] || 'id'), field, name: field });
      };
      for (const c of t.columns) {
        if (c.references) add(c.name, c.references.table, c.references.column);
      }
      for (const fk of t.foreignKeys) {
        if (fk.columns.length === 1) add(fk.columns[0], fk.refTable, fk.refColumns[0]);
      }
    }

    const out = [
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '',
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
      ''
    ];

    for (const t of tables) {
      out.push('model ' + pascal(t.name) + ' {');
      const usedNames = new Set();

      // scalar fields
      for (const c of t.columns) {
        const fn = camel(c.name);
        usedNames.add(fn);
        let line = '  ' + fn + ' ' + prismaType(c);
        if (!c.notNull) line += '?';
        const attrs = [];
        if (c.pk) {
          attrs.push('@id');
          if (c.autoIncrement) attrs.push('@default(autoincrement())');
        }
        if (c.unique) attrs.push('@unique');
        const dflt = prismaDefault(c);
        if (dflt) attrs.push('@default(' + dflt + ')');
        if (attrs.length) line += ' ' + attrs.join(' ');
        out.push(line);
      }

      // relation fields (this table is the child)
      for (const r of relations) {
        if (r.child !== t) continue;
        const localCol = t.columns.find(c => c.name === r.local);
        const opt = (localCol && !localCol.notNull) ? '?' : '';
        out.push('  ' + r.field + ' ' + pascal(r.parent.name) + opt +
          ' @relation("' + r.name + '", fields: [' + camel(r.local) + '], references: [' + camel(r.refCol) + '])');
      }

      // back-relation fields (this table is the parent)
      const back = relations.filter(r => r.parent === t);
      back.forEach((r, i) => {
        let fn = camel(r.child.name);
        if (usedNames.has(fn)) fn = camel(r.child.name) + (i + 1);
        usedNames.add(fn);
        out.push('  ' + fn + ' ' + pascal(r.child.name) + '[] @relation("' + r.name + '")');
      });

      // composite FKs → note only
      for (const fk of t.foreignKeys) {
        if (fk.columns.length > 1) {
          out.push('  // composite FK: (' + fk.columns.map(camel).join(', ') + ') → ' + fk.refTable + '(' + fk.refColumns.map(camel).join(', ') + ')');
        }
      }

      out.push('}');
      out.push('');
    }
    return out.join('\n').trimEnd() + '\n';
  }

  // ---- Python / SQLAlchemy -------------------------------------------------
  function pyType(col) {
    const b = baseType(col.type);
    const L = typeLen(col.type);
    switch (b) {
      case 'INT': case 'INTEGER': case 'SERIAL': return 'Integer';
      case 'SMALLINT': case 'TINYINT': case 'MEDIUMINT': case 'SMALLSERIAL': return 'SmallInteger';
      case 'BIGINT': case 'BIGSERIAL': return 'BigInteger';
      case 'VARCHAR': case 'CHAR': return 'String(' + (L || 255) + ')';
      case 'TEXT': return 'Text';
      case 'BOOLEAN': case 'BOOL': return 'Boolean';
      case 'FLOAT': case 'REAL': case 'DOUBLE': return 'Float';
      case 'DECIMAL': case 'NUMERIC': case 'MONEY': return 'Numeric';
      case 'DATE': return 'Date';
      case 'TIME': return 'Time';
      case 'DATETIME': case 'TIMESTAMP': case 'TIMESTAMPTZ': return 'DateTime';
      case 'JSON': case 'JSONB': return 'JSON';
      case 'BLOB': case 'BYTEA': case 'BINARY': case 'VARBINARY': return 'LargeBinary';
      case 'UUID': return 'String(36)';
      default: return 'String(' + (L || 255) + ')';
    }
  }

  function python(tables) {
    const out = [
      'from sqlalchemy import Column, ForeignKey, Integer, BigInteger, SmallInteger, String, Text, Boolean, Float, Numeric, Date, Time, DateTime, JSON, LargeBinary',
      'from sqlalchemy.orm import declarative_base',
      '',
      'Base = declarative_base()',
      ''
    ];
    for (const t of tables) {
      out.push('');
      out.push('class ' + pascal(t.name) + '(Base):');
      out.push('    __tablename__ = "' + t.name + '"');
      out.push('');
      for (const c of t.columns) {
        const args = [pyType(c)];
        if (c.references) args.push('ForeignKey("' + c.references.table + '.' + (c.references.column || 'id') + '")');
        if (c.pk) args.push('primary_key=True');
        if (c.autoIncrement) args.push('autoincrement=True');
        if (c.notNull) args.push('nullable=False');
        if (c.unique) args.push('unique=True');
        out.push('    ' + c.name + ' = Column(' + args.join(', ') + ')');
      }
    }
    return out.join('\n').trimEnd() + '\n';
  }

  const API = { typescript, prisma, python, baseType, typeLen, camel, pascal };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.SchemaGen = API;
})(typeof window !== 'undefined' ? window : globalThis);
