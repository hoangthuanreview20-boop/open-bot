/**
 * Git host client — GitHub REST API via the user's own token (v0.7,
 * ROADMAP §2b "Kết nối hệ quản lý source (git host)" / "Quản lý pull
 * request" / "Xem/Cập nhật code tour của pull request" / "Sửa label
 * của pull request").
 *
 * Only the PUBLIC GitHub API is used (api.github.com, or a custom
 * `baseUrl` for GitHub Enterprise / tests). The token NEVER lives
 * here: the host supplies `getToken()` which reads it from the Vault
 * (namespace 'provider' or a git namespace the host chooses — the
 * host decides; this module only receives the value for one call).
 * The token is sent as an `Authorization: Bearer` header and is never
 * logged, never put in a URL, and never appears in an error message.
 *
 * The `fetch` implementation is injectable (`fetchFn`) so tests can
 * use a mock instead of the live GitHub API. No live x.ai connection
 * is involved; no code is copied from xAI/Cursor.
 */
import type { ToolContext } from '../types';

export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 500;

export type GitFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** How the host hands the user's GitHub token to this client. */
export type GetGitHubToken = () => string | null | Promise<string | null>;

export interface GitHostOptions {
  /** Token callback supplied by the host (reads the Vault). Required for any call. */
  getToken: GetGitHubToken;
  /** API base URL. Default: https://api.github.com. No trailing slash needed. */
  baseUrl?: string;
  /** Injectable fetch (tests use a mock). Default: global fetch. */
  fetchFn?: GitFetchFn;
}

export interface GitRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  htmlUrl: string;
  defaultBranch: string;
}

export interface GitPullRequest {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  author: string;
  headBranch: string;
  baseBranch: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GitPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface GitPullRequestComment {
  id: number;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  createdAt: string;
  htmlUrl: string;
}

const OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertOwnerRepo(owner: string, repo: string): void {
  if (!OWNER_REPO_RE.test(owner)) {
    throw new Error(`Invalid GitHub owner "${owner}": use only letters, digits, ".", "-" and "_".`);
  }
  if (!OWNER_REPO_RE.test(repo)) {
    throw new Error(`Invalid GitHub repo "${repo}": use only letters, digits, ".", "-" and "_".`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseRepo(raw: unknown): GitRepo | null {
  if (!isRecord(raw)) return null;
  const fullName = asString(raw['full_name']);
  if (!fullName) return null;
  const ownerObj = isRecord(raw['owner']) ? raw['owner'] : {};
  return {
    fullName,
    name: asString(raw['name']) || fullName.split('/')[1] || fullName,
    owner: asString(ownerObj['login']) || fullName.split('/')[0] || '',
    private: raw['private'] === true,
    description: typeof raw['description'] === 'string' ? (raw['description'] as string) : null,
    htmlUrl: asString(raw['html_url']),
    defaultBranch: asString(raw['default_branch']) || 'main',
  };
}

function parsePullRequest(raw: unknown): GitPullRequest | null {
  if (!isRecord(raw)) return null;
  if (typeof raw['number'] !== 'number') return null;
  const userObj = isRecord(raw['user']) ? raw['user'] : {};
  const headObj = isRecord(raw['head']) ? raw['head'] : {};
  const baseObj = isRecord(raw['base']) ? raw['base'] : {};
  const labelsRaw = Array.isArray(raw['labels']) ? raw['labels'] : [];
  const labels: string[] = [];
  for (const label of labelsRaw) {
    if (typeof label === 'string') labels.push(label);
    else if (isRecord(label) && typeof label['name'] === 'string') {
      labels.push(label['name'] as string);
    }
  }
  return {
    number: raw['number'] as number,
    title: asString(raw['title']),
    state: asString(raw['state']),
    htmlUrl: asString(raw['html_url']),
    author: asString(userObj['login']),
    headBranch: asString(headObj['ref']),
    baseBranch: asString(baseObj['ref']),
    body: asString(raw['body']),
    labels,
    createdAt: asString(raw['created_at']),
    updatedAt: asString(raw['updated_at']),
  };
}

function parsePullRequestFile(raw: unknown): GitPullRequestFile | null {
  if (!isRecord(raw)) return null;
  if (typeof raw['filename'] !== 'string') return null;
  return {
    filename: raw['filename'] as string,
    status: asString(raw['status']),
    additions: typeof raw['additions'] === 'number' ? (raw['additions'] as number) : 0,
    deletions: typeof raw['deletions'] === 'number' ? (raw['deletions'] as number) : 0,
    patch: asString(raw['patch']),
  };
}

function parseComment(raw: unknown): GitPullRequestComment | null {
  if (!isRecord(raw)) return null;
  if (typeof raw['id'] !== 'number') return null;
  const userObj = isRecord(raw['user']) ? raw['user'] : {};
  return {
    id: raw['id'] as number,
    author: asString(userObj['login']),
    body: asString(raw['body']),
    path: typeof raw['path'] === 'string' ? (raw['path'] as string) : null,
    line: typeof raw['line'] === 'number' ? (raw['line'] as number) : null,
    createdAt: asString(raw['created_at']),
    htmlUrl: asString(raw['html_url']),
  };
}

export class GitHostError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GitHostError';
    this.status = status;
  }
}

/**
 * Thin GitHub API client. One instance per host wiring; the token is
 * fetched fresh (via `getToken`) for every request so a rotated token
 * is picked up without rebuilding the client.
 */
export class GitHubClient {
  private readonly getToken: GetGitHubToken;
  private readonly baseUrl: string;
  private readonly fetchFn: GitFetchFn;

  constructor(options: GitHostOptions) {
    if (typeof options.getToken !== 'function') {
      throw new Error('GitHub client needs a getToken callback (the host reads the token from the Vault).');
    }
    this.getToken = options.getToken;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, '');
    if (!this.baseUrl.startsWith('http://') && !this.baseUrl.startsWith('https://')) {
      throw new Error('GitHub baseUrl must be http:// or https://.');
    }
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Base URL this client talks to (no token in it, safe to show). */
  get apiBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    parse: (body: unknown) => T,
  ): Promise<T> {
    const token = await this.getToken();
    if (!token) {
      throw new GitHostError(
        'No GitHub token is configured. Store a personal access token in the Vault ' +
          '(the host wires getGitHubToken to read it) and try again.',
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    timer.unref?.();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new GitHostError(`GitHub request timed out after ${FETCH_TIMEOUT_MS}ms: ${path}`);
      }
      throw new GitHostError(`GitHub request failed (network error: ${(err as Error).message})`);
    } finally {
      clearTimeout(timer);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new GitHostError(
        `GitHub returned a non-JSON response (HTTP ${res.status}) for ${path}.`,
        res.status,
      );
    }
    if (!res.ok) {
      const message =
        isRecord(parsed) && typeof parsed['message'] === 'string'
          ? (parsed['message'] as string)
          : res.statusText;
      // Never include the response body beyond the short message: it
      // must not be able to carry a token back into an error string.
      const hint =
        res.status === 401
          ? ' Check the GitHub token in the Vault — a 401 means it is missing, expired or revoked.'
          : res.status === 403
            ? ' A 403 usually means the token lacks the needed scope (repo) or the rate limit was hit.'
            : res.status === 404
              ? ' A 404 can also mean the repo/PR is private and the token cannot see it.'
              : '';
      throw new GitHostError(
        `GitHub API error ${res.status} for ${path}: ${message.slice(0, MAX_ERROR_BODY_CHARS)}.${hint}`,
        res.status,
      );
    }
    return parse(parsed);
  }

  private get<T>(path: string, parse: (body: unknown) => T): Promise<T> {
    return this.request(path, { method: 'GET' }, parse);
  }

  private send<T>(
    method: 'POST' | 'PATCH',
    path: string,
    body: Record<string, unknown>,
    parse: (body: unknown) => T,
  ): Promise<T> {
    return this.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      parse,
    );
  }

  /** Check the token works (`GET /user`) and list the user's repos (`GET /user/repos`). */
  async listRepos(perPage = 30): Promise<GitRepo[]> {
    const page = Math.max(1, Math.min(100, Math.floor(perPage)));
    return this.get(`/user/repos?per_page=${page}&sort=updated`, (body) => {
      if (!Array.isArray(body)) throw new GitHostError('GitHub returned an unexpected repos response.');
      const repos: GitRepo[] = [];
      for (const raw of body) {
        const repo = parseRepo(raw);
        if (repo) repos.push(repo);
      }
      return repos;
    });
  }

  /** `GET /user` — validates the token and returns the login name. */
  async checkToken(): Promise<string> {
    return this.get('/user', (body) => {
      if (!isRecord(body) || typeof body['login'] !== 'string') {
        throw new GitHostError('GitHub returned an unexpected /user response.');
      }
      return body['login'] as string;
    });
  }

  /** List pull requests of a repo (`GET /repos/{owner}/{repo}/pulls`). */
  async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open',
  ): Promise<GitPullRequest[]> {
    assertOwnerRepo(owner, repo);
    const query = new URLSearchParams({ state, per_page: '30', sort: 'updated', direction: 'desc' });
    return this.get(`/repos/${owner}/${repo}/pulls?${query}`, (body) => {
      if (!Array.isArray(body)) throw new GitHostError('GitHub returned an unexpected pulls response.');
      const prs: GitPullRequest[] = [];
      for (const raw of body) {
        const pr = parsePullRequest(raw);
        if (pr) prs.push(pr);
      }
      return prs;
    });
  }

  /** Get one pull request (`GET /repos/{owner}/{repo}/pulls/{number}`). */
  async getPullRequest(owner: string, repo: string, number: number): Promise<GitPullRequest> {
    assertOwnerRepo(owner, repo);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`Invalid pull request number: ${number}`);
    }
    return this.get(`/repos/${owner}/${repo}/pulls/${number}`, (body) => {
      const pr = parsePullRequest(body);
      if (!pr) throw new GitHostError(`GitHub returned an unexpected pull request response for #${number}.`);
      return pr;
    });
  }

  /** Create a pull request (`POST /repos/{owner}/{repo}/pulls`). */
  async createPullRequest(
    owner: string,
    repo: string,
    input: { title: string; head: string; base: string; body?: string; draft?: boolean },
  ): Promise<GitPullRequest> {
    assertOwnerRepo(owner, repo);
    if (!input.title.trim()) throw new Error('Pull request title must not be empty.');
    if (!input.head.trim()) throw new Error('Pull request head branch must not be empty.');
    if (!input.base.trim()) throw new Error('Pull request base branch must not be empty.');
    const body: Record<string, unknown> = {
      title: input.title,
      head: input.head,
      base: input.base,
    };
    if (input.body !== undefined) body['body'] = input.body;
    if (input.draft === true) body['draft'] = true;
    return this.send('POST', `/repos/${owner}/${repo}/pulls`, body, (raw) => {
      const pr = parsePullRequest(raw);
      if (!pr) throw new GitHostError('GitHub returned an unexpected pull request response on create.');
      return pr;
    });
  }

  /** Update a pull request's title / body / state (`PATCH /repos/{owner}/{repo}/pulls/{number}`). */
  async updatePullRequest(
    owner: string,
    repo: string,
    number: number,
    patch: { title?: string; body?: string; state?: 'open' | 'closed' },
  ): Promise<GitPullRequest> {
    assertOwnerRepo(owner, repo);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`Invalid pull request number: ${number}`);
    }
    if (patch.title !== undefined && !patch.title.trim()) {
      throw new Error('Pull request title must not be empty when given.');
    }
    if (patch.title === undefined && patch.body === undefined && patch.state === undefined) {
      throw new Error('updatePullRequest needs at least one of title, body or state.');
    }
    return this.send('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, patch, (raw) => {
      const pr = parsePullRequest(raw);
      if (!pr) throw new GitHostError('GitHub returned an unexpected pull request response on update.');
      return pr;
    });
  }

  /** Replace a pull request's labels (`PUT /repos/{owner}/{repo}/issues/{number}/labels`). */
  async setPullRequestLabels(
    owner: string,
    repo: string,
    number: number,
    labels: string[],
  ): Promise<string[]> {
    assertOwnerRepo(owner, repo);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`Invalid pull request number: ${number}`);
    }
    if (labels.some((l) => typeof l !== 'string' || !l.trim())) {
      throw new Error('Labels must be non-empty strings.');
    }
    return this.request(
      `/repos/${owner}/${repo}/issues/${number}/labels`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels }),
      },
      (body) => {
        if (!Array.isArray(body)) throw new GitHostError('GitHub returned an unexpected labels response.');
        const out: string[] = [];
        for (const raw of body) {
          if (typeof raw === 'string') out.push(raw);
          else if (isRecord(raw) && typeof raw['name'] === 'string') out.push(raw['name'] as string);
        }
        return out;
      },
    );
  }

  /** Files changed by a pull request (`GET .../pulls/{number}/files`). */
  async listPullRequestFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitPullRequestFile[]> {
    assertOwnerRepo(owner, repo);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`Invalid pull request number: ${number}`);
    }
    return this.get(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, (body) => {
      if (!Array.isArray(body)) throw new GitHostError('GitHub returned an unexpected PR files response.');
      const files: GitPullRequestFile[] = [];
      for (const raw of body) {
        const file = parsePullRequestFile(raw);
        if (file) files.push(file);
      }
      return files;
    });
  }

  /** Review comments on a pull request (`GET .../pulls/{number}/comments`). */
  async listPullRequestComments(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitPullRequestComment[]> {
    assertOwnerRepo(owner, repo);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`Invalid pull request number: ${number}`);
    }
    return this.get(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`, (body) => {
      if (!Array.isArray(body)) {
        throw new GitHostError('GitHub returned an unexpected PR comments response.');
      }
      const comments: GitPullRequestComment[] = [];
      for (const raw of body) {
        const comment = parseComment(raw);
        if (comment) comments.push(comment);
      }
      return comments;
    });
  }

  /**
   * Add a review comment to a pull request. With `path` + `line` it is
   * an inline code comment (`POST .../pulls/{number}/comments`); without
   * them it is a general PR comment (`POST .../issues/{number}/comments`).
   */
  async addPullRequestComment(
    owner: string,
    repo: string,
    number: number,
    input: { body: string; path?: string; line?: number; commitId?: string },
  ): Promise<GitPullRequestComment> {
    assertOwnerRepo(owner, repo);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`Invalid pull request number: ${number}`);
    }
    if (!input.body.trim()) throw new Error('Comment body must not be empty.');
    if (input.path !== undefined) {
      if (!input.commitId) {
        throw new Error('An inline code comment needs commitId (the head SHA of the PR).');
      }
      if (!Number.isInteger(input.line) || (input.line as number) < 1) {
        throw new Error('An inline code comment needs a positive line number.');
      }
      return this.send(
        'POST',
        `/repos/${owner}/${repo}/pulls/${number}/comments`,
        { body: input.body, path: input.path, line: input.line, commit_id: input.commitId },
        (raw) => {
          const comment = parseComment(raw);
          if (!comment) throw new GitHostError('GitHub returned an unexpected comment response.');
          return comment;
        },
      );
    }
    return this.send(
      'POST',
      `/repos/${owner}/${repo}/issues/${number}/comments`,
      { body: input.body },
      (raw) => {
        const comment = parseComment(raw);
        if (!comment) throw new GitHostError('GitHub returned an unexpected comment response.');
        return comment;
      },
    );
  }

  /**
   * Submit a review on a pull request (`POST .../pulls/{number}/reviews`).
   * `event` is APPROVE, REQUEST_CHANGES or COMMENT.
   */
  async submitPullRequestReview(
    owner: string,
    repo: string,
    number: number,
    input: { body?: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' },
  ): Promise<{ id: number; state: string }> {
    assertOwnerRepo(owner, repo);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`Invalid pull request number: ${number}`);
    }
    return this.send(
      'POST',
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
      { body: input.body ?? '', event: input.event },
      (raw) => {
        if (!isRecord(raw) || typeof raw['id'] !== 'number') {
          throw new GitHostError('GitHub returned an unexpected review response.');
        }
        return { id: raw['id'] as number, state: asString(raw['state']) };
      },
    );
  }
}

/** Factory — same name as the class for callers that prefer a function. */
export function createGitHubClient(options: GitHostOptions): GitHubClient {
  return new GitHubClient(options);
}

/** Re-exported so tool code can type the context it already receives. */
export type { ToolContext };
