/**
 * 1Password broker WORKER — runs as a SEPARATE process (v0.53, P1-6).
 *
 * Spawned by `OnePasswordBroker` (main process) as
 * `node onepassword-broker-worker.js`. Talks NDJSON-RPC over stdio:
 *   Request:  {"id": string, "method": string, "params": object}
 *   Response: {"id": string, "result": any}
 *             | {"id": string, "error": {"message": string, "code"?: string}}
 *
 * This is the ONLY process that ever invokes the `op` CLI, and the
 * only process whose memory ever holds a 1Password item value. It
 * never logs a value, never echoes `op` stdout/stderr into errors
 * (stderr may name accounts; error messages stay generic), and it
 * exits when stdin closes.
 *
 * Methods:
 *   status     — `op` presence + sign-in state (never throws for
 *                "CLI not installed": returns available:false).
 *   list-items — item metadata only (id/title/category, no values).
 *   get-field  — the value of ONE field of one item.
 *
 * No real 1Password account is needed to build/test this: the tests
 * put a fake `op` script on PATH. The broker never stores, caches or
 * forwards credentials of its own.
 */
import { execFile } from 'node:child_process';
import * as readline from 'node:readline';

/** Per-`op`-call timeout (below the broker's 15s wire timeout). */
const OP_TIMEOUT_MS = 10_000;

const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface OpAccount {
  shorthand?: string;
  url?: string;
}

interface OpItem {
  id?: string;
  title?: string;
  category?: string;
}

interface OpField {
  id?: string;
  label?: string;
  type?: string;
  value?: string;
}

interface OpItemDetail extends OpItem {
  fields?: OpField[];
}

/** Run `op` with args. Rejects with a GENERIC message (no op output). */
function runOp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('op', args, { timeout: OP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const code = typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : -1;
        const killed = (err as { killed?: boolean }).killed === true;
        reject(
          new Error(
            killed
              ? `1Password CLI timed out after ${OP_TIMEOUT_MS}ms.`
              : `1Password CLI failed (exit code ${code}).`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

function parseJsonArray<T>(text: string): T[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('1Password CLI returned an unexpected shape.');
  return parsed as T[];
}

async function handleStatus(): Promise<Record<string, unknown>> {
  let cliVersion: string | undefined;
  try {
    cliVersion = (await runOp(['--version'])).trim();
  } catch {
    return {
      state: 'unavailable',
      available: false,
      signedIn: false,
      accounts: [],
      reason: '1Password CLI (op) is not installed on this machine.',
    };
  }
  let accounts: string[] = [];
  try {
    const list = parseJsonArray<OpAccount>(await runOp(['account', 'list', '--format', 'json']));
    accounts = list
      .map((a) => (typeof a.shorthand === 'string' ? a.shorthand : ''))
      .filter((s) => s !== '');
  } catch {
    // `op account list` fails when no account is signed in (or the
    // session expired) — that is a state, not an error.
    return {
      state: 'signed-out',
      available: true,
      signedIn: false,
      ...(cliVersion ? { cliVersion } : {}),
      accounts: [],
      reason: 'No 1Password account is signed in via the op CLI.',
    };
  }
  if (accounts.length === 0) {
    return {
      state: 'signed-out',
      available: true,
      signedIn: false,
      ...(cliVersion ? { cliVersion } : {}),
      accounts: [],
      reason: 'No 1Password account is signed in via the op CLI.',
    };
  }
  return {
    state: 'signed-in',
    available: true,
    signedIn: true,
    ...(cliVersion ? { cliVersion } : {}),
    accounts,
  };
}

async function handleListItems(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const vaultId = params['vaultId'];
  if (vaultId !== undefined && (typeof vaultId !== 'string' || !ITEM_ID_RE.test(vaultId))) {
    throw new Error('Invalid vault id.');
  }
  const args = ['item', 'list', '--format', 'json'];
  if (typeof vaultId === 'string') args.push('--vault', vaultId);
  const items = parseJsonArray<OpItem>(await runOp(args));
  return {
    items: items.map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      title: typeof item.title === 'string' ? item.title : '',
      category: typeof item.category === 'string' ? item.category : '',
    })),
  };
}

async function handleGetField(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const itemId = params['itemId'];
  const field = params['field'];
  if (typeof itemId !== 'string' || !ITEM_ID_RE.test(itemId)) {
    throw new Error('Invalid item id.');
  }
  if (typeof field !== 'string' || field.trim() === '' || field.length > 200) {
    throw new Error('Invalid field name.');
  }
  const detail: OpItemDetail = JSON.parse(
    await runOp(['item', 'get', itemId, '--format', 'json']),
  ) as OpItemDetail;
  const fields = Array.isArray(detail.fields) ? detail.fields : [];
  const wanted = field.trim().toLowerCase();
  // Exact label/id match first; `password` also matches the first
  // PASSWORD-type field (the usual case for API keys stored as
  // password items).
  let match =
    fields.find(
      (f) =>
        (typeof f.label === 'string' && f.label.toLowerCase() === wanted) ||
        (typeof f.id === 'string' && f.id.toLowerCase() === wanted),
    ) ?? undefined;
  if (!match && wanted === 'password') {
    match = fields.find(
      (f) =>
        (typeof f.type === 'string' && f.type.toUpperCase() === 'PASSWORD') ||
        (typeof f.label === 'string' && f.label.toLowerCase() === 'password'),
    );
  }
  if (!match || typeof match.value !== 'string') {
    throw new Error('1Password item has no such field.');
  }
  return { value: match.value };
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (method) {
    case 'status':
      return handleStatus();
    case 'list-items':
      return handleListItems(params);
    case 'get-field':
      return handleGetField(params);
    default:
      throw new Error(`Unknown 1Password broker method: ${method}`);
  }
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    void (async () => {
      let req: { id?: unknown; method?: unknown; params?: unknown };
      try {
        req = JSON.parse(line) as typeof req;
      } catch {
        return; // Malformed line — never a valid request; ignore.
      }
      if (typeof req.id !== 'string' || typeof req.method !== 'string') return;
      const params =
        req.params !== undefined && typeof req.params === 'object' && req.params !== null
          ? (req.params as Record<string, unknown>)
          : {};
      try {
        const result = await dispatch(req.method, params);
        process.stdout.write(`${JSON.stringify({ id: req.id, result })}\n`);
      } catch (err) {
        // Generic message only — never include `op` output (it may
        // name accounts; values must never appear here).
        process.stdout.write(
          `${JSON.stringify({
            id: req.id,
            error: { message: err instanceof Error ? err.message : '1Password broker error.' },
          })}\n`,
        );
      }
    })();
  });
  rl.on('close', () => process.exit(0));
}

main();
