/**
 * Test v0.14 (worker W6f) — agent tools cho skill marketplace +
 * semantic_search mode embeddings.
 *
 * Chỉ dùng localhost (fake HTTP server 127.0.0.1), không gọi mạng ngoài,
 * không cần API key, không yêu cầu Ollama thật đang chạy.
 * Chạy sau khi build tools:
 *   npm run build --workspace=@open-bot/tools
 *   node --test tests/skill-marketplace-tools-v014.test.mjs
 *
 * Lưu ý: test import tool từ `packages/tools/dist/` (đã build), theo mẫu
 * của tests/tools-code.test.mjs.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { createSkillMarketplaceTools } from '../packages/tools/dist/skillMarketplaceTools.js';
import { CODE_TOOLS } from '../packages/tools/dist/codeTools.js';
import { loadSkillDir } from '../packages/core/dist/skills/index.js';

// ---------------------------------------------------------------------------
// Helpers: thư mục tạm, fake server, bộ viết ZIP tối thiểu (stored + deflate)
// ---------------------------------------------------------------------------

const tempDirs = [];
const servers = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-w6f-'));
  tempDirs.push(dir);
  return dir;
}
function makeTempWorkspace(files) {
  const dir = makeTempDir();
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}
afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    await new Promise((r) => s.close(r));
  }
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve({ server, port: server.address().port });
    });
  });
}

async function deadPort() {
  const { server, port } = await startServer(() => {});
  await new Promise((r) => server.close(r));
  servers.pop();
  return port;
}

// CRC32 (chuẩn, dùng cho ZIP).
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Viết file ZIP thật (entry stored hoặc deflate) từ danh sách { path, data, method? }. */
function makeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + comp.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, eocd]);
}

// ---------------------------------------------------------------------------
// Fixtures: skill hợp lệ / chứa secret (giá trị GIẢ, chỉ dùng cho test)
// ---------------------------------------------------------------------------

const VALID_SKILL_MD = `---\nname: demo-skill\ndescription: Skill demo de test marketplace.\nversion: 1.0.0\nallowed-tools: [read_file]\n---\n# Demo skill\nHuong dan demo.\n`;

// Khóa GIẢ dùng riêng cho test quét secret — không phải khóa thật.
const FAKE_SECRET_VALUE = 'sk-abcdefghij0123456789ABCDEF';

function validSkillZip() {
  return makeZip([
    { path: 'SKILL.md', data: VALID_SKILL_MD },
    { path: 'README.md', data: '# Demo skill\n\nREADME demo.\n' },
    { path: 'references/notes.md', data: 'Ghi chu tham khao, khong co secret.\n' },
  ]);
}

function secretSkillZip() {
  return makeZip([
    { path: 'SKILL.md', data: VALID_SKILL_MD },
    { path: 'references/notes.md', data: `Cau hinh mau:\napi_key = "${FAKE_SECRET_VALUE}"\n` },
  ]);
}

function skillServer() {
  return startServer((req, res) => {
    if (req.url === '/skill.zip') {
      const buf = validSkillZip();
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
      res.end(buf);
    } else if (req.url === '/secret.zip') {
      const buf = secretSkillZip();
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
      res.end(buf);
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
}

// Fake Ollama: /api/tags trả 200; /api/embeddings trả vector theo từ khoá
// trong prompt (mèo -> [1,0,0], chó -> [0,1,0], chim -> [0,0,1]).
function ollamaServer() {
  return startServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text' }] }));
      return;
    }
    if (req.url === '/api/embeddings' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const prompt = String(parsed.prompt ?? '');
        let vec = [0.33, 0.33, 0.33];
        if (/mèo/i.test(prompt)) vec = [1, 0, 0];
        else if (/chó/i.test(prompt)) vec = [0, 1, 0];
        else if (/chim/i.test(prompt)) vec = [0, 0, 1];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ embedding: vec }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

// ---------------------------------------------------------------------------
// Truy cập tool
// ---------------------------------------------------------------------------

const CTX = (workspaceDir) => ({ workspaceDir, botId: 'test-bot' });
const marketplaceTool = (name, getSkillsDir) => {
  const tools = createSkillMarketplaceTools(
    getSkillsDir ? { getSkillsDir } : {},
  );
  return tools.find((t) => t.definition.name === name);
};
const codeTool = (name) => CODE_TOOLS.find((t) => t.definition.name === name);

// ---------------------------------------------------------------------------
// skill_marketplace_preview / skill_marketplace_install
// ---------------------------------------------------------------------------

test('marketplace tools: factory trả đúng 2 tool, approval đúng (preview false, install true)', () => {
  const tools = createSkillMarketplaceTools({ getSkillsDir: () => '/tmp/skills' });
  assert.equal(tools.length, 2);
  const preview = tools.find((t) => t.definition.name === 'skill_marketplace_preview');
  const install = tools.find((t) => t.definition.name === 'skill_marketplace_install');
  assert.ok(preview, 'phải có skill_marketplace_preview');
  assert.ok(install, 'phải có skill_marketplace_install');
  assert.equal(preview.needsApproval, false);
  assert.equal(install.needsApproval, true);
});

test('skill_marketplace_preview: trả đúng tên/mô tả/danh sách file, không cài gì', async () => {
  const { port } = await skillServer();
  const skillsDir = path.join(makeTempDir(), 'skills');
  const out = await marketplaceTool('skill_marketplace_preview', () => skillsDir).execute(
    { url: `http://127.0.0.1:${port}/skill.zip` },
    CTX(makeTempDir()),
  );
  assert.match(out, /demo-skill/);
  assert.match(out, /Skill demo de test marketplace/);
  assert.match(out, /SKILL\.md \(\d+ byte\)/);
  assert.match(out, /README\.md \(\d+ byte\)/);
  assert.match(out, /references\/notes\.md \(\d+ byte\)/);
  assert.match(out, /không phát hiện secret/);
  assert.match(out, /Chưa cài gì cả/);
  assert.equal(fs.existsSync(skillsDir), false, 'preview không được tạo skillsDir');
});

test('skill_marketplace_install: cài vào thư mục tạm + đọc lại được manifest', async () => {
  const { port } = await skillServer();
  const skillsDir = path.join(makeTempDir(), 'skills');
  const out = await marketplaceTool('skill_marketplace_install', () => skillsDir).execute(
    { url: `http://127.0.0.1:${port}/skill.zip` },
    CTX(makeTempDir()),
  );
  const installedPath = path.join(skillsDir, 'demo-skill');
  assert.match(out, /Đã cài skill "demo-skill"/);
  assert.ok(out.includes(installedPath), `output phải chứa đường dẫn đã cài ${installedPath}`);
  assert.match(out, /Số file đã cài: 3/);
  assert.ok(fs.existsSync(path.join(installedPath, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(installedPath, 'references', 'notes.md')));
  const loaded = loadSkillDir(installedPath, 'user');
  assert.equal(loaded.name, 'demo-skill');
  assert.equal(loaded.description, 'Skill demo de test marketplace.');
});

test('skill marketplace: secret → dừng + không lộ giá trị (preview và install)', async () => {
  const { port } = await skillServer();
  const skillsDir = path.join(makeTempDir(), 'skills');
  const previewOut = await marketplaceTool('skill_marketplace_preview', () => skillsDir).execute(
    { url: `http://127.0.0.1:${port}/secret.zip` },
    CTX(makeTempDir()),
  );
  assert.match(previewOut, /^Error: /);
  assert.match(previewOut, /secret/i);
  assert.match(previewOut, /references\/notes\.md/);
  assert.ok(!previewOut.includes(FAKE_SECRET_VALUE), 'output preview KHÔNG được chứa giá trị secret');

  const installOut = await marketplaceTool('skill_marketplace_install', () => skillsDir).execute(
    { url: `http://127.0.0.1:${port}/secret.zip` },
    CTX(makeTempDir()),
  );
  assert.match(installOut, /^Error: /);
  assert.ok(!installOut.includes(FAKE_SECRET_VALUE), 'output install KHÔNG được chứa giá trị secret');
  assert.equal(
    fs.existsSync(path.join(skillsDir, 'demo-skill')),
    false,
    'skill chứa secret không được ghi vào máy',
  );
});

test('skill_marketplace_install: không có getSkillsDir → lỗi rõ ràng, không tự cài chỗ khác', async () => {
  const { port } = await skillServer();
  const out = await marketplaceTool('skill_marketplace_install', null).execute(
    { url: `http://127.0.0.1:${port}/skill.zip` },
    CTX(makeTempDir()),
  );
  assert.match(out, /^Error: /);
  assert.match(out, /skillsDir/);
  assert.match(out, /Chưa cấu hình thư mục skills/);
});

test('skill_marketplace_install: trùng tên không overwrite → lỗi rõ; overwrite: true → cài đè được', async () => {
  const { port } = await skillServer();
  const skillsDir = path.join(makeTempDir(), 'skills');
  const install = marketplaceTool('skill_marketplace_install', () => skillsDir);
  const first = await install.execute(
    { url: `http://127.0.0.1:${port}/skill.zip` },
    CTX(makeTempDir()),
  );
  assert.match(first, /Đã cài skill/);

  const dup = await install.execute(
    { url: `http://127.0.0.1:${port}/skill.zip` },
    CTX(makeTempDir()),
  );
  assert.match(dup, /^Error: /);
  assert.match(dup, /đã tồn tại/);

  const over = await install.execute(
    { url: `http://127.0.0.1:${port}/skill.zip`, overwrite: true },
    CTX(makeTempDir()),
  );
  assert.match(over, /Đã cài skill "demo-skill"/);
  assert.ok(fs.existsSync(path.join(skillsDir, 'demo-skill', 'SKILL.md')));
});

test('skill marketplace: URL không phải http(s) → lỗi rõ ràng tiếng Việt', async () => {
  const preview = marketplaceTool('skill_marketplace_preview', () => makeTempDir());
  const outPreview = await preview.execute(
    { url: 'ftp://example.com/skill.zip' },
    CTX(makeTempDir()),
  );
  assert.match(outPreview, /^Error: /);
  assert.match(outPreview, /Chỉ chấp nhận URL http\(s\)/);

  const install = marketplaceTool('skill_marketplace_install', () => makeTempDir());
  const outInstall = await install.execute(
    { url: 'file:///tmp/skill.zip' },
    CTX(makeTempDir()),
  );
  assert.match(outInstall, /^Error: /);
  assert.match(outInstall, /Chỉ chấp nhận URL http\(s\)/);
});

// ---------------------------------------------------------------------------
// semantic_search mode embeddings (+ TF-IDF mặc định giữ nguyên)
// ---------------------------------------------------------------------------

test('semantic_search embeddings: Ollama fake xếp hạng đúng (mèo trước chó/chim)', async () => {
  const { port } = await ollamaServer();
  const dir = makeTempWorkspace({
    'meo.md': 'Mèo con dễ thương đang chơi với cuộn len.\nMèo thích ngủ nắng buổi trưa.\n',
    'cho.md': 'Chó chạy ngoài sân và sủa vang.\nChó thích gặm xương.\n',
    'chim.md': 'Chim hót trên cành cây cao.\nChim bay về tổ lúc chiều.\n',
  });
  const out = await codeTool('semantic_search').execute(
    {
      query: 'mèo con dễ thương',
      mode: 'embeddings',
      ollama_base_url: `http://127.0.0.1:${port}`,
    },
    CTX(dir),
  );
  assert.match(out, /tìm kiếm ngữ nghĩa \(embeddings/);
  assert.match(out, /meo\.md \(score 1\.0000\)/);
  assert.ok(out.indexOf('meo.md') < out.indexOf('cho.md'), 'meo.md phải xếp trước cho.md');
  assert.ok(out.indexOf('meo.md') < out.indexOf('chim.md'), 'meo.md phải xếp trước chim.md');
  assert.match(out, /cuộn len/, 'dòng khớp phải chứa nội dung file mèo');
});

test('semantic_search embeddings: Ollama chết → lỗi rõ ràng tiếng Việt, KHÔNG fallback TF-IDF', async () => {
  const port = await deadPort();
  const dir = makeTempWorkspace({
    'meo.md': 'Mèo con dễ thương đang chơi với cuộn len.\n',
    'cho.md': 'Chó chạy ngoài sân và sủa vang.\n',
  });
  const out = await codeTool('semantic_search').execute(
    {
      query: 'mèo con dễ thương',
      mode: 'embeddings',
      ollama_base_url: `http://127.0.0.1:${port}`,
    },
    CTX(dir),
  );
  assert.match(out, /^Error: /);
  assert.match(out, /Ollama/);
  assert.match(out, /ollama serve/);
  assert.doesNotMatch(out, /Keyword-ranked \(TF-IDF\)/, 'không được lặng lẽ fallback về TF-IDF');
});

test('semantic_search embeddings: mode không hợp lệ → lỗi rõ ràng', async () => {
  const dir = makeTempWorkspace({ 'a.md': 'Mèo con dễ thương.\n' });
  const out = await codeTool('semantic_search').execute(
    { query: 'mèo', mode: 'vector' },
    CTX(dir),
  );
  assert.match(out, /^Error: /);
  assert.match(out, /mode không hợp lệ/);
});

test('semantic_search mặc định (không truyền mode) vẫn là TF-IDF như cũ', async () => {
  const dir = makeTempWorkspace({
    'db.md': 'database connection pooling improves database performance and connection reuse\n'.repeat(3),
    'recipes.md': 'cooking recipes with pasta and tomato sauce for dinner\n'.repeat(3),
  });
  const out = await codeTool('semantic_search').execute(
    { query: 'database connection pooling' },
    CTX(dir),
  );
  assert.match(out, /Keyword-ranked \(TF-IDF\)/);
  assert.match(out, /db\.md/);
  assert.ok(out.indexOf('db.md') < out.indexOf('recipes.md') || !out.includes('recipes.md'));
});
