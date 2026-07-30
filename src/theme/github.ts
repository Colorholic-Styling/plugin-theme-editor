/**
 * GitHub as a theme source. A Worker has no filesystem and no git binary, so
 * none of this shells out: the Git Data API does the same work over HTTP —
 * read a tree to clone, then blobs → tree → commit → move the ref to push.
 * That also makes a push atomic, which a file-at-a-time API would not be.
 */
export interface GitHubRepo {
  owner: string;
  repo: string;
  branch: string;
  /** Directory inside the repo the theme lives in, e.g. `views`. */
  path: string;
}

export interface GitHubFile {
  /** Store path, e.g. `/templates/page.json`. */
  path: string;
  content: string;
}

export class GitHubError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = 'GitHubError';
  }
}

const API = 'https://api.github.com';

/** Theme files GitHub is allowed to bring in, matching what the renderer reads. */
const THEME_FILE = /\.(liquid|json|css|js|svg|png|jpe?g|webp|woff2?)$/i;

export class GitHubClient {
  constructor(private readonly token: string) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'cms-plugin-theme-editor',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GitHubError(
        `GitHub ${init.method ?? 'GET'} ${path} responded ${response.status}. ${detail.slice(0, 200)}`,
        response.status,
      );
    }
    return await response.json() as T;
  }

  async headCommit(repo: GitHubRepo): Promise<{ sha: string; treeSha: string }> {
    const ref = await this.call<{ object: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${encodeURIComponent(repo.branch)}`,
    ).catch(async (error: unknown) => {
      // A private repository a token cannot see answers 404, the same as a
      // branch that does not exist, so the raw status cannot tell them apart.
      if (error instanceof GitHubError && error.status === 404) {
        throw new GitHubError(await this.explain404(repo), 404);
      }
      throw error;
    });
    const commit = await this.call<{ tree: { sha: string } }>(
      `/repos/${repo.owner}/${repo.repo}/git/commits/${ref.object.sha}`,
    );
    return { sha: ref.object.sha, treeSha: commit.tree.sha };
  }

  /**
   * Turns a 404 into the thing to go and fix. Asking whether the repository
   * itself is visible separates "the token cannot see it" from "that branch is
   * not there", which the status alone never distinguishes.
   */
  private async explain404(repo: GitHubRepo): Promise<string> {
    const target = `${repo.owner}/${repo.repo}`;
    let visible: { default_branch?: string };
    try {
      visible = await this.call<{ default_branch?: string }>(`/repos/${repo.owner}/${repo.repo}`);
    } catch {
      const identity = await this.identity();
      return `The token cannot see ${target}. GitHub answers 404 rather than 403 for a private `
        + `repository a token has no access to, so this is access, not a missing branch. `
        + `${identity}Check that the token's resource owner is ${repo.owner} (not a personal `
        + `account), that ${target} is among its selected repositories, and — if ${repo.owner} `
        + `is an organisation — that an owner has approved the token. A classic token needs the `
        + `full \`repo\` scope for private repositories; \`public_repo\` is not enough.`;
    }

    const branches = await this.call<Array<{ name: string }>>(
      `/repos/${repo.owner}/${repo.repo}/branches?per_page=100`,
    ).catch(() => [] as Array<{ name: string }>);
    const names = branches.map((branch) => branch.name);
    return `${target} is visible, but it has no branch \`${repo.branch}\`.`
      + `${visible.default_branch ? ` Its default branch is \`${visible.default_branch}\`.` : ''}`
      + `${names.length ? ` Branches: ${names.slice(0, 10).join(', ')}.` : ''}`;
  }

  /** Who the token acts as, when that is knowable, to narrow a 404 down. */
  private async identity(): Promise<string> {
    try {
      const user = await this.call<{ login?: string }>('/user');
      return user.login ? `The token authenticates as ${user.login}. ` : '';
    } catch {
      return 'The token did not authenticate against /user, so it may be expired or revoked. ';
    }
  }

  /**
   * The theme's files at the branch head. One recursive tree read plus a blob
   * per file, rather than a clone of the whole repository history.
   */
  async readTheme(repo: GitHubRepo): Promise<GitHubFile[]> {
    const { treeSha } = await this.headCommit(repo);
    const tree = await this.call<{
      tree: Array<{ path: string; type: string; sha: string }>;
      truncated: boolean;
    }>(`/repos/${repo.owner}/${repo.repo}/git/trees/${treeSha}?recursive=1`);

    if (tree.truncated) {
      throw new GitHubError('The repository tree is too large to read in one request.');
    }

    const prefix = repo.path ? `${repo.path.replace(/^\/+|\/+$/g, '')}/` : '';
    const wanted = tree.tree.filter((entry) =>
      entry.type === 'blob' && entry.path.startsWith(prefix) && THEME_FILE.test(entry.path));

    return Promise.all(wanted.map(async (entry) => {
      const blob = await this.call<{ content: string; encoding: string }>(
        `/repos/${repo.owner}/${repo.repo}/git/blobs/${entry.sha}`,
      );
      return {
        path: `/${entry.path.slice(prefix.length)}`,
        content: blob.encoding === 'base64' ? decodeBase64(blob.content) : blob.content,
      };
    }));
  }

  /**
   * Commits the given files onto the branch. The new tree is based on the
   * branch's current one, so files this editor never touched are carried over
   * untouched rather than being dropped by omission.
   */
  async commit(repo: GitHubRepo, files: GitHubFile[], message: string): Promise<string> {
    if (files.length === 0) throw new GitHubError('Nothing to commit.');
    const head = await this.headCommit(repo);
    const prefix = repo.path ? `${repo.path.replace(/^\/+|\/+$/g, '')}/` : '';

    const blobs = await Promise.all(files.map(async (file) => {
      const blob = await this.call<{ sha: string }>(
        `/repos/${repo.owner}/${repo.repo}/git/blobs`,
        {
          method: 'POST',
          body: JSON.stringify({ content: file.content, encoding: 'utf-8' }),
        },
      );
      return {
        path: `${prefix}${file.path.replace(/^\/+/, '')}`,
        mode: '100644' as const,
        type: 'blob' as const,
        sha: blob.sha,
      };
    }));

    const tree = await this.call<{ sha: string }>(
      `/repos/${repo.owner}/${repo.repo}/git/trees`,
      {
        method: 'POST',
        body: JSON.stringify({ base_tree: head.treeSha, tree: blobs }),
      },
    );

    const commit = await this.call<{ sha: string }>(
      `/repos/${repo.owner}/${repo.repo}/git/commits`,
      {
        method: 'POST',
        body: JSON.stringify({ message, tree: tree.sha, parents: [head.sha] }),
      },
    );

    await this.call(`/repos/${repo.owner}/${repo.repo}/git/refs/heads/${encodeURIComponent(repo.branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha }),
    });
    return commit.sha;
  }
}

/** Repo coordinates, from a form or a theme's manifest. */
export function parseRepo(value: Partial<Record<keyof GitHubRepo, string>>): GitHubRepo | null {
  const owner = (value.owner ?? '').trim();
  const repo = (value.repo ?? '').trim();
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return {
    owner,
    repo,
    branch: (value.branch ?? '').trim() || 'main',
    path: (value.path ?? '').trim().replace(/^\/+|\/+$/g, ''),
  };
}

/** Accepts what a browser address bar holds, so a repo URL can be pasted. */
export function repoFromUrl(url: string): Pick<GitHubRepo, 'owner' | 'repo'> | null {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? { owner: match[1], repo: match[2] } : null;
}

function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
