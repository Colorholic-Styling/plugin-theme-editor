# 0xCMS Theme Editor

Visual theme editing for 0xCMS. The first development slice can:

- authenticate as a normal 0xCMS Worker plugin;
- list available themes on the plugin dashboard and open a selected theme;
- discover the theme's JSON/Liquid templates during development sync and
  select which template renders the preview;
- list CMS pages from admin-approved page types;
- render the selected page with a bucket-backed Liquid theme, in the browser;
- select a page block from the preview or settings list without reloading the
  CMS page or preview (the approved browser asset composes the inspector from
  the initial page `lect`, with normal links as fallback);
- edit scalar attributes, localized values, pointers, nested items, and block
  values from `lect`, with the preview redrawing in the browser as you type;
- drive the block settings panel from the section's own `{% schema %}`, showing
  each setting's declared control and the Liquid a JSON template binds it with;
- show or hide a theme template's sections without reloading the page or the
  preview, stored per template so the change applies to every page that
  template renders;
- write those template edits back into the theme's own files with
  `npm run theme:apply`, or publish them into the theme bucket;
- clone a theme from GitHub and commit the templates back to it, without a
  `git` binary anywhere;
- save through the host `/__cms/pages/:id` API, preserving normal CMS
  versions, lifecycle hooks, and acting-user attribution.

## Development

```bash
npm install
CMS_ASSETS_DIR=/absolute/path/to/cms/views/assets npm run liquid:sync
npm test
npm run typecheck
npm run dev
```

The sync copies the host CMS's LiquidJS bundle into ignored `test/vendor/`. The
plugin does not depend on LiquidJS — it borrows the one every admin page already
loads — so the tests have to take the engine from the same place the browser
does. It is a one-off, needed again only when the host upgrades its bundle. See
[In-browser rendering](#in-browser-rendering).

`npm run dev` runs on port `8798` and reads themes from the `THEMES` bucket.
To work against a checked-out theme instead, configure its source explicitly:

```bash
THEME_SOURCE_DIR=/absolute/path/to/views \
THEME_ID=example-theme \
npm run dev:theme
```

`dev:theme` stages the configured directory under ignored `views/theme/`, copies
it into `.dist/views/theme/`, and then watches the source into that live
development fallback. A one-off `npm run theme:sync` uses the same required
`THEME_SOURCE_DIR`. The sync creates a
`theme-manifest.json` containing the available templates. It copies in place
and prunes what the source removed, because `wrangler dev` serves the subtree
live. Production deployment never runs this sync and does not require the
checked-out theme.

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
            └─ /editor?theme=example-theme
                 ├─ template manifest ─────────────▶ THEMES bucket
                 ├─ page list + content metadata ──▶ /__cms
                 ├─ preview iframe ────────────────▶ empty frame, written by the
                 │                                    editor page's renderer from
                 │                                    /preview/data + /preview/bundle
                 ├─ block focus ───────────────────▶ browser composition from page lect
                 ├─ section show/hide ─────────────▶ THEME_OVERRIDES KV per template
                 └─ AJAX settings save ────────────▶ PATCH /__cms/pages/:id
```

The built-in preview adapter projects standard 0xCMS `lect` block types into
the view models expected by theme sections. Theme identity, source paths,
templates, partials, and repository metadata all come from the selected theme;
none is compiled into the editor. The initial client view contains an
HTML-escaped JSON editor state; changing the focused block reads that local
state and does not call the plugin or CMS.

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

The frame is recognised by the placeholder its shell carries, never by
`readyState`. Every iframe holds a blank document until its navigation commits,
and that document already reports `complete` — so a warm cache, where this
script runs before the frame has committed, would otherwise draw the theme into
a document the real one is about to replace, leaving the placeholder showing.
Each render re-reads `contentDocument` for the same reason, and a frame that
reloads back to its placeholder is drawn again.

Both loads happen once, at start-up. Every render after that — typing in a
block, moving the selection, toggling a section — is local and reaches no
network at all.

That asset is not a second renderer. It imports `renderThemePreview` and
`applyEditorFields` from `src/`, and esbuild bundles them:

```bash
npm run build:preview
```

It does not bundle LiquidJS, and this plugin does not depend on it at all. The
host already loads one — `/assets/liquid.browser.min.js`, the UMD build that
defines `liquidjs` on the global — on every admin page for its own client-side
view rendering, and an approved plugin asset is injected after it. So
`src/theme/liquid.ts` reads that global instead of shipping a second copy: the
theme is parsed by the same engine the admin UI uses, and the approval-gated
asset stays small (18 KB rather than 97 KB).

That file is not the npm package. It is LiquidJS with the CMS's own `schema` tag
patched into the default tag registry, so testing against the package would test
an engine the browser never runs. `test/host-liquid.ts` installs the host's file
on the global the way the admin page does, and it is where the tests get their
engine too. Copy it in first:

```bash
CMS_ASSETS_DIR=../../../workers/cms/views/assets npm run liquid:sync
```

The copy lands in the ignored `test/vendor/`, so it cannot go stale in the repo,
and the sync prints the version it took. Tests fail with that command in the
message if it is missing.

`ThemeRuntime` is what lets the Worker's renderer run in the browser unchanged:
it carries plain values plus a `ThemeStore`, so the browser supplies an
in-memory store over the fetched bundle where the Worker would supply
`AssetThemeStore` over its asset binding. Nothing about the projection differs,
which is the point — a preview that reimplemented any of it would be free to
disagree with what the theme's own Worker renders.

The build output is ignored, and regenerated by `predev`, `pretest`, and
`predeploy`. `test/browser-preview.test.ts` runs the built bundle in a DOM
rather than the source module, since a browser build that failed to reach the
host's LiquidJS would still pass a source-level test; `test/editor-client.test.ts`
drives `theme-editor.js` against the real `editor.liquid` markup, so the data
hooks it depends on cannot drift from the template that emits them.

Both `/assets/theme-editor.js` and `/assets/theme-preview.js` are approval-gated:
the host pins each file's SHA-384 when an admin approves it and recomputes it on
every serve, so **changing either one requires re-approving it** in the CMS
plugin settings before it will load again.

### Section schemas

The block settings panel has two modes. **Values** lists what `lect` actually
stores, inferred from each value's shape. **Schema** reads the section's own
`{% schema %}` tag out of `sections/<type>.liquid`, the way Shopify does, so
labels, control types, option lists, and ordering come from the theme author —
a `select` renders as a dropdown of its declared options rather than a text box.

**Schema mode edits the template, not the page.** Each control holds the Liquid
the template binds that setting to, and underneath sits what that Liquid
*resolves to* — not the stored value it happens to read, so editing a binding
to `hello` shows `hello`, and pointing it at another block value shows that
value. Resolution runs through `resolveThemeBinding`, which shares the preview's
render data, so what the hint reports is what the section would receive:

```text
Eyebrow      text       [ {{ page.blocks[0].eyebrow }} ]
                          16-Colour analysis          ← the binding, resolved
```

The editor page asks the preview for that answer as the binding is typed, so no
request is made. The Worker's first paint of a hint is the stored value it
matched, which agrees whenever the binding is still the theme's own; the editor
replaces every hint once the renderer is up.

Saving posts to `/template-settings`, which writes those bindings into the
`THEME_OVERRIDES` KV alongside the hidden set — the theme's own template file is
a read-only asset that `theme:sync` regenerates, so the edit is layered over it.
The compiler merges the override into the section's declared settings before
resolving them, and the same set is handed to the browser renderer, so the frame
redraws through the new binding.

Only bindings that *differ* from the theme's own template are stored. Recording
one the theme already declares would freeze it, so a later edit to the theme
file would be masked by an override repeating what it used to say — the same
reason the hidden set stores keys rather than a copy of `order`. Settings a
section's schema does not declare are refused, and a binding cleared to nothing
means the template no longer sets it.

Page *values* are still edited in the Values panel; the two panels save to
different routes and the form's action follows the mode.

The resolved value shown under each binding comes from matching schema ids to
`lect`: ids name the *view model* a section renders, so candidate paths are
matched against the fields the editor derived — `bodyHtml` reads `body`,
`pictureAlt` reads `picture_alt`, `primary_label` reads `primary.label`. Some
settings are computed by the projection rather than stored (`hasNews`,
`indexLabel`, `whatsappHref`) and say so instead of showing a value. Against the
development theme 72 of 75 declared settings resolve.

Both panels are built whichever mode the URL asks for, so switching between
them is a client-side toggle with no page load; the inactive one is a disabled
`<fieldset>`, which keeps its inputs out of the save payload where they would
otherwise compete with the visible panel's for the same `lect` paths. Mode stays
a URL parameter (`&settings=schema`) — kept in step with `replaceState` — so it
survives reloads, rides along when the page/template/language selectors reload
the editor, and is shareable.

Selecting a *different* block in schema mode still loads from the server, since
only the Worker reads the theme's schema. The mode links carry the block their
panel was built for and fall back to normal navigation when it no longer matches
the selection, rather than showing a panel that describes another block.

### The theme bucket

`THEMES` is the theme library, and the bucket is its root: every top-level
folder is a theme, so `example-theme/templates/page.json` is that theme's
page template. The registry is the bucket listing rather than anything compiled
into this Worker, so adding a theme is uploading a folder. Each theme names
itself in its own `theme-manifest.json`.

```text
cms-themes/
  example-theme/      ← one theme
    layout/ sections/ snippets/ templates/ assets/
    theme-manifest.json
  studio-minimal/          ← another
```

A bucket is what makes the theme *writable*. An asset binding is immutable at
runtime, which is why the editor keeps overrides at all; `themeStore()` hands
back an `R2ThemeStore` for a bucket theme and `isWritable()` is what the
publish route checks. Everything else — the renderer, the schema reader, the
bundle endpoint, the browser bundle — is unchanged, because they only ever knew
`ThemeStore`.

Fill the bucket from a checked-out theme (both variables are explicit so the
editor has no dependency on a particular local repository):

```bash
THEME_SOURCE_DIR=/absolute/path/to/views \
THEME_ID=studio-minimal \
npm run theme:push
```

The upload goes through the plugin rather than the R2 API, so the same command
fills Miniflare's local R2 under `wrangler dev` and a real bucket in
production. With no bucket bound, the development theme staged under
`.dist/views/theme/` stands in.

Publishing folds the override layer into the theme's own files:

```text
POST /admin/plugins/theme-editor/publish   → writes each template, clears what applied
```

It is the deployed twin of `theme:apply` and shares its merge, so both produce
the same file. A theme served from the asset bundle refuses with a 409 pointing
at `theme:apply`, since only the machine holding the theme can write it there.

### GitHub

A theme can be cloned from a repository and committed back to it, from the
dashboard. There is no `git` here — a Worker has no filesystem and no
subprocesses — so both directions use GitHub's Git Data API over `fetch`:

```text
clone   read ref → commit → tree (recursive) → blobs   → write into the bucket
push    blobs → tree (on the branch's current one) → commit → move the ref
```

Building the push tree on `base_tree` is what keeps it safe: files this editor
never touched are carried over rather than dropped by omission, and the whole
push lands as one commit rather than a file at a time.

Cloning writes the repo into the bucket as a theme folder and records the repo
in that theme's `theme-manifest.json`, so pushing later needs no second setup —
the dashboard shows those themes as `owner/repo@branch` and gives them a
**Push to GitHub** button. Only files the renderer reads are cloned
(`.liquid`, `.json`, `.css`, images, fonts), and only from the directory you
name, so a repository holding a site alongside its theme brings across just the
theme.

#### GitHub App connection (recommended)

The dashboard supports a Shopify-style **Connect GitHub** flow. GitHub handles
sign-in and lets the installer grant either all repositories or only selected
repositories. The plugin stores the installation id and account label in a
dedicated tenant-scoped KV namespace; it never stores the temporary GitHub user
token. Clone and push mint a new one-hour installation token as needed.

Create a GitHub App under the account or organisation that will own the
integration:

1. Set the callback URL to the plugin Worker's public origin plus
   `/__plugin/github/callback`, for example
   `https://worker-cms-plugin-theme-editor.example.workers.dev/__plugin/github/callback`.
   This is deliberately the Worker endpoint, not the CMS admin URL.
2. Enable **Request user authorization (OAuth) during installation**. The
   callback uses that short-lived user authorization to verify that the person
   returning from GitHub can really access the installation id; GitHub warns
   against trusting the query parameter by itself.
3. Under repository permissions set **Contents: Read and write**. No
   organisation permissions or webhook events are required.
4. Choose **Any account** when several customer organisations will install the
   App. A private App is enough when it will only ever be installed on its
   owner's account.
5. Generate a private key and record the App id, slug, client id, and client
   secret. Leave **Redirect on update** off; **Manage repositories** opens
   GitHub in a new tab and the dashboard sees the new selection when reloaded.

Provision the connection registry:

```bash
npm run kv:setup -- --binding=GITHUB_CONNECTIONS
```

Put the non-secret App identity in `[vars]`:

```toml
[vars]
GITHUB_APP_ID = "123456"
GITHUB_APP_SLUG = "zeroxcms-theme-editor"
GITHUB_APP_CLIENT_ID = "Iv1.example"
```

Store all credentials through Wrangler's hidden secret prompt:

```bash
npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler secret put GITHUB_APP_CLIENT_SECRET
npx wrangler secret put GITHUB_APP_STATE_SECRET
```

Paste the complete downloaded PEM, including its `BEGIN`/`END` lines, for
`GITHUB_APP_PRIVATE_KEY`. The Worker accepts GitHub's PKCS#1 download format as
well as PKCS#8. Use an independently generated random value of at least 32
characters for `GITHUB_APP_STATE_SECRET`.

The connect request originates inside an authenticated CMS admin request and
places the CMS tenant id, acting user id, expiry, and random nonce in an
HMAC-signed ten-minute `state`. The public callback validates that state,
exchanges the one-time code, asks GitHub which installations the user can
access, checks **Contents: write**, and only then stores:

```json
{
  "installationId": 12345678,
  "accountLogin": "example-org",
  "accountType": "Organization",
  "repositorySelection": "selected",
  "manageUrl": "https://github.com/organizations/example-org/settings/installations/12345678",
  "connectedAt": "2026-07-31T00:00:00.000Z"
}
```

The key uses the CMS tenant's opaque ref, so two CMS hosts connected to one
plugin Worker cannot read, replace, or disconnect one another's installation.
Disconnecting in the dashboard removes only this CMS pairing; it does not
uninstall the App on GitHub.

#### Personal-token fallback

Existing deployments can continue using a fine-grained personal token with
**Contents: read and write**:

```bash
npx wrangler secret put GITHUB_TOKEN
```

If a tenant has a connected GitHub App, the installation always wins; the
plugin does not silently fall back to a broader deployment token when that
installation expires, is suspended, or loses repository access.

For a multi-tenant Worker that cannot yet use the GitHub App, a tenant-specific
`GITHUB_TOKEN` may still be placed in that tenant record's `vars`. KV values
can be read back by operators, unlike Worker secrets, which is why the GitHub
App installation is the preferred multi-tenant path.

Without an App installation or fallback token the dashboard says so and refuses
before making any GitHub request; the same is true with no bucket to clone
into. Connect, disconnect, clone, and push are gated on `theme-editor:write`.

### Writing edits back into the theme

A Worker has no filesystem, so the plugin can never edit the theme it renders —
the overrides above are a layer over files it can only read. `theme:apply` runs
on the machine that *does* have the theme checked out, and is what makes them
permanent:

```bash
npm run theme:apply -- --dry-run   # show what would change
npm run theme:apply                # write the theme, then clear what applied
```

It reads `/overrides` from the running plugin, merges each template's overrides
into the theme's own JSON — hidden keys leave `order`, changed bindings replace
what the section declares — writes the file, and only then clears what it
applied, so a failed write leaves the edit in the editor rather than losing it
between the two. A hidden section keeps its definition and loses only its place
in `order`, so showing it again is putting the key back rather than rebuilding
it. `theme:watch` then picks the file up and the preview re-renders from the
theme itself.

It needs `npm run dev` running (it reads `PLUGIN_SECRET` from `.dev.vars`) and
requires `THEME_SOURCE_DIR`; `PLUGIN_URL` and `THEME_ID` choose the target.

### Section visibility

Hiding a section drops its key from the `order` the preview compiles, leaving
the theme's own template file untouched. That decision belongs to the template
rather than to one page's content, so it cannot live in a page's `lect`; and
`.dist/views/theme/` is a read-only asset subtree that `theme:sync` regenerates, so
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

1. Extend schema reading to a section's `blocks[]` entries, so repeated items
   (features, services, steps) get declared labels and controls too; the
   section-level `settings[]` already come from the theme.
2. Add block and item add/delete/reorder operations with the CMS structured
   editing contract, and extend `THEME_OVERRIDES` from section visibility to
   section reordering.
3. Add draft preview support for related pages, media proxy behavior, template
   diagnostics, and responsive viewport controls.
4. Version the bucket's theme folders (`example-theme/v3/…`) for rollback,
   and cache the bundle per theme version so a render is not one R2 read per
   partial. The registry and the writable store are in place.
5. Add drag selection and richer unsaved-change state while preserving the
   current server-rendered fallbacks.
