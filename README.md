# 0xCMS Theme Editor

Visual theme editing for 0xCMS. The first development slice can:

- authenticate as a normal 0xCMS Worker plugin;
- list CMS pages from admin-approved page types;
- render the selected page with the Colorholic Liquid theme;
- select a page block from the preview or settings list;
- edit scalar attributes, localized values, pointers, nested items, and block
  values from `lect`;
- save through the host `/__cms/pages/:id` API, preserving normal CMS
  versions, lifecycle hooks, and acting-user attribution.

## Development

```bash
npm install
npm run theme:sync
npm test
npm run typecheck
npm run dev
```

`npm run dev` runs on port `8798` and automatically syncs the development
theme from:

```text
/Users/colin/Documents/code/projects/colorholicstyling/www/views
```

Override that source without changing code:

```bash
THEME_SOURCE_DIR=/absolute/path/to/views npm run theme:sync
```

The sync creates the ignored `views/theme/` runtime bundle. The Worker reads it
through `ThemeStore`; replacing `AssetThemeStore` with an R2-backed store is
the intended bucket migration path.

For local single-tenant development:

1. Run the host CMS on `http://localhost:8787`.
2. Register this Worker URL as the `theme-editor` plugin.
3. Put the registration's dedicated secret in `.dev.vars` as
   `PLUGIN_SECRET=...`.
4. Approve the requested page-type read/write scopes in the CMS plugin
   settings. The manifest requests `"*"`, but the Worker enumerates the
   concrete approved types returned by `/__cms/content-meta`; it never sends
   `"*"` as an actual page type.
5. Open `/admin/plugins/theme-editor/editor`.

## Architecture

```text
CMS admin
  └─ /admin/plugins/theme-editor/editor
       ├─ page list + content metadata ──▶ /__cms
       ├─ preview iframe ────────────────▶ Colorholic Liquid templates
       └─ settings form ────────────────▶ PATCH /__cms/pages/:id
```

The preview adapter is deliberately theme-specific today: `lect` is projected
into the view models expected by the Colorholic sections. Theme template
storage is already abstracted separately so R2 can replace the development
asset bundle without coupling storage to the editor.

## Next phases

1. Load theme metadata/schema alongside templates so field labels and controls
   come from blueprints instead of value-shape inference.
2. Add block and item add/delete/reorder operations with the CMS structured
   editing contract.
3. Add draft preview support for related pages, media proxy behavior, template
   diagnostics, and responsive viewport controls.
4. Store versioned theme bundles in R2, add theme selection, and invalidate
   parsed Liquid caches by theme version.
5. Add optional approved JavaScript for live iframe refresh, drag selection,
   and unsaved-change state while preserving the current server-rendered
   fallback.
