/**
 * UI-1 + UI-2 tests (v0.59).
 *
 * UI-1 — safe Markdown in chat (no Electron needed):
 *   - the parser (apps/desktop/src/renderer/components/markdown.ts) turns
 *     Markdown into a plain AST: headings, bold/italic, inline code,
 *     fenced code blocks, lists, tables, blockquotes, links, images.
 *   - raw HTML (`<script>`, `<img onerror=...>`) never becomes a node
 *     that could execute: it degrades to literal text, unsafe link/image
 *     schemes (`javascript:`, `data:`, ...) degrade to visible text.
 *   - the code highlighter only splits text into spans; it never parses
 *     HTML, so `<div>` inside code stays literal text.
 *
 * UI-2 — Stop button wiring (static contract + a real coordinator run):
 *   - IPC `chat:stop` exists in main/preload/global.d.ts and maps to
 *     coordinator.stopBot; `chat:send` returns `stopped` so the renderer
 *     can show the stopped state.
 *   - ChatView renders assistant messages with <Markdown> and offers a
 *     Stop button while a run is in flight; App settles the run with
 *     stopped:true and marks open tool cards stopped.
 *   - Behaviour: stop a run in the middle of a tool call (shell `sleep`)
 *     — the run promise must resolve with stopped:true promptly (not
 *     wait out the sleep, not hang), and the bot must run again right
 *     after (no stuck `running` state — the v0.37 regression shape).
 *
 * Run: node --test tests/ui-markdown-stop-v059.test.mjs
 * (the coordinator part needs packages/core/dist built, like the other
 * coordinator tests; no network, no API key, no Electron.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  highlightCode,
  isSafeImageUrl,
  isSafeLinkUrl,
  parseMarkdown,
} from '../apps/desktop/src/renderer/components/markdown.ts';
import { CoordinatorClient } from '../packages/core/dist/coordinator/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const renderer = path.join(repo, 'apps/desktop/src/renderer');
const read = (p) => fs.readFileSync(p, 'utf-8');

/** Every node in an AST (blocks + inline children), depth-first. */
function allNodes(blocks) {
  const out = [];
  const walkInline = (nodes) => {
    for (const n of nodes ?? []) {
      out.push(n);
      if (n.children) walkInline(n.children);
    }
  };
  const walkBlocks = (list) => {
    for (const b of list ?? []) {
      out.push(b);
      if (b.children) {
        if (b.kind === 'blockquote') walkBlocks(b.children);
        else walkInline(b.children);
      }
      if (b.kind === 'list') for (const item of b.items) walkBlocks(item);
      if (b.kind === 'table') {
        for (const cell of b.header) walkInline(cell);
        for (const row of b.rows) for (const cell of row) walkInline(cell);
      }
    }
  };
  walkBlocks(blocks);
  return out;
}

function inlineText(nodes) {
  return (nodes ?? [])
    .map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : inlineText(n.children)))
    .join('');
}

// ---------------------------------------------------------------------------
// UI-1: Markdown parsing
// ---------------------------------------------------------------------------

test('UI-1: heading + bold/italic/inline code render as AST nodes', () => {
  const blocks = parseMarkdown('# Title\n\nSome **bold** and *italic* and `code`.\n');
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks[0].depth, 1);
  assert.equal(inlineText(blocks[0].children), 'Title');
  const para = blocks[1];
  assert.equal(para.kind, 'paragraph');
  const kinds = para.children.map((c) => c.kind);
  assert.ok(kinds.includes('strong'), 'bold must survive');
  assert.ok(kinds.includes('em'), 'italic must survive');
  assert.ok(kinds.includes('code'), 'inline code must survive');
  assert.equal(para.children.find((c) => c.kind === 'code').text, 'code');
});

test('UI-1: fenced code block keeps language + raw text', () => {
  const blocks = parseMarkdown('```ts\nconst x = 1;\n```\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  assert.equal(blocks[0].lang, 'ts');
  assert.equal(blocks[0].text, 'const x = 1;');
});

test('UI-1: unordered + ordered lists, ordered start number kept', () => {
  const blocks = parseMarkdown('- a\n- b\n\n3. third\n4. fourth\n');
  assert.equal(blocks[0].kind, 'list');
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].kind, 'list');
  assert.equal(blocks[1].ordered, true);
  assert.equal(blocks[1].start, 3);
  assert.equal(inlineText(blocks[1].items[0][0].children), 'third');
});

test('UI-1: table keeps header, rows and alignment', () => {
  const blocks = parseMarkdown('| A | B |\n|---|:---:|\n| 1 | 2 |\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.deepEqual(
    blocks[0].header.map((c) => inlineText(c)),
    ['A', 'B'],
  );
  assert.deepEqual(
    blocks[0].rows[0].map((c) => inlineText(c)),
    ['1', '2'],
  );
  assert.deepEqual(blocks[0].align, [null, 'center']);
});

test('UI-1: blockquote + hr', () => {
  const blocks = parseMarkdown('> quoted\n\n---\n');
  assert.equal(blocks[0].kind, 'blockquote');
  assert.equal(blocks[1].kind, 'hr');
});

test('UI-1: safe link kept, unsafe schemes degrade to visible text', () => {
  const blocks = parseMarkdown(
    '[ok](https://example.com) [bad](javascript:alert(1)) [data](data:text/html,<script>) [mail](mailto:a@b.c) [rel](/etc/passwd)\n',
  );
  const nodes = allNodes(blocks);
  const links = nodes.filter((n) => n.kind === 'link');
  assert.equal(links.length, 2, 'only https + mailto become links');
  assert.equal(links[0].href, 'https://example.com');
  assert.equal(links[1].href, 'mailto:a@b.c');
  assert.ok(!nodes.some((n) => (n.href ?? '').startsWith('javascript:')), 'no javascript: href');
  assert.ok(!nodes.some((n) => (n.href ?? '').startsWith('data:')), 'no data: href');
  assert.ok(inlineText(blocks[0].children).includes('bad'), 'unsafe link text stays visible');
});

test('UI-1: safe image kept, unsafe image degrades to alt text', () => {
  const blocks = parseMarkdown(
    '![pic](https://x.test/a.png) ![evil](javascript:alert(1))\n',
  );
  const nodes = allNodes(blocks);
  const images = nodes.filter((n) => n.kind === 'image');
  assert.equal(images.length, 1);
  assert.equal(images[0].src, 'https://x.test/a.png');
  assert.equal(images[0].alt, 'pic');
  assert.ok(inlineText(blocks[0].children).includes('evil'), 'unsafe image alt stays visible');
});

test('UI-1: XSS — <script> and <img onerror> become literal text, never a node', () => {
  const blocks = parseMarkdown(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nHello <b>world</b>\n',
  );
  const nodes = allNodes(blocks);
  assert.ok(!nodes.some((n) => n.kind === 'html'), 'no raw-HTML node in the AST');
  assert.ok(
    !nodes.some((n) => n.kind === 'image' || (typeof n.href === 'string' && n.href !== '' && !isSafeLinkUrl(n.href))),
    'no executable URL in the AST',
  );
  const text = nodes
    .filter((n) => n.kind === 'text')
    .map((n) => n.text)
    .join('');
  assert.ok(text.includes('<script>'), 'script tag survives only as visible text');
  assert.ok(text.includes('onerror'), 'onerror handler survives only as visible text');
});

test('UI-1: URL helpers reject dangerous schemes', () => {
  assert.equal(isSafeLinkUrl('https://example.com'), true);
  assert.equal(isSafeLinkUrl('HTTP://EXAMPLE.COM'), true);
  assert.equal(isSafeLinkUrl('mailto:a@b.c'), true);
  assert.equal(isSafeLinkUrl('javascript:alert(1)'), false);
  assert.equal(isSafeLinkUrl('JaVaScRiPt:alert(1)'), false);
  assert.equal(isSafeLinkUrl('data:text/html,<script>'), false);
  assert.equal(isSafeLinkUrl('vbscript:msgbox'), false);
  assert.equal(isSafeLinkUrl('//evil.test/x'), false);
  assert.equal(isSafeLinkUrl('/etc/passwd'), false);
  assert.equal(isSafeLinkUrl(''), false);
  assert.equal(isSafeLinkUrl('https://x.test/a\njavascript:1'), false);
  assert.equal(isSafeImageUrl('https://x.test/a.png'), true);
  assert.equal(isSafeImageUrl('data:image/png;base64,AAA'), false);
  assert.equal(isSafeImageUrl('javascript:alert(1)'), false);
});

test('UI-1: code highlight splits keyword/string/comment/number, keeps raw text', () => {
  const code = 'const s = "hi"; // note\nconst n = 42;\n';
  const spans = highlightCode(code);
  const byText = (t) => spans.find((s) => s.text === t);
  assert.equal(byText('const').cls, 'kw');
  assert.equal(byText('"hi"').cls, 'str');
  assert.equal(byText('// note').cls, 'com');
  assert.equal(byText('42').cls, 'num');
  assert.equal(spans.map((s) => s.text).join(''), code, 'spans must rejoin to the original code');
  // HTML-looking code stays literal text: no span boundary can turn it
  // into markup (the renderer puts spans in React text nodes).
  const evil = highlightCode('const x = "<script>alert(1)</script>";');
  assert.equal(evil.map((s) => s.text).join(''), 'const x = "<script>alert(1)</script>";');
  assert.ok(evil.some((s) => s.text.includes('<script>')));
});

test('UI-1: empty input parses to nothing; weird input never throws', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   \n  '), []);
  assert.ok(Array.isArray(parseMarkdown('```unclosed\nconst x = 1;\n')));
});

// ---------------------------------------------------------------------------
// UI-1 + UI-2: i18n keys for the new strings
// ---------------------------------------------------------------------------

test('UI-1/UI-2: new chat keys exist in vi + en, non-empty, same placeholders', () => {
  const vi = JSON.parse(read(path.join(renderer, 'i18n/locales/vi.json')));
  const en = JSON.parse(read(path.join(renderer, 'i18n/locales/en.json')));
  for (const key of ['chat.stop', 'chat.stopping', 'chat.runStopped', 'chat.stopFailed', 'chat.toolStopped']) {
    assert.equal(typeof vi[key], 'string', `vi.${key} missing`);
    assert.equal(typeof en[key], 'string', `en.${key} missing`);
    assert.ok(vi[key].trim().length > 0, `vi.${key} empty`);
    assert.ok(en[key].trim().length > 0, `en.${key} empty`);
  }
  assert.equal(vi['chat.stop'], 'Dừng');
  assert.equal(en['chat.stop'], 'Stop');
});

// ---------------------------------------------------------------------------
// UI-2: static wiring (renderer <-> main <-> coordinator)
// ---------------------------------------------------------------------------

test('UI-2: chat:stop IPC exists and maps to coordinator.stopBot; chat:send returns stopped', () => {
  const main = read(path.join(repo, 'apps/desktop/src/main/main.ts'));
  assert.match(main, /ipcMain\.handle\('chat:stop'/, 'main must handle chat:stop');
  assert.match(main, /return getCoordinator\(\)\.stopBot\(botId\)/, 'chat:stop must call stopBot');
  assert.match(main, /stopped = result\.stopped === true/, 'chat:send must read stopped from the run result');
  assert.match(main, /return \{ ok: true, text: replyText, stopped \}/, 'chat:send must return stopped');

  const preload = read(path.join(repo, 'apps/desktop/src/main/preload.ts'));
  assert.match(preload, /stopChat: \(botId\) => ipcRenderer\.invoke\('chat:stop'/, 'preload must bridge stopChat');
  assert.match(preload, /sendChat:.*stopped\?: boolean/, 'preload sendChat type must carry stopped');

  const globalDts = read(path.join(renderer, 'global.d.ts'));
  assert.match(globalDts, /stopChat\(botId: string\): Promise<\{ botId: string; stopped: boolean/, 'global.d.ts must declare stopChat');
});

test('UI-2: ChatView renders Markdown for assistant messages and offers Stop while running', () => {
  const chatView = read(path.join(renderer, 'components/ChatView.tsx'));
  assert.ok(chatView.includes('<Markdown text={m.text}'), 'assistant messages must render Markdown');
  assert.ok(chatView.includes('data-testid="stop-run-button"'), 'Stop button must exist');
  assert.ok(chatView.includes("t('chat.stop')"), 'Stop label must be i18n');
  assert.ok(chatView.includes("t('chat.stopping')"), 'Stopping label must be i18n');
  assert.ok(chatView.includes("t('chat.toolStopped')"), 'stopped tool cards must be labelled');
  assert.ok(chatView.includes('onStop'), 'ChatView must take an onStop prop');
  assert.match(chatView, /status !== 'idle' && onStop/, 'Stop only shows while a run is in flight');

  const app = read(path.join(renderer, 'App.tsx'));
  assert.ok(app.includes('window.openBot.stopChat(botId)'), 'App must call stopChat');
  assert.ok(app.includes('if (res.stopped)'), 'App must handle the stopped sendChat result');
  assert.ok(app.includes("t('chat.runStopped')"), 'App must show the stopped state');
  assert.ok(app.includes('onStop={() => void stopCurrentRun()}'), 'App must wire onStop into ChatView');
  assert.ok(app.includes('stopped: true'), 'open tool cards must be marked stopped');
});

test('UI-1: no dangerouslySetInnerHTML anywhere in the renderer', () => {
  const files = [path.join(renderer, 'App.tsx'), path.join(renderer, 'main.tsx')];
  for (const f of fs.readdirSync(path.join(renderer, 'components'))) {
    if (f.endsWith('.tsx')) files.push(path.join(renderer, 'components', f));
  }
  for (const f of files) {
    assert.ok(!read(f).includes('dangerouslySetInnerHTML'), `${f} must not use dangerouslySetInnerHTML`);
  }
});

// ---------------------------------------------------------------------------
// UI-2: behaviour — stop mid-tool-call, run ends cleanly, bot runs again
// ---------------------------------------------------------------------------

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-ui2-stop-'));
}

test('UI-2: stop mid-tool-call ends the run promptly and the bot runs again', async () => {
  const client = new CoordinatorClient();
  const ws = tmpWorkspace();
  try {
    assert.equal((await client.ping()).pong, true);
    await client.createBot({
      bot: {
        id: 'bot-ui2-stop',
        name: 'Bot UI2',
        providerId: 'mock',
        model: 'mock',
        systemPrompt: 'You are a test bot.',
        workspaceDir: ws,
        autoApprove: true,
      },
      provider: {
        id: 'mock',
        label: 'Mock',
        mockResponses: [
          { text: '', toolCalls: [{ id: 'c1', name: 'shell_exec', args: { command: 'sleep 10' } }] },
          { text: 'done after stop' },
        ],
      },
    });

    const events = [];
    const runPromise = client.run('bot-ui2-stop', 'sleep please', (e) => events.push(e));
    // Wait until the tool call actually started (or the run ends first).
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (events.some((e) => e.kind === 'toolcall')) break;
      if (events.some((e) => e.kind === 'toolresult')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      events.some((e) => e.kind === 'toolcall'),
      `run must reach a tool call before stopping (saw: ${events.map((e) => e.kind).join(',') || 'none'})`,
    );

    const stopAt = Date.now();
    const stopped = await client.stopBot('bot-ui2-stop');
    assert.equal(stopped.stopped, true, 'stopBot must report stopped:true mid-tool-call');
    const result = await Promise.race([
      runPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('run did not settle within 20s after stop (stuck running)')), 20000),
      ),
    ]);
    const settleMs = Date.now() - stopAt;
    assert.equal(result.stopped, true, 'stopped run must report stopped:true');
    assert.ok(
      settleMs < 8000,
      `run must settle promptly after stop, not wait out the 10s sleep (took ${settleMs}ms)`,
    );

    // The bot is not stuck: the next run works right away.
    const again = await client.run('bot-ui2-stop', 'hello again');
    assert.equal(again.text, 'done after stop');
    assert.equal(again.stopped, false);
    await client.destroyBot('bot-ui2-stop');
  } finally {
    await client.dispose();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
