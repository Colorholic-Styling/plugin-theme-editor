/**
 * Stands in for the CMS's `/__cms/state` store.
 *
 * Records this plugin keeps — the GitHub connection, the theme editor's
 * override layer — belong to the host that owns them, so tests assert against
 * what the host was asked to keep rather than against storage in this Worker.
 * Values are held exactly as the host holds them: JSON text, returned verbatim.
 */
export interface CmsStateFake {
  store: Map<string, string>;
  /** Answers a state request the way the host does, or null if not one. */
  handle(url: URL, method: string, body: unknown): Response | null;
}

export function cmsState(seed: Record<string, unknown> = {}): CmsStateFake {
  const store = new Map(Object.entries(seed).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : JSON.stringify(value),
  ]));

  return {
    store,
    handle(url: URL, method: string, body: unknown): Response | null {
      if (!url.pathname.startsWith('/__cms/state')) return null;

      // Listing, optionally narrowed by prefix.
      if (url.pathname === '/__cms/state') {
        const prefix = url.searchParams.get('prefix') ?? '';
        return Response.json({
          state: [...store.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => ({ key, value, updated_at: '2026-08-01T00:00:00Z' })),
        });
      }

      const key = decodeURIComponent(url.pathname.slice('/__cms/state/'.length));
      if (method === 'PUT') {
        store.set(key, JSON.stringify((body as { value: unknown }).value));
        return Response.json({ ok: true, key });
      }
      if (method === 'DELETE') {
        store.delete(key);
        return Response.json({ ok: true, key });
      }
      const value = store.get(key);
      return value === undefined
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ key, value, updated_at: '2026-08-01T00:00:00Z' });
    },
  };
}

/** The state key holding one theme's pending editor changes. */
export function themeOverridesKey(themeId: string): string {
  return `theme.overrides.${themeId}`;
}
