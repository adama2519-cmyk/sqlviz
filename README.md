# SQLViz — SQL to ER Diagram

Paste raw `CREATE TABLE` statements and get an instant, interactive **entity–relationship diagram**. No signup, no DSL to learn, no server round-trip — your schema is parsed and drawn entirely in your browser.

![SQLViz](https://img.shields.io/badge/100%25-client--side-3fb950) ![License](https://img.shields.io/badge/license-MIT-blue)

## Why SQLViz?

Most schema tools make you learn a bespoke markup language (DBML, Mermaid) or force you into a paid plan. SQLViz works on the SQL you already have:

- **Raw SQL in** — MySQL, PostgreSQL, SQLite flavoured DDL, including `PRIMARY KEY`, composite keys, `FOREIGN KEY` (inline and table-level), `REFERENCES`, `UNIQUE`, `AUTO_INCREMENT`, `DEFAULT`, `CHECK`, and quoted identifiers.
- **Diagram out** — force-directed auto-layout, draggable tables, zoom & pan, relationship lines with FK badges.
- **Export anywhere** — SVG, PNG, Mermaid (`erDiagram`), or normalized SQL.

## Features

- Live parsing as you type (debounced).
- PK / FK / UNIQUE / AUTO_INCREMENT badges on columns.
- Click a table to inspect every column (type, nullability, default, references).
- Sample schemas to try instantly.
- Fully privacy-first: nothing is uploaded, nothing is stored.

## Run locally

No build step, no dependencies — just serve the folder:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## How it works

1. `parser.js` tokenizes and parses `CREATE TABLE` statements into a schema model.
2. `diagram.js` runs a force-directed layout and renders an SVG ER diagram.
3. `app.js` wires editing, interactions, and the SVG / PNG / Mermaid / SQL exporters.

## License

[MIT](LICENSE)
