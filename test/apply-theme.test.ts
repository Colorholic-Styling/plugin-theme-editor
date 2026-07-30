import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `theme:apply` is the only thing in this project that writes the theme's own
 * files — the Worker has no filesystem — so it is exercised end to end against
 * a real directory rather than trusted to a unit of its merge logic.
 */
const run = promisify(execFile);
const script = resolve(process.cwd(), 'scripts/apply-theme.mjs');

const TEMPLATE = {
  layout: 'default',
  sections: {
    hero: { type: 'hero', settings: { title: '{{ page.blocks[0].title }}', theme: '{{ page.blocks[0].theme }}' } },
    cta: { type: 'cta', settings: { title: '{{ page.blocks[8].title }}' } },
  },
  order: ['hero', 'cta'],
};

async function themeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'theme-apply-'));
  await mkdir(join(root, 'templates'), { recursive: true });
  await writeFile(
    join(root, 'templates', 'page.json'),
    `${JSON.stringify(TEMPLATE, null, 2)}\n`,
    'utf8',
  );
  return root;
}

/** Stands in for the plugin Worker the script reads its overrides from. */
async function pluginServer(overrides: unknown): Promise<{ url: string; cleared: string[]; close(): void }> {
  const { createServer } = await import('node:http');
  const cleared: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/__plugin/admin/overrides/clear')) {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        cleared.push(new URLSearchParams(body).get('template') ?? '');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ theme: 'example-theme', templates: overrides }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, cleared, close: () => server.close() };
}

async function apply(source: string, url: string, args: string[] = []) {
  return run('node', [script, ...args], {
    env: {
      ...process.env,
      THEME_SOURCE_DIR: source,
      PLUGIN_URL: url,
      PLUGIN_SECRET: 'test-secret',
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('theme:apply', () => {
  it('writes hidden sections and rebound settings into the theme template', async () => {
    const source = await themeDir();
    const server = await pluginServer({
      page: { hidden: ['cta'], settings: { hero: { title: '{{ page.blocks[0].eyebrow }}' } } },
    });

    try {
      const { stdout } = await apply(source, server.url);
      expect(stdout).toContain('order: removed cta');
      expect(stdout).toContain('{{ page.blocks[0].title }} → {{ page.blocks[0].eyebrow }}');

      const written = JSON.parse(await readFile(join(source, 'templates', 'page.json'), 'utf8'));
      expect(written.order).toEqual(['hero']);
      expect(written.sections.hero.settings.title).toBe('{{ page.blocks[0].eyebrow }}');
      // Untouched settings and the hidden section's own definition survive, so
      // showing it again is putting its key back rather than rebuilding it.
      expect(written.sections.hero.settings.theme).toBe('{{ page.blocks[0].theme }}');
      expect(written.sections.cta).toEqual(TEMPLATE.sections.cta);

      // Applied overrides are cleared, so the file is the only thing left
      // saying what it says.
      expect(server.cleared).toEqual(['page']);
    } finally {
      server.close();
    }
  });

  it('changes nothing on a dry run', async () => {
    const source = await themeDir();
    const server = await pluginServer({
      page: { hidden: ['cta'], settings: {} },
    });

    try {
      const before = await readFile(join(source, 'templates', 'page.json'), 'utf8');
      const { stdout } = await apply(source, server.url, ['--dry-run']);
      expect(stdout).toContain('order: removed cta');
      expect(stdout).toContain('Dry run');
      expect(await readFile(join(source, 'templates', 'page.json'), 'utf8')).toBe(before);
      expect(server.cleared).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('leaves the theme alone when nothing is overridden', async () => {
    const source = await themeDir();
    const server = await pluginServer({});

    try {
      const before = await readFile(join(source, 'templates', 'page.json'), 'utf8');
      const { stdout } = await apply(source, server.url);
      expect(stdout).toContain('No editor overrides to apply');
      expect(await readFile(join(source, 'templates', 'page.json'), 'utf8')).toBe(before);
    } finally {
      server.close();
    }
  });
});
