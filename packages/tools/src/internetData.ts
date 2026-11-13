/**
 * Internet data tools for @open-bot/tools (v0.95, Team D1).
 *
 * Huy's direction 2026-11-12: NO X data needed — build a comprehensive
 * internet-wide data layer, broader than X, free and local-first.
 * Everything here is written from scratch for open-bot (ideas only,
 * no code/text/assets copied from any other repo).
 *
 *   internet_search   — multi-source web search, free/public sources
 *                         first (Wikipedia API, DuckDuckGo lite/html).
 *                         Keyed sources (Brave Search API) are opt-in
 *                         via a Vault-backed key resolver; the app
 *                         never blocks when no key is configured.
 *   web_fetch_clean   — fetch a public URL and return clean readable
 *                         text (readability-style boilerplate strip).
 *   feed_subscribe / feed_list / feed_read / feed_unsubscribe
 *                     — RSS/Atom feeds, persisted locally in
 *                       `<userData>/internet-data.json` (JSON file
 *                       store, atomic write; memory-only when no
 *                       state file is configured).
 *   watch_url / watch_list / watch_check / watch_remove
 *                     — watch a page for changes: poll on interval,
 *                       hash the extracted text, summarise the diff.
 *                       Changes are reported through the optional
 *                       `onWatchChanged` callback (the coordinator
 *                       forwards it as an `internet.watch-changed`
 *                       agent event, which main turns into an OS
 *                       notification + a renderer IPC event).
 *
 * Safety: every fetch goes through the SSRF guard (`assertPublicUrl`,
 * or the team egress policy when one is configured) with manual
 * redirect following (max 5 hops, each hop re-checked) — same rules
 * as `web_fetch` / `http_get` / `http_request`. 30s... (20s here)
 * timeout, 1 MB body cap. No credential is ever sent: the only
 * Authorization header is the Brave key, sent ONLY to
 * api.search.brave.com and ONLY when the host configured it.
 *
 * Testability: `fetchFn` / `lookupFn` / `now` are injectable, so
 * tests use a local mock fetch and never touch the live network.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool } from '@open-bot/core';
import type { EgressPolicy } from '@open-bot/core/dist/egress/policy';
import { assertEgressUrl, assertPublicUrl } from './ssrf';
import { MAX_TOOL_RESULT_CHARS, truncateText as truncate } from './truncate';

export { MAX_TOOL_RESULT_CHARS };

/** Hard timeout for one internet fetch (all redirect hops share it). */
export const INTERNET_FETCH_TIMEOUT_MS = 20_000;
/** Max response body read per fetch: 1 MB. */
export const INTERNET_MAX_BODY_BYTES = 1_000_000;
/** Max redirects followed (each hop re-checked against the SSRF guard). */
export const INTERNET_MAX_REDIRECTS = 5;
/** Max search results returned by internet_search. */
export const INTERNET_SEARCH_MAX_RESULTS = 20;
/** Max feed items parsed / returned per feed. */
export const INTERNET_FEED_MAX_ITEMS = 50;
/** Watch interval bounds (minutes): 5 min .. 24 h. */
export const WATCH_MIN_INTERVAL_MINUTES = 5;
export const WATCH_MAX_INTERVAL_MINUTES = 1440;
/** Default watch interval: 60 minutes. */
export const WATCH_DEFAULT_INTERVAL_MINUTES = 60;
/** File name of the persisted internet-data state (inside userData). */
export const INTERNET_DATA_FILE = 'internet-data.json';
/** Max feeds / watches kept in the store (oldest dropped on add). */
export const INTERNET_MAX_FEEDS = 200;
export const INTERNET_MAX_WATCHES = 200;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export interface InternetDataOptions {
  /** File holding feeds + watches (undefined = memory-only store). */
  stateFile?: string;
  /** Fetch implementation (tests inject a mock; default global fetch). */
  fetchFn?: FetchFn;
  /** DNS lookup (tests inject a fake; default real DNS via ssrf). */
  lookupFn?: LookupFn;
  /** Lazily resolve the egress policy in force (team policy). */
  getEgressPolicy?: () => EgressPolicy | null | undefined;
  /**
   * Opt-in keyed-source resolver: `getApiKey('brave')` returns the
   * Brave Search API key from the Vault (or undefined = not
   * configured). The tool never reads the Vault or env itself.
   */
  getApiKey?: (name: string) => string | undefined;
  /** Clock (tests inject a fixed time; default Date.now). */
  now?: () => number;
  /** Called once per watch that changed during a `watch_check`. */
  onWatchChanged?: (event: WatchChangeEvent) => void;
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

/** Strip tags + collapse whitespace (used on titles/snippets). */
export function stripTags(text: string): string {
  return decodeHtmlEntities(text.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Readable-text extraction (readability-style, no dependency)
// ---------------------------------------------------------------------------

/** Tags whose whole subtree is boilerplate, never article content. */
const BOILERPLATE_TAG_RE =
  /<(script|style|noscript|svg|form|nav|header|footer|aside|iframe|button|select|textarea|input)[\s>][\s\S]*?<\/\1\s*>|<(script|style|noscript|svg|form|nav|header|footer|aside|iframe|button|select|textarea|input)[\s>][^>]*\/>/gi;

/**
 * Extract the readable text of an HTML page: drop boilerplate
 * (scripts, styles, nav/header/footer/aside, forms), prefer
 * `<article>` / `<main>` when present, then keep headings +
 * paragraphs + list items in document order. Returns the page
 * `<title>` first when one exists.
 */
export function extractReadableText(html: string): string {
  let title = '';
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) title = stripTags(titleMatch[1]);
  let region = html;
  const articleMatch = html.match(/<article[\s>][\s\S]*?<\/article\s*>/i);
  const mainMatch = html.match(/<main[\s>][\s\S]*?<\/main\s*>/i);
  if (articleMatch?.[0]) region = articleMatch[0];
  else if (mainMatch?.[0]) region = mainMatch[0];
  else {
    const bodyMatch = html.match(/<body[\s>][\s\S]*?<\/body\s*>/i);
    if (bodyMatch?.[0]) region = bodyMatch[0];
  }
  region = region.replace(BOILERPLATE_TAG_RE, ' ');
  // Keep block structure: turn block tags into newlines, then strip
  // the rest. (Comments and doctype go away with the tag strip.)
  const text = stripTags(
    region
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
      .replace(/<(br|hr)[^>]*>/gi, '\n'),
  );
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Drop cookie/consent one-liners that survive the tag strip.
  const kept = lines.filter(
    (l) => !/^(accept|agree|cookie|subscribe|sign up|đồng ý|chấp nhận)/i.test(l) || l.length > 80,
  );
  const body = kept.join('\n');
  return title ? `${title}\n${body}`.trim() : body;
}

// ---------------------------------------------------------------------------
// RSS / Atom parsing (no dependency)
// ---------------------------------------------------------------------------

export interface FeedItem {
  title: string;
  link: string;
  /** ISO date string when the feed carries one, else ''. */
  published: string;
  summary: string;
  /** guid / atom id when present, else the link. */
  id: string;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

function unwrapCdata(xml: string): string {
  return xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => inner);
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m?.[1] ? stripTags(m[1]) : '';
}

function atomLink(block: string): string {
  // Prefer rel="alternate", else the first <link href="...">.
  const links = [...block.matchAll(/<link[^>]*href="([^"]+)"[^>]*>/gi)];
  if (links.length === 0) return '';
  const alternate = links.find((m) => /rel="alternate"/i.test(m[0] ?? ''));
  return (alternate?.[1] ?? links[0]?.[1] ?? '').trim();
}

/**
 * Parse an RSS 2.0 (`<item>`) or Atom (`<entry>`) document.
 * Unknown / malformed input yields an empty item list, never a throw.
 */
export function parseFeedXml(xml: string): ParsedFeed {
  const clean = unwrapCdata(xml);
  let title = '';
  const channelTitle = clean.match(/<(?:channel|feed)[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  if (channelTitle?.[1]) title = stripTags(channelTitle[1]);
  const items: FeedItem[] = [];
  const rssItems = [...clean.matchAll(/<item[\s>][\s\S]*?<\/item\s*>/gi)];
  for (const m of rssItems) {
    const block = m[0];
    const link = tagText(block, 'link');
    const guid = tagText(block, 'guid');
    items.push({
      title: tagText(block, 'title') || '(no title)',
      link,
      published: tagText(block, 'pubDate') || tagText(block, 'date'),
      summary: tagText(block, 'description') || tagText(block, 'summary'),
      id: guid || link,
    });
    if (items.length >= INTERNET_FEED_MAX_ITEMS) break;
  }
  if (items.length === 0) {
    const entries = [...clean.matchAll(/<entry[\s>][\s\S]*?<\/entry\s*>/gi)];
    for (const m of entries) {
      const block = m[0];
      const link = atomLink(block);
      const id = tagText(block, 'id');
      items.push({
        title: tagText(block, 'title') || '(no title)',
        link,
        published: tagText(block, 'updated') || tagText(block, 'published'),
        summary: tagText(block, 'summary') || tagText(block, 'content'),
        id: id || link,
      });
      if (items.length >= INTERNET_FEED_MAX_ITEMS) break;
    }
  }
  return { title, items };
}

// ---------------------------------------------------------------------------
// SSRF-guarded fetch with injectable fetch (mirrors fetchPublic)
// ---------------------------------------------------------------------------

async function assertUrlAllowed(url: URL, opts: InternetDataOptions): Promise<void> {
  if (opts.getEgressPolicy !== undefined) {
    const policy = opts.getEgressPolicy();
    await assertEgressUrl(url, policy ?? null, { lookupFn: opts.lookupFn });
    return;
  }
  await assertPublicUrl(url, { lookupFn: opts.lookupFn });
}

export interface FetchedDocument {
  url: string;
  status: number;
  contentType: string;
  text: string;
}

/**
 * Fetch a public URL with the SSRF guard, manual redirect following
 * (max 5 hops, each hop re-checked), a hard timeout and a 1 MB body
 * cap. Returns the final URL + status + body text.
 */
export async function fetchPublicDocument(
  rawUrl: string,
  opts: InternetDataOptions = {},
  init: RequestInit = {},
): Promise<FetchedDocument> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http:// and https:// URLs are allowed, got "${url.protocol}"`);
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const deadline = Date.now() + INTERNET_FETCH_TIMEOUT_MS;
  let current = url;
  for (let hop = 0; hop <= INTERNET_MAX_REDIRECTS; hop += 1) {
    await assertUrlAllowed(current, opts);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Request timed out after ${INTERNET_FETCH_TIMEOUT_MS}ms: ${current}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response;
    try {
      res = await fetchFn(current.toString(), {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Request timed out after ${INTERNET_FETCH_TIMEOUT_MS}ms: ${current}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const location = res.headers?.get?.('location') ?? null;
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === INTERNET_MAX_REDIRECTS) {
        throw new Error(`Too many redirects (>${INTERNET_MAX_REDIRECTS}) when requesting ${current}`);
      }
      current = new URL(location, current);
      continue;
    }
    const contentType = res.headers?.get?.('content-type') ?? '';
    const rawBody = await res.text();
    let text = rawBody;
    if (Buffer.byteLength(rawBody, 'utf8') > INTERNET_MAX_BODY_BYTES) {
      text = Buffer.from(rawBody, 'utf8').subarray(0, INTERNET_MAX_BODY_BYTES).toString('utf8');
    }
    return { url: current.toString(), status: res.status, contentType, text };
  }
  throw new Error(`Too many redirects (>${INTERNET_MAX_REDIRECTS}) when requesting ${url}`);
}

// ---------------------------------------------------------------------------
// Web search — free/public sources first, keyed sources opt-in
// ---------------------------------------------------------------------------

export interface SearchResult {
  title: string;
  href: string;
  snippet: string;
}

export interface SearchOutcome {
  source: string;
  results: SearchResult[];
}

/** Wikipedia API (free, no key): opensearch-style `list=search`. */
export async function searchWikipedia(
  query: string,
  opts: InternetDataOptions = {},
  limit = 8,
): Promise<SearchResult[]> {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&format=json&list=search` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${Math.max(1, Math.min(limit, INTERNET_SEARCH_MAX_RESULTS))}&utf8=1`;
  const doc = await fetchPublicDocument(url, opts, {
    headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/json' },
  });
  if (doc.status !== 200) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.text);
  } catch {
    return [];
  }
  const hits = (parsed as { query?: { search?: Array<{ title?: string; snippet?: string }> } }).query
    ?.search;
  if (!Array.isArray(hits)) return [];
  return hits.map((h) => ({
    title: typeof h.title === 'string' ? h.title : '',
    href: `https://en.wikipedia.org/wiki/${encodeURIComponent((h.title ?? '').replace(/ /g, '_'))}`,
    snippet: typeof h.snippet === 'string' ? stripTags(h.snippet) : '',
  }));
}

/** DuckDuckGo lite (free, no key, minimal HTML — most stable scrape). */
export function parseDuckDuckGoLiteResults(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const linkRe = /class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  const links: Array<{ href: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < INTERNET_SEARCH_MAX_RESULTS) {
    let href = decodeHtmlEntities(m[1] ?? '').trim();
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        // Keep the wrapped link.
      }
    }
    if (!href || href.startsWith('#')) continue;
    links.push({ href, title: stripTags(m[2] ?? '') });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < INTERNET_SEARCH_MAX_RESULTS) {
    snippets.push(stripTags(m[1] ?? ''));
  }
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    if (link) out.push({ ...link, snippet: snippets[i] ?? '' });
  }
  return out;
}

/** DuckDuckGo HTML (free, no key) — same result markup as `web_search`. */
export function parseDuckDuckGoHtmlResults(html: string): SearchResult[] {
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ href: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < INTERNET_SEARCH_MAX_RESULTS) {
    let href = decodeHtmlEntities(m[1] ?? '').trim();
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) {
      try {
        href = decodeURIComponent(uddg[1]);
      } catch {
        // Keep the wrapped link.
      }
    }
    if (!href || href.startsWith('#')) continue;
    links.push({ href, title: stripTags(m[2] ?? '') });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < INTERNET_SEARCH_MAX_RESULTS) {
    snippets.push(stripTags(m[1] ?? ''));
  }
  return links.map((link, i) => ({ ...link, snippet: snippets[i] ?? '' }));
}

async function searchDuckDuckGo(
  query: string,
  opts: InternetDataOptions,
  limit: number,
): Promise<SearchOutcome | null> {
  try {
    const lite = await fetchPublicDocument(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      opts,
      { headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html' } },
    );
    if (lite.status === 200) {
      const results = parseDuckDuckGoLiteResults(lite.text).slice(0, limit);
      if (results.length > 0) return { source: 'DuckDuckGo lite', results };
    }
  } catch {
    // Fall through to the HTML endpoint.
  }
  try {
    const html = await fetchPublicDocument(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      opts,
      { headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html' } },
    );
    if (html.status === 200) {
      const results = parseDuckDuckGoHtmlResults(html.text).slice(0, limit);
      if (results.length > 0) return { source: 'DuckDuckGo', results };
    }
  } catch {
    // No usable results from either endpoint.
  }
  return null;
}

/**
 * Brave Search API (keyed, opt-in): only attempted when the host
 * configured a key via `getApiKey('brave')` — the free sources above
 * are tried first in `auto` mode and Brave is never required.
 */
export async function searchBrave(
  query: string,
  opts: InternetDataOptions,
  limit: number,
): Promise<SearchOutcome> {
  const apiKey = opts.getApiKey?.('brave');
  if (!apiKey) {
    throw new Error(
      'Brave Search needs an API key (opt-in): add a Brave Search key to the Vault ' +
        "(namespace 'search', key 'brave-api-key') and try again — the free sources " +
        '(Wikipedia / DuckDuckGo) work without any key.',
    );
  }
  const doc = await fetchPublicDocument(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.max(1, Math.min(limit, INTERNET_SEARCH_MAX_RESULTS))}`,
    opts,
    {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    },
  );
  if (doc.status !== 200) {
    throw new Error(`Brave Search failed with HTTP ${doc.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.text);
  } catch {
    throw new Error('Brave Search returned unparseable JSON.');
  }
  const hits = (parsed as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } })
    .web?.results;
  if (!Array.isArray(hits)) return { source: 'Brave', results: [] };
  return {
    source: 'Brave',
    results: hits.map((h) => ({
      title: typeof h.title === 'string' ? h.title : '',
      href: typeof h.url === 'string' ? h.url : '',
      snippet: typeof h.description === 'string' ? h.description : '',
    })),
  };
}

export type InternetSearchSource = 'auto' | 'wikipedia' | 'duckduckgo' | 'brave';

/**
 * Multi-source search. `auto` tries the free sources in order
 * (Wikipedia → DuckDuckGo lite → DuckDuckGo HTML) and returns the
 * first one with results; an explicit source tries only that one.
 */
export async function doInternetSearch(
  args: Record<string, unknown>,
  opts: InternetDataOptions = {},
): Promise<string> {
  const query = getStringArg(args, 'query').trim();
  if (!query) return errorResult('Search query must not be empty.');
  const limitRaw = getNumberArg(args, 'limit');
  const limit =
    limitRaw === undefined
      ? 8
      : Math.max(1, Math.min(INTERNET_SEARCH_MAX_RESULTS, Math.floor(limitRaw)));
  const sourceRaw = args['source'] === undefined ? 'auto' : getStringArg(args, 'source', false);
  const source = sourceRaw.toLowerCase();
  if (!['auto', 'wikipedia', 'duckduckgo', 'brave'].includes(source)) {
    return errorResult(
      `Unknown search source "${sourceRaw}". Allowed: auto, wikipedia, duckduckgo, brave.`,
    );
  }
  try {
    let outcome: SearchOutcome | null = null;
    if (source === 'wikipedia' || source === 'auto') {
      const wiki = await searchWikipedia(query, opts, limit).catch(() => [] as SearchResult[]);
      if (wiki.length > 0) outcome = { source: 'Wikipedia', results: wiki.slice(0, limit) };
    }
    if (!outcome && (source === 'duckduckgo' || source === 'auto')) {
      outcome = await searchDuckDuckGo(query, opts, limit);
    }
    if (!outcome && source === 'brave') {
      outcome = await searchBrave(query, opts, limit);
    }
    if (!outcome || outcome.results.length === 0) {
      return errorResult(
        `Internet search for "${query}" returned no results` +
          (source === 'auto'
            ? ' from Wikipedia or DuckDuckGo (both may be blocked or down — try again later).'
            : ` from ${source}.`),
      );
    }
    const lines = outcome.results.map((r, i) => {
      const snippet = r.snippet ? `\n  ${r.snippet}` : '';
      return `${i + 1}. ${r.title}\n   ${r.href}${snippet}`;
    });
    return truncate(
      `Internet search for "${query}" via ${outcome.source} — ${outcome.results.length} result(s):\n${lines.join('\n')}`,
    );
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Clean fetch
// ---------------------------------------------------------------------------

/** Fetch a URL and return its clean readable text (HTML → extracted text). */
export async function doWebFetchClean(
  args: Record<string, unknown>,
  opts: InternetDataOptions = {},
): Promise<string> {
  const rawUrl = getStringArg(args, 'url');
  try {
    const doc = await fetchPublicDocument(rawUrl, opts, {
      headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' },
    });
    if (doc.status < 200 || doc.status >= 300) {
      return errorResult(`GET ${doc.url} failed with HTTP ${doc.status}`);
    }
    const isHtml =
      doc.contentType.includes('html') ||
      /^\s*</.test(doc.text.slice(0, 512)) ||
      doc.contentType === '';
    const text = isHtml ? extractReadableText(doc.text) : doc.text;
    return truncate(`Fetched ${doc.url} (HTTP ${doc.status}):\n${text}`);
  } catch (err) {
    return errorResult((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Persistent store: feeds + watches in one JSON file (userData)
// ---------------------------------------------------------------------------

export interface InternetFeed {
  id: string;
  url: string;
  title: string;
  addedAt: number;
  lastCheckedAt?: number;
  lastItemCount?: number;
}

export interface InternetWatch {
  id: string;
  url: string;
  intervalMinutes: number;
  lastHash?: string;
  lastCheckedAt?: number;
  lastChangedAt?: number;
  lastSummary?: string;
  lastError?: string;
}

export interface InternetDataState {
  version: 1;
  feeds: InternetFeed[];
  watches: InternetWatch[];
}

export function emptyInternetDataState(): InternetDataState {
  return { version: 1, feeds: [], watches: [] };
}

export function internetIdForUrl(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
}

function isValidHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function parseState(raw: string): InternetDataState {
  try {
    const parsed = JSON.parse(raw) as Partial<InternetDataState>;
    if (typeof parsed !== 'object' || parsed === null) return emptyInternetDataState();
    const feeds = Array.isArray(parsed.feeds)
      ? (parsed.feeds as Array<Partial<InternetFeed>>)
          .filter((f) => typeof f?.url === 'string' && isValidHttpUrl(f.url) !== null)
          .map((f) => ({
            id: typeof f.id === 'string' ? f.id : internetIdForUrl(f.url as string),
            url: f.url as string,
            title: typeof f.title === 'string' ? f.title : (f.url as string),
            addedAt: typeof f.addedAt === 'number' ? f.addedAt : Date.now(),
            ...(typeof f.lastCheckedAt === 'number' ? { lastCheckedAt: f.lastCheckedAt } : {}),
            ...(typeof f.lastItemCount === 'number' ? { lastItemCount: f.lastItemCount } : {}),
          }))
      : [];
    const watches = Array.isArray(parsed.watches)
      ? (parsed.watches as Array<Partial<InternetWatch>>)
          .filter((w) => typeof w?.url === 'string' && isValidHttpUrl(w.url) !== null)
          .map((w) => ({
            id: typeof w.id === 'string' ? w.id : internetIdForUrl(w.url as string),
            url: w.url as string,
            intervalMinutes:
              typeof w.intervalMinutes === 'number' &&
              w.intervalMinutes >= WATCH_MIN_INTERVAL_MINUTES &&
              w.intervalMinutes <= WATCH_MAX_INTERVAL_MINUTES
                ? Math.floor(w.intervalMinutes)
                : WATCH_DEFAULT_INTERVAL_MINUTES,
            ...(typeof w.lastHash === 'string' ? { lastHash: w.lastHash } : {}),
            ...(typeof w.lastCheckedAt === 'number' ? { lastCheckedAt: w.lastCheckedAt } : {}),
            ...(typeof w.lastChangedAt === 'number' ? { lastChangedAt: w.lastChangedAt } : {}),
            ...(typeof w.lastSummary === 'string' ? { lastSummary: w.lastSummary } : {}),
            ...(typeof w.lastError === 'string' ? { lastError: w.lastError } : {}),
          }))
      : [];
    return { version: 1, feeds, watches };
  } catch {
    return emptyInternetDataState();
  }
}

/**
 * JSON store for feeds + watches. Atomic write (tmp file + rename)
 * so a crash mid-write never leaves a half-written state file; a
 * corrupt file loads as empty state instead of throwing.
 */
export class InternetDataStore {
  private readonly stateFile?: string;
  private state: InternetDataState = emptyInternetDataState();
  private loaded = false;

  constructor(stateFile?: string) {
    this.stateFile = stateFile;
  }

  load(): InternetDataState {
    if (this.loaded) return this.state;
    this.loaded = true;
    if (!this.stateFile) return this.state;
    try {
      if (!fs.existsSync(this.stateFile)) return this.state;
      this.state = parseState(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      this.state = emptyInternetDataState();
    }
    return this.state;
  }

  save(): void {
    if (!this.stateFile) return;
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.stateFile);
  }

  private mutate(): InternetDataState {
    this.load();
    return this.state;
  }

  listFeeds(): InternetFeed[] {
    return [...this.mutate().feeds];
  }

  listWatches(): InternetWatch[] {
    return [...this.mutate().watches];
  }

  snapshot(): InternetDataState {
    const s = this.mutate();
    return { version: 1, feeds: [...s.feeds], watches: [...s.watches] };
  }

  addFeed(url: string, title: string, nowMs: number): { feed: InternetFeed; added: boolean } {
    const state = this.mutate();
    const id = internetIdForUrl(url);
    const existing = state.feeds.find((f) => f.id === id);
    if (existing) return { feed: existing, added: false };
    const feed: InternetFeed = { id, url, title, addedAt: nowMs };
    state.feeds.push(feed);
    if (state.feeds.length > INTERNET_MAX_FEEDS) state.feeds.splice(0, state.feeds.length - INTERNET_MAX_FEEDS);
    this.save();
    return { feed, added: true };
  }

  removeFeed(idOrUrl: string): boolean {
    const state = this.mutate();
    const id = idOrUrl.startsWith('http') ? internetIdForUrl(idOrUrl) : idOrUrl;
    const before = state.feeds.length;
    state.feeds = state.feeds.filter((f) => f.id !== id);
    if (state.feeds.length === before) return false;
    this.save();
    return true;
  }

  findFeed(idOrUrl: string): InternetFeed | undefined {
    const state = this.mutate();
    const id = idOrUrl.startsWith('http') ? internetIdForUrl(idOrUrl) : idOrUrl;
    return state.feeds.find((f) => f.id === id);
  }

  markFeedChecked(id: string, nowMs: number, itemCount: number): void {
    const state = this.mutate();
    const feed = state.feeds.find((f) => f.id === id);
    if (!feed) return;
    feed.lastCheckedAt = nowMs;
    feed.lastItemCount = itemCount;
    this.save();
  }

  addWatch(
    url: string,
    intervalMinutes: number,
    nowMs: number,
  ): { watch: InternetWatch; added: boolean } {
    const state = this.mutate();
    const id = internetIdForUrl(url);
    const existing = state.watches.find((w) => w.id === id);
    if (existing) {
      existing.intervalMinutes = intervalMinutes;
      this.save();
      return { watch: existing, added: false };
    }
    const watch: InternetWatch = { id, url, intervalMinutes, lastCheckedAt: undefined };
    state.watches.push(watch);
    if (state.watches.length > INTERNET_MAX_WATCHES) {
      state.watches.splice(0, state.watches.length - INTERNET_MAX_WATCHES);
    }
    this.save();
    return { watch, added: true };
  }

  removeWatch(idOrUrl: string): boolean {
    const state = this.mutate();
    const id = idOrUrl.startsWith('http') ? internetIdForUrl(idOrUrl) : idOrUrl;
    const before = state.watches.length;
    state.watches = state.watches.filter((w) => w.id !== id);
    if (state.watches.length === before) return false;
    this.save();
    return true;
  }

  findWatch(idOrUrl: string): InternetWatch | undefined {
    const state = this.mutate();
    const id = idOrUrl.startsWith('http') ? internetIdForUrl(idOrUrl) : idOrUrl;
    return state.watches.find((w) => w.id === id);
  }

  updateWatch(id: string, patch: Partial<InternetWatch>): void {
    const state = this.mutate();
    const watch = state.watches.find((w) => w.id === id);
    if (!watch) return;
    Object.assign(watch, patch);
    this.save();
  }
}

// ---------------------------------------------------------------------------
// Feed reading (shared by the tool and the desktop main process)
// ---------------------------------------------------------------------------

export interface FeedReadResult {
  feed: InternetFeed;
  parsed: ParsedFeed;
}

/** Fetch + parse one feed URL (validates it is really a feed). */
export async function fetchFeed(
  url: string,
  opts: InternetDataOptions = {},
): Promise<ParsedFeed> {
  const doc = await fetchPublicDocument(url, opts, {
    headers: { 'User-Agent': BROWSER_USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
  });
  if (doc.status < 200 || doc.status >= 300) {
    throw new Error(`GET ${doc.url} failed with HTTP ${doc.status}`);
  }
  const parsed = parseFeedXml(doc.text);
  if (parsed.items.length === 0) {
    throw new Error(`URL does not look like an RSS/Atom feed (no items found): ${doc.url}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Watch polling + diff summary
// ---------------------------------------------------------------------------

export interface WatchChangeEvent {
  watch: InternetWatch;
  changed: boolean;
  summary: string;
  addedLines: string[];
  removedLines: string[];
  checkedAt: number;
}

export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const MAX_DIFF_LINES_SHOWN = 5;

/** Line-set diff summary: which lines appeared / disappeared. */
export function summarizeTextDiff(oldText: string, newText: string): {
  summary: string;
  addedLines: string[];
  removedLines: string[];
} {
  const oldLines = new Set(oldText.split('\n').map((l) => l.trim()).filter(Boolean));
  const newLines = new Set(newText.split('\n').map((l) => l.trim()).filter(Boolean));
  const addedLines = [...newLines].filter((l) => !oldLines.has(l)).slice(0, MAX_DIFF_LINES_SHOWN);
  const removedLines = [...oldLines].filter((l) => !newLines.has(l)).slice(0, MAX_DIFF_LINES_SHOWN);
  const parts: string[] = [];
  if (addedLines.length > 0) parts.push(`+ ${addedLines.length} new line(s): ${addedLines.map((l) => `"${l.slice(0, 120)}"`).join('; ')}`);
  if (removedLines.length > 0) parts.push(`- ${removedLines.length} removed line(s): ${removedLines.map((l) => `"${l.slice(0, 120)}"`).join('; ')}`);
  const summary = parts.length > 0 ? parts.join('\n') : 'Content changed (no line-level diff).';
  return { summary, addedLines, removedLines };
}

/**
 * Check due watches: fetch each due watch, hash the extracted text,
 * compare with the stored hash. The first check of a watch only
 * records the baseline (no change event). Returns one event per
 * watch actually checked; `onWatchChanged` fires for real changes.
 * `onlyId` limits the run to one watch (which is checked even when
 * its interval has not elapsed — a manual "check now").
 */
export async function checkWatches(
  store: InternetDataStore,
  opts: InternetDataOptions = {},
  onlyId?: string,
): Promise<WatchChangeEvent[]> {
  const nowMs = opts.now?.() ?? Date.now();
  const watches = onlyId
    ? store.listWatches().filter((w) => w.id === onlyId)
    : store.listWatches();
  const events: WatchChangeEvent[] = [];
  for (const watch of watches) {
    const due =
      onlyId !== undefined ||
      watch.lastCheckedAt === undefined ||
      nowMs - watch.lastCheckedAt >= watch.intervalMinutes * 60_000;
    if (!due) continue;
    try {
      const text = await doWebFetchClean({ url: watch.url }, opts);
      if (text.startsWith('Error:')) {
        store.updateWatch(watch.id, { lastCheckedAt: nowMs, lastError: text.slice(0, 200) });
        events.push({ watch, changed: false, summary: text, addedLines: [], removedLines: [], checkedAt: nowMs });
        continue;
      }
      const body = text.replace(/^Fetched .*?:\n/, '');
      const hash = hashContent(body);
      if (watch.lastHash === undefined) {
        // First check: record the baseline hash AND the first lines
        // of the text, so the next change can diff against them.
        store.updateWatch(watch.id, {
          lastHash: hash,
          lastCheckedAt: nowMs,
          lastSummary: body.split('\n').slice(0, 40).join('\n'),
          lastError: undefined,
        });
        events.push({ watch, changed: false, summary: 'Baseline recorded (first check — no previous content to compare).', addedLines: [], removedLines: [], checkedAt: nowMs });
        continue;
      }
      if (hash === watch.lastHash) {
        store.updateWatch(watch.id, { lastCheckedAt: nowMs, lastError: undefined });
        events.push({ watch, changed: false, summary: 'No change.', addedLines: [], removedLines: [], checkedAt: nowMs });
        continue;
      }
      // The store keeps the last fetch's first lines (see the
      // baseline branch above) so the diff can compare old vs new
      // text even though only the hash is stored long-term.
      const oldText = watch.lastSummary ?? '';
      const diff = summarizeTextDiff(oldText, body);
      store.updateWatch(watch.id, {
        lastHash: hash,
        lastCheckedAt: nowMs,
        lastChangedAt: nowMs,
        lastSummary: body.split('\n').slice(0, 40).join('\n'),
        lastError: undefined,
      });
      const event: WatchChangeEvent = {
        watch: { ...watch, lastHash: hash, lastCheckedAt: nowMs, lastChangedAt: nowMs },
        changed: true,
        summary: diff.summary,
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        checkedAt: nowMs,
      };
      events.push(event);
      opts.onWatchChanged?.(event);
    } catch (err) {
      const message = (err as Error).message.slice(0, 200);
      store.updateWatch(watch.id, { lastCheckedAt: nowMs, lastError: message });
      events.push({ watch, changed: false, summary: `Error: ${message}`, addedLines: [], removedLines: [], checkedAt: nowMs });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function formatFeedList(feeds: InternetFeed[]): string {
  if (feeds.length === 0) return 'No feeds subscribed yet. Use feed_subscribe with an RSS/Atom feed URL.';
  const lines = feeds.map((f, i) => {
    const checked = f.lastCheckedAt ? `, last checked ${new Date(f.lastCheckedAt).toISOString()}` : ', never checked';
    const count = f.lastItemCount !== undefined ? `, ${f.lastItemCount} item(s)` : '';
    return `${i + 1}. ${f.title} — ${f.url} (id ${f.id}${checked}${count})`;
  });
  return `Subscribed feeds (${feeds.length}):\n${lines.join('\n')}`;
}

function formatWatchList(watches: InternetWatch[], nowMs: number): string {
  if (watches.length === 0) return 'No watched pages yet. Use watch_url with a page URL and an interval in minutes.';
  const lines = watches.map((w, i) => {
    const checked = w.lastCheckedAt ? `, last checked ${new Date(w.lastCheckedAt).toISOString()}` : ', never checked';
    const changed = w.lastChangedAt ? `, last changed ${new Date(w.lastChangedAt).toISOString()}` : '';
    const nextIn =
      w.lastCheckedAt === undefined
        ? 'due now'
        : `next check in ${Math.max(0, Math.round((w.lastCheckedAt + w.intervalMinutes * 60_000 - nowMs) / 60_000))} min`;
    const err = w.lastError ? `, last error: ${w.lastError}` : '';
    return `${i + 1}. ${w.url} — every ${w.intervalMinutes} min (id ${w.id}${checked}${changed}, ${nextIn}${err})`;
  });
  return `Watched pages (${watches.length}):\n${lines.join('\n')}`;
}

export function createInternetDataTools(opts: InternetDataOptions = {}): Tool[] {
  const store = new InternetDataStore(opts.stateFile);
  const now = () => opts.now?.() ?? Date.now();

  const internetSearchTool: Tool = {
    definition: {
      name: 'internet_search',
      description:
        'Search the internet across several free/public sources — Wikipedia API first, then DuckDuckGo lite/HTML (no API key). An explicit source can be chosen: auto (default), wikipedia, duckduckgo, or brave (Brave Search API, opt-in: needs a Brave key in the Vault, otherwise it explains how to add one). Returns up to 8 results (limit 1-20) with title, URL and snippet.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          source: { type: 'string', description: 'Source: auto (default), wikipedia, duckduckgo, brave.' },
          limit: { type: 'number', description: 'Max results (1-20, default 8).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        return await doInternetSearch(args, opts);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const webFetchCleanTool: Tool = {
    definition: {
      name: 'web_fetch_clean',
      description:
        'Fetch a public web page and return its clean readable text (title + headings + paragraphs, boilerplate like nav/header/footer/scripts removed; max 20,000 chars). Internal/private URLs (localhost, private LAN, cloud metadata) are blocked. For raw JSON/text APIs use http_get instead.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL to fetch.' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        return await doWebFetchClean(args, opts);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const feedSubscribeTool: Tool = {
    definition: {
      name: 'feed_subscribe',
      description:
        'Subscribe to an RSS/Atom feed (validated by fetching it once — the URL must actually return feed items). Subscriptions persist locally in <userData>/internet-data.json.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'RSS/Atom feed URL.' },
          title: { type: 'string', description: 'Optional display title (defaults to the feed title).' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const rawUrl = getStringArg(args, 'url');
        if (isValidHttpUrl(rawUrl) === null) return errorResult(`Invalid URL: "${rawUrl}"`);
        const parsed = await fetchFeed(rawUrl, opts);
        const title = getStringArg(args, 'title', false) || parsed.title || rawUrl;
        const { feed, added } = store.addFeed(rawUrl, title, now());
        store.markFeedChecked(feed.id, now(), parsed.items.length);
        return added
          ? `Subscribed to feed "${title}" (${rawUrl}) — ${parsed.items.length} item(s) in the feed.`
          : `Already subscribed to feed "${feed.title}" (${rawUrl}).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const feedListTool: Tool = {
    definition: {
      name: 'feed_list',
      description: 'List subscribed RSS/Atom feeds with their last-checked time and item count.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    needsApproval: false,
    async execute() {
      try {
        return formatFeedList(store.listFeeds());
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const feedReadTool: Tool = {
    definition: {
      name: 'feed_read',
      description:
        'Read the latest items of a subscribed RSS/Atom feed (by id or URL). Returns up to 10 items (limit 1-50) with title, link, publish date and summary.',
      parameters: {
        type: 'object',
        properties: {
          feed: { type: 'string', description: 'Feed id (from feed_list) or feed URL.' },
          limit: { type: 'number', description: 'Max items (1-50, default 10).' },
        },
        required: ['feed'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const key = getStringArg(args, 'feed');
        const feed = store.findFeed(key);
        if (!feed) return errorResult(`No subscribed feed matches "${key}". Use feed_list to see subscriptions.`);
        const parsed = await fetchFeed(feed.url, opts);
        store.markFeedChecked(feed.id, now(), parsed.items.length);
        const limitRaw = getNumberArg(args, 'limit');
        const limit = limitRaw === undefined ? 10 : Math.max(1, Math.min(INTERNET_FEED_MAX_ITEMS, Math.floor(limitRaw)));
        const items = parsed.items.slice(0, limit);
        const lines = items.map((it, i) => {
          const date = it.published ? ` (${it.published})` : '';
          const summary = it.summary ? `\n  ${it.summary.slice(0, 300)}` : '';
          return `${i + 1}. ${it.title}${date}\n   ${it.link}${summary}`;
        });
        return truncate(
          `Feed "${parsed.title || feed.title}" — ${items.length} of ${parsed.items.length} item(s):\n${lines.join('\n')}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const feedUnsubscribeTool: Tool = {
    definition: {
      name: 'feed_unsubscribe',
      description: 'Unsubscribe from an RSS/Atom feed (by id or URL).',
      parameters: {
        type: 'object',
        properties: {
          feed: { type: 'string', description: 'Feed id (from feed_list) or feed URL.' },
        },
        required: ['feed'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const key = getStringArg(args, 'feed');
        return store.removeFeed(key)
          ? `Unsubscribed from feed "${key}".`
          : errorResult(`No subscribed feed matches "${key}". Use feed_list to see subscriptions.`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const watchUrlTool: Tool = {
    definition: {
      name: 'watch_url',
      description:
        'Watch a web page for changes: polls it every intervalMinutes (5-1440, default 60) when watch_check runs, hashes the extracted readable text, and reports a line-level diff summary when it changes. The first check only records a baseline. Changes fire the watch-change notification (when wired by the host).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL of the page to watch.' },
          intervalMinutes: { type: 'number', description: 'Poll interval in minutes (5-1440, default 60).' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const rawUrl = getStringArg(args, 'url');
        if (isValidHttpUrl(rawUrl) === null) return errorResult(`Invalid URL: "${rawUrl}"`);
        const intervalRaw = getNumberArg(args, 'intervalMinutes');
        const interval =
          intervalRaw === undefined
            ? WATCH_DEFAULT_INTERVAL_MINUTES
            : Math.max(WATCH_MIN_INTERVAL_MINUTES, Math.min(WATCH_MAX_INTERVAL_MINUTES, Math.floor(intervalRaw)));
        const { watch, added } = store.addWatch(rawUrl, interval, now());
        return added
          ? `Watching ${rawUrl} every ${interval} min (id ${watch.id}). First check records a baseline; later checks report changes.`
          : `Already watching ${rawUrl} — interval updated to every ${interval} min (id ${watch.id}).`;
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const watchListTool: Tool = {
    definition: {
      name: 'watch_list',
      description: 'List watched pages with interval, last-checked / last-changed times and next check.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
    needsApproval: false,
    async execute() {
      try {
        return formatWatchList(store.listWatches(), now());
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const watchCheckTool: Tool = {
    definition: {
      name: 'watch_check',
      description:
        'Check watched pages now: fetches each due watch (or one watch by id/URL) and reports which pages changed, with a diff summary per change. A watch whose interval has not elapsed is skipped unless given explicitly.',
      parameters: {
        type: 'object',
        properties: {
          watch: { type: 'string', description: 'Optional single watch id or URL to check now.' },
        },
        required: [],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const key = args['watch'] === undefined ? undefined : getStringArg(args, 'watch', false);
        let onlyId: string | undefined;
        if (key) {
          const found = store.findWatch(key);
          if (!found) return errorResult(`No watched page matches "${key}". Use watch_list to see watches.`);
          onlyId = found.id;
        }
        const events = await checkWatches(store, opts, onlyId);
        if (events.length === 0) return 'No watches due for a check right now.';
        const lines = events.map((e) => {
          const status = e.summary.startsWith('Error:')
            ? e.summary
            : e.changed
              ? `CHANGED:\n${e.summary}`
              : e.summary;
          return `- ${e.watch.url}: ${status}`;
        });
        const changed = events.filter((e) => e.changed).length;
        return truncate(
          `Checked ${events.length} watch(es), ${changed} changed:\n${lines.join('\n')}`,
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const watchRemoveTool: Tool = {
    definition: {
      name: 'watch_remove',
      description: 'Stop watching a page (by id or URL).',
      parameters: {
        type: 'object',
        properties: {
          watch: { type: 'string', description: 'Watch id (from watch_list) or URL.' },
        },
        required: ['watch'],
        additionalProperties: false,
      },
    },
    needsApproval: false,
    async execute(args) {
      try {
        const key = getStringArg(args, 'watch');
        return store.removeWatch(key)
          ? `Stopped watching "${key}".`
          : errorResult(`No watched page matches "${key}". Use watch_list to see watches.`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    internetSearchTool,
    webFetchCleanTool,
    feedSubscribeTool,
    feedListTool,
    feedReadTool,
    feedUnsubscribeTool,
    watchUrlTool,
    watchListTool,
    watchCheckTool,
    watchRemoveTool,
  ];
}

export const INTERNET_DATA_TOOLS: Tool[] = createInternetDataTools();
