# DDL Comparison

A lightweight, zero-dependency web tool for comparing two DDL table schemas, rendered as a GitHub-style side-by-side diff.

**🔗 Live demo:** [bpm1993.github.io/ddl_comparison](https://bpm1993.github.io/ddl_comparison/)

## Features

- **Side-by-side diff** in the style of GitHub's code review UI, with line numbers and `+` / `-` / `~` markers.
- **Inline token-level highlighting** for modified columns - only the changed parts of the type or nullability are highlighted.
- **Nested type expansion**: `STRUCT`, `ARRAY<STRUCT>`, and `MAP<…, STRUCT>` fields are flattened into indented rows so changes deep inside complex types are easy to spot. Sub-levels are visualized with tree guides and a small tag indicating the wrapper kind.
- **Path-based matching**: fields are matched by their full dotted path (e.g. `profile.address.zip`), so a change to one nested field doesn't mark the whole parent as modified.
- **Change summary**: counts of added, removed, modified and unchanged fields at the top.
- **Dark mode** with automatic detection via `prefers-color-scheme` and a manual toggle that persists in `localStorage`.
- **Responsive** - falls back to a stacked layout on narrow screens.

## Usage

1. Open the [live demo](https://bpm1993.github.io/ddl_comparison/) (or `index.html` locally - no build step required).
2. Paste the output of `df.schema.toDDL()` from your "before" table into **DDL A**.
3. Paste the output from your "after" table into **DDL B**.
4. Click **Comparar**. Use **Carregar exemplo** to see a sample with nested structs and arrays.

### Input format

The tool expects the exact format produced by Databricks' `df.schema.toDDL()` in PySpark / Scala, e.g.:

```
id BIGINT NOT NULL,name STRING,profile STRUCT<age: INT, city: STRING>
```

## Running locally

The project is plain HTML/CSS/JS - just open `index.html` in any modern browser. No dependencies, no build step.

```bash
git clone https://github.com/bpm1993/ddl_comparison.git
cd ddl_comparison
# Open index.html in your browser
```

## Project structure

- `index.html` - page layout and inputs
- `styles.css` - light/dark themes and diff styling
- `app.js` - DDL parser, diff algorithm, and renderer
