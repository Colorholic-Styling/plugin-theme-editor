# 0xCMS Theme Editor

Visual theme editing for 0xCMS. The first development slice can:

- authenticate as a normal 0xCMS Worker plugin;
- list available themes on the plugin dashboard and open a selected theme;
- discover the theme's JSON/Liquid templates during development sync and
  select which template renders the preview;
- list CMS pages from admin-approved page types;
- render the selected page with the Colorholic Liquid theme, in the browser;
- select a page block from the preview or settings list without reloading the
  CMS page or preview (the approved browser asset composes the inspector from
  the initial page `lect`, with normal links as fallback);
- edit scalar attributes, localized values, pointers, nested items, and block
  values from `lect`, with the preview redrawing in the browser as you type;
- show or hide a theme template's sections without reloading the page or the
  preview, stored per template so the change applies to every page that
  template renders;
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

`npm run dev` runs on port `8798` and keeps the development theme synced from:

```text
/Users/colin/Documents/code/projects/colorholicstyling/www/views
```

The sync also watches that directory, so editing the theme while the site runs
on `http://localhost:8080` updates the preview without restarting either
Worker. Without the watch the bundle is only a snapshot taken before
`wrangler dev` started, and later theme edits never reach the editor. Run
`npm run theme:watch` on its own when the dev server is started some other way.

Override the source without changing code:

```bash
THEME_SOURCE_DIR=/absolute/path/to/views npm run theme:sync
```

The sync creates the ignored `views/theme/` runtime bundle and a
`theme-manifest.json` containing the available templates. It copies in place
and prunes what the source removed, because `wrangler dev` serves the subtree
live. The Worker reads both through `ThemeStore`; replacing `AssetThemeStore`
with an R2-backed store is the intended bucket migration path.

For local single-tenant development:

1. Run the host CMS on `http://localhost:8787`.
2. Register this Worker URL as the `theme-editor` plugin.
3. Put the registration's dedicated secret in `.dev.vars` as
   `PLUGIN_SECRET=...`.
4. Approve the requested page-type read/write scopes in the CMS plugin
   settings. The manifest requests `"*"`, but the Worker enumerates the
   concrete approved types returned by `/__cms/content-meta`; it never sends
   `"*"` as an actual page type.
5. Approve `/assets/theme-editor.js` and `/assets/theme-preview.js`. The first
   composes the inspector from the page `lect` already in the client view; the
   second draws the preview into the frame. Without the second the frame stays
   on "Loading preview…", since the Worker renders no theme HTML.
6. Open `/admin/plugins/theme-editor`, then choose a theme to edit.

## Architecture

```text
CMS admin
  └─ /admin/plugins/theme-editor
       └─ available themes
            └─ /editor?theme=colorholic-styling
                 ├─ template manifest ─────────────▶ views/theme/templates
                 ├─ page list + content metadata ──▶ /__cms
                 ├─ preview iframe ────────────────▶ empty frame, written by the
                 │                                    editor page's renderer from
                 │                                    /preview/data + /preview/bundle
                 ├─ block focus ───────────────────▶ browser composition from page lect
                 ├─ section show/hide ─────────────▶ THEME_OVERRIDES KV per template
                 └─ AJAX settings save ────────────▶ PATCH /__cms/pages/:id
```

The preview adapter is deliberately theme-specific today: `lect` is projected
into the view models expected by the Colorholic sections. Theme template
storage is already abstracted separately so R2 can replace the development
asset bundle without coupling storage to the editor. The initial client view
contains an HTML-escaped JSON editor state; changing the focused block reads
that local state and does not call the plugin or CMS.

The theme decides how a CMS block reaches the page, so selection overlays are
attached two ways:

- a `{ "type": "content" }` section renders blocks itself, so the overlay rides
  on each block's own `template` value, served from a `VirtualThemeStore` entry
  that wraps the real section;
- a section declared in a JSON template binds to a block by interpolating
  `page.blocks[N]` into its settings, so the overlay is inferred from that
  reference and guarded in case the page has no such block.

A declared section that reads no block, or mixes several, renders unwrapped
rather than claiming a selection it cannot represent.

### In-browser rendering

The Worker renders no theme HTML. `/preview` returns an empty frame, and
`/assets/theme-preview.js` loads the page as JSON from `/preview/data` and the
theme's template and Liquid partials from `/preview/bundle`, then draws the
page:

```text
/preview            → empty frame, no script of its own
  ├─ /preview/data   → { context, template, hidden, runtime }   (the CMS page)
  └─ /preview/bundle → { "/layout/default.liquid": "…", … }     (the theme)
```

**The renderer runs in the editor page, not in the frame.** The host strips
every `<script>` from a plugin HTML document and only lets an approved
`<script src>` survive inside a *client view*, where its `client-render.js`
restores it — so a renderer shipped inside the frame is deleted before the
browser ever sees it, and the frame would sit on "Loading preview…" forever.
The editor page is a client view, so its scripts do run; the frame is
same-origin, so the renderer writes the theme into it directly. The frame's
URLs travel as `data-` attributes on the `<iframe>`, since a JSON payload in a
`<script>` tag would be stripped for the same reason.

The first render writes the whole document, so the theme's own `<head>` is
installed; later renders replace the body alone, keeping the stylesheet from
being refetched and the scroll position from jumping.

Both loads happen once, at start-up. Every render after that — typing in a
block, moving the selection, toggling a section — is local and reaches no
network at all.

That asset is not a second renderer. It imports `renderThemePreview` and
`applyEditorFields` from `src/`, and esbuild bundles them with LiquidJS:

```bash
npm run build:preview
```

`ThemeRuntime` is what lets the Worker's renderer run in the browser unchanged:
it carries plain values plus a `ThemeStore`, so the browser supplies an
in-memory store over the fetched bundle where the Worker would supply
`AssetThemeStore` over its asset binding. Nothing about the projection differs,
which is the point — a preview that reimplemented any of it would be free to
disagree with what the theme's own Worker renders.

The build output is ignored, and regenerated by `predev`, `pretest`, and
`predeploy`. `test/browser-preview.test.ts` runs the built bundle in a DOM
rather than the source module, since a browser build that failed to resolve
LiquidJS would still pass a source-level test; `test/editor-client.test.ts`
drives `theme-editor.js` against the real `editor.liquid` markup, so the data
hooks it depends on cannot drift from the template that emits them.

Both `/assets/theme-editor.js` and `/assets/theme-preview.js` are approval-gated:
the host pins each file's SHA-384 when an admin approves it and recomputes it on
every serve, so **changing either one requires re-approving it** in the CMS
plugin settings before it will load again.

### Section visibility

Hiding a section drops its key from the `order` the preview compiles, leaving
the theme's own template file untouched. That decision belongs to the template
rather than to one page's content, so it cannot live in a page's `lect`; and
`views/theme/` is a read-only asset subtree that `theme:sync` regenerates, so
it cannot be written back to the theme either. It is stored in the
`THEME_OVERRIDES` KV namespace instead, keyed by tenant, theme, and template:

```text
sections:<cms-origin>:<theme-id>:<template-id> → {"hidden":["hero"]}
```

Hidden *keys* are stored rather than a copy of the order array, so a section
the theme author adds later shows up instead of being lost to a stale snapshot.
Reads degrade to "nothing hidden" when the namespace is unbound — an
unprovisioned store must never blank out a preview — while writes report the
missing binding. `wrangler dev` uses Miniflare's local KV and needs no setup;
provision a real namespace before deploying:

```bash
npm run kv:setup -- --binding=THEME_OVERRIDES
```

The toggle posts to `/admin/plugins/theme-editor/visibility` and needs
`theme-editor:write`. When the frame can be redrawn in the page, the editor
sends that post itself, updates the row, and hands the returned hidden set to
the renderer — no page navigation and no frame reload. `setSectionHidden`
returns exactly what it stored, so the redraw cannot disagree with the
override. Everything is a plain `<form>` underneath, so the same toggle still
works through a normal post and reload when the browser assets are unapproved,
and a failed request falls back to submitting for real rather than failing
quietly. Sections bound to a block carry their
toggle on that block's row; sections bound to none — a page header, or a
`{ "type": "content" }` block loop — are listed under "Template sections" so
every declared section stays reachable.

## Next phases

1. Load theme metadata/schema alongside templates so field labels and controls
   come from blueprints instead of value-shape inference.
2. Add block and item add/delete/reorder operations with the CMS structured
   editing contract, and extend `THEME_OVERRIDES` from section visibility to
   section reordering.
3. Add draft preview support for related pages, media proxy behavior, template
   diagnostics, and responsive viewport controls.
4. Store versioned theme bundles in R2, populate the theme registry from the
   bucket, and invalidate parsed Liquid caches by theme version.
5. Add drag selection and richer unsaved-change state while preserving the
   current server-rendered fallbacks.
