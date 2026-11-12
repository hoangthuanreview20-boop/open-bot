/**
 * Tests v0.14 — plugin bundle (packages/tools/src/plugins/bundle.ts)
 * + slash commands (packages/core/src/agent/slash.ts).
 *
 * Chỉ dùng file tạm local, không mạng, không API key.
 * Run: build core + tools rồi `node --test tests/plugin-bundle-slash-v014.test.mjs`
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  loadBundle,
  resolveBundleParts,
  validateBundleManifest,
  PluginBundleError,
} from '../packages/tools/dist/plugins/bundle.js';
import {
  SlashCommandRegistry,
  parseSlashInput,
  renderSlashPrompt,
  SlashCommandError,
} from '../packages/core/dist/agent/slash.js';

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-bundle-slash-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

function baseManifest(overrides = {}) {
  return {
    id: 'demo-bundle',
    name: 'Demo Bundle',
    version: '1.0.0',
    description: 'Bundle demo cho test.',
    permissions: [],
    main: 'index.js',
    tools: ['my_tool'],
    ...overrides,
  };
}

/** Bundle đầy đủ 5 thành phần: skill thư mục, subagent, hook, MCP inline, slash. */
function writeFullBundle(dir, manifestOverrides = {}) {
  writeFile(dir, 'index.js', 'module.exports = { tools: [] };\n');
  writeFile(
    dir,
    'skills/my-skill/SKILL.md',
    '---\nname: my-skill\ndescription: Skill demo.\n---\n# My skill\nLàm việc demo.\n',
  );
  writeFile(dir, 'hooks/check.js', '// hook script demo\n');
  writeFile(dir, 'commands/review.md', '# Review code\nReview code với {{args}}.\n');
  const manifest = baseManifest({
    skill: 'skills/my-skill',
    subagent: { name: 'researcher', instructions: 'Tìm kiếm và tóm tắt.' },
    hook: [{ event: 'PreToolUse', script: 'hooks/check.js' }],
    mcpServer: { name: 'notes-mcp', command: 'node', args: ['server.js'] },
    slashCommand: [{ name: 'review', description: 'Review code.', file: 'commands/review.md' }],
    ...manifestOverrides,
  });
  writeFile(dir, 'plugin.json', JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---------------------------------------------------------------------------
// Bundle: resolve đầy đủ
// ---------------------------------------------------------------------------

test('bundle: manifest hợp lệ resolve đủ 5 thành phần + main + tools', () => {
  const dir = makeTempDir();
  writeFullBundle(dir);
  const parts = loadBundle(dir);
  assert.equal(parts.manifest.id, 'demo-bundle');
  assert.equal(parts.skill.kind, 'directory');
  assert.equal(parts.skill.name, 'my-skill');
  assert.ok(parts.skill.dir.endsWith(path.join('skills', 'my-skill')));
  assert.ok(parts.skill.filePath.endsWith('SKILL.md'));
  assert.equal(parts.subagent.name, 'researcher');
  assert.equal(parts.subagent.instructions, 'Tìm kiếm và tóm tắt.');
  assert.equal(parts.hooks.length, 1);
  assert.equal(parts.hooks[0].event, 'PreToolUse');
  assert.ok(parts.hooks[0].script.endsWith(path.join('hooks', 'check.js')));
  assert.equal(parts.mcpServer.name, 'notes-mcp');
  assert.equal(parts.mcpServer.config.command, 'node');
  assert.equal(parts.slashCommands.length, 1);
  assert.equal(parts.slashCommands[0].name, 'review');
  assert.ok(path.isAbsolute(parts.slashCommands[0].file));
  assert.deepEqual(parts.tools, ['my_tool']);
  assert.ok(parts.main.endsWith('index.js'));
});

test('bundle: loadBundle ưu tiên plugin.json hơn bundle.json; chỉ có bundle.json vẫn nạp được', () => {
  const dir = makeTempDir();
  writeFullBundle(dir);
  writeFile(dir, 'bundle.json', JSON.stringify(baseManifest({ id: 'from-bundle-json' }), null, 2));
  assert.equal(loadBundle(dir).manifest.id, 'demo-bundle');

  const dir2 = makeTempDir();
  writeFile(dir2, 'index.js', 'module.exports = { tools: [] };\n');
  writeFile(dir2, 'bundle.json', JSON.stringify(baseManifest({ id: 'only-bundle-json' }), null, 2));
  assert.equal(loadBundle(dir2).manifest.id, 'only-bundle-json');
});

test('bundle: không có main vẫn hợp lệ khi có thành phần khác (skill inline + slash)', () => {
  const dir = makeTempDir();
  writeFile(dir, 'commands/do.md', '# Làm việc\nLàm {{args}}.\n');
  const manifest = {
    id: 'no-main',
    name: 'No Main',
    version: '0.1.0',
    description: 'Bundle không có main.',
    permissions: [],
    skill: { name: 'inline-skill', description: 'Skill inline.', instructions: 'Làm theo hướng dẫn.' },
    slashCommand: [{ name: 'do', description: 'Làm việc.', file: 'commands/do.md' }],
  };
  writeFile(dir, 'plugin.json', JSON.stringify(manifest, null, 2));
  const parts = loadBundle(dir);
  assert.equal(parts.manifest.main, undefined);
  assert.equal(parts.skill.kind, 'inline');
  assert.equal(parts.skill.name, 'inline-skill');
  assert.equal(parts.slashCommands.length, 1);
});

test('bundle: mcpServer dạng file {servers:{...}} với đúng một server resolve được', () => {
  const dir = makeTempDir();
  writeFile(dir, 'index.js', 'module.exports = { tools: [] };\n');
  writeFile(
    dir,
    'mcp.json',
    JSON.stringify({ servers: { 'file-mcp': { command: 'npx', args: ['-y', 'demo-mcp'] } } }, null, 2),
  );
  const manifest = baseManifest({ mcpServer: 'mcp.json' });
  writeFile(dir, 'plugin.json', JSON.stringify(manifest, null, 2));
  const parts = loadBundle(dir);
  assert.equal(parts.mcpServer.name, 'file-mcp');
  assert.equal(parts.mcpServer.config.command, 'npx');
  assert.ok(parts.mcpServer.file.endsWith('mcp.json'));
});

// ---------------------------------------------------------------------------
// Bundle: lỗi
// ---------------------------------------------------------------------------

test('bundle: thiếu file liệt kê rõ từng lỗi (skill, hook script, slash file)', () => {
  const dir = makeTempDir();
  writeFile(dir, 'index.js', 'module.exports = { tools: [] };\n');
  const manifest = baseManifest({
    skill: 'skills/missing-skill',
    hook: [{ event: 'PreToolUse', script: 'hooks/nope.js' }],
    slashCommand: [{ name: 'gone', description: 'Lệnh thiếu file.', file: 'commands/nope.md' }],
  });
  writeFile(dir, 'plugin.json', JSON.stringify(manifest, null, 2));
  assert.throws(
    () => loadBundle(dir),
    (err) => {
      assert.ok(err instanceof PluginBundleError);
      assert.ok(err.message.includes('skills/missing-skill'), err.message);
      assert.ok(err.message.includes('hooks/nope.js'), err.message);
      assert.ok(err.message.includes('commands/nope.md'), err.message);
      assert.ok(err.errors.length >= 3);
      return true;
    },
  );
});

test('bundle: đường dẫn ".." thoát thư mục bị chặn', () => {
  const dir = makeTempDir();
  writeFile(dir, 'index.js', 'module.exports = { tools: [] };\n');
  const outside = makeTempDir();
  writeFile(outside, 'outside.md', '# Ngoài bundle\n');
  const manifest = baseManifest({
    slashCommand: [{ name: 'evil', description: 'Thoát thư mục.', file: '../outside.md' }],
  });
  writeFile(dir, 'plugin.json', JSON.stringify(manifest, null, 2));
  assert.throws(
    () => loadBundle(dir),
    (err) => {
      assert.ok(err instanceof PluginBundleError);
      assert.match(err.message, /thoát ra ngoài thư mục bundle/);
      return true;
    },
  );
});

test('bundle: symlink trỏ ra ngoài thư mục bị chặn', () => {
  const dir = makeTempDir();
  writeFile(dir, 'index.js', 'module.exports = { tools: [] };\n');
  const outside = makeTempDir();
  const outsideFile = writeFile(outside, 'secret.md', '# Ngoài bundle\n');
  writeFile(dir, 'commands/placeholder.md', '# Giữ chỗ\n');
  fs.symlinkSync(outsideFile, path.join(dir, 'commands', 'evil.md'));
  const manifest = baseManifest({
    slashCommand: [{ name: 'evil', description: 'Symlink thoát.', file: 'commands/evil.md' }],
  });
  writeFile(dir, 'plugin.json', JSON.stringify(manifest, null, 2));
  assert.throws(
    () => loadBundle(dir),
    (err) => {
      assert.ok(err instanceof PluginBundleError);
      assert.match(err.message, /symlink/);
      return true;
    },
  );
});

test('bundle: trùng tên giữa các thành phần (skill thư mục vs lệnh slash) → lỗi', () => {
  const dir = makeTempDir();
  writeFullBundle(dir, {
    skill: 'skills/review',
    slashCommand: [{ name: 'review', description: 'Review code.', file: 'commands/review.md' }],
  });
  // Đổi tên thư mục skill thành "review" cho trùng với lệnh slash.
  fs.renameSync(path.join(dir, 'skills', 'my-skill'), path.join(dir, 'skills', 'review'));
  assert.throws(
    () => loadBundle(dir),
    (err) => {
      assert.ok(err instanceof PluginBundleError);
      assert.match(err.message, /"review" bị trùng/);
      assert.match(err.message, /skill và lệnh slash/);
      return true;
    },
  );
});

test('bundle: trùng tên subagent vs lệnh slash → lỗi', () => {
  const dir = makeTempDir();
  writeFullBundle(dir, {
    subagent: { name: 'review', instructions: 'Review.' },
    slashCommand: [{ name: 'review', description: 'Review code.', file: 'commands/review.md' }],
  });
  assert.throws(
    () => loadBundle(dir),
    (err) => {
      assert.ok(err instanceof PluginBundleError);
      assert.match(err.message, /"review" bị trùng/);
      return true;
    },
  );
});

test('bundle: manifest cơ bản sai nhiều chỗ liệt kê từng lỗi (name, version, description)', () => {
  const dir = makeTempDir();
  writeFile(dir, 'index.js', 'module.exports = { tools: [] };\n');
  const manifest = {
    id: 'bad-bundle',
    name: '',
    version: 'khong-phai-semver',
    description: '',
    permissions: [],
    main: 'index.js',
  };
  writeFile(dir, 'plugin.json', JSON.stringify(manifest, null, 2));
  assert.throws(
    () => loadBundle(dir),
    (err) => {
      assert.ok(err instanceof PluginBundleError);
      assert.ok(err.errors.length >= 3, `cần >= 3 lỗi, nhận ${err.errors.length}: ${err.message}`);
      assert.match(err.message, /"name"/);
      assert.match(err.message, /"version"/);
      assert.match(err.message, /"description"/);
      return true;
    },
  );
});

test('bundle: thiếu plugin.json/bundle.json và JSON sai đều báo rõ', () => {
  const empty = makeTempDir();
  assert.throws(
    () => loadBundle(empty),
    (err) => {
      assert.ok(err instanceof PluginBundleError);
      assert.match(err.message, /Không tìm thấy plugin\.json hoặc bundle\.json/);
      return true;
    },
  );

  const badJson = makeTempDir();
  writeFile(badJson, 'plugin.json', '{ json sai ');
  assert.throws(
    () => loadBundle(badJson),
    (err) => {
      assert.ok(err instanceof PluginBundleError);
      assert.match(err.message, /không phải JSON hợp lệ/);
      return true;
    },
  );
});

test('bundle: validateBundleManifest + resolveBundleParts dùng riêng lẻ vẫn nhất quán', () => {
  const dir = makeTempDir();
  const manifest = writeFullBundle(dir);
  const validated = validateBundleManifest(manifest, dir);
  assert.equal(validated.id, 'demo-bundle');
  const parts = resolveBundleParts(validated, dir);
  assert.equal(parts.slashCommands[0].name, 'review');
  assert.equal(parts.subagent.name, 'researcher');
});

// ---------------------------------------------------------------------------
// Slash: parse
// ---------------------------------------------------------------------------

test('slash: parse "/tên args" đúng; "/" trơ trọi, không bắt đầu "/", tên sai → null', () => {
  assert.deepEqual(parseSlashInput('/review src/index.ts'), { name: 'review', args: 'src/index.ts' });
  assert.deepEqual(parseSlashInput('/review'), { name: 'review', args: '' });
  assert.deepEqual(parseSlashInput('  /review-code  a b  '), { name: 'review-code', args: 'a b' });
  assert.equal(parseSlashInput('/'), null);
  assert.equal(parseSlashInput('/   '), null);
  assert.equal(parseSlashInput('hello'), null);
  assert.equal(parseSlashInput(''), null);
  assert.equal(parseSlashInput('/Review'), null);
  assert.equal(parseSlashInput('/review_code'), null);
  assert.equal(parseSlashInput('/review/code'), null);
});

// ---------------------------------------------------------------------------
// Slash: markdown + render + trùng tên + bundle
// ---------------------------------------------------------------------------

test('slash: registerFromMarkdown — tên = tên file, mô tả từ dòng "#", nội dung = template', () => {
  const dir = makeTempDir();
  writeFile(dir, 'review.md', '# Review code\nReview code sau đây với {{args}}.\n');
  writeFile(dir, 'summarize.md', 'Tóm tắt nội dung sau:\n\n$ARGUMENTS\n');
  const registry = new SlashCommandRegistry();
  const defs = registry.registerFromMarkdown(dir);
  assert.deepEqual(defs.map((d) => d.name), ['review', 'summarize']);
  assert.equal(registry.find('review').description, 'Review code');
  assert.equal(registry.find('review').source, 'markdown');
  // Không có dòng "#": mô tả = dòng đầu tiên không rỗng.
  assert.equal(registry.find('summarize').description, 'Tóm tắt nội dung sau:');
  assert.equal(registry.find('summarize').file.endsWith('summarize.md'), true);
  assert.deepEqual(registry.list().map((d) => d.name), ['review', 'summarize']);
  assert.equal(registry.parse('/review src/a.ts').name, 'review');
});

test('slash: renderPrompt thay {{args}} / $ARGUMENTS / {{arguments}}; thiếu placeholder thì gắn args cuối prompt', () => {
  const withArgs = { name: 'a', description: 'd', source: 'markdown', promptTemplate: 'Làm {{args}} nhé.' };
  assert.equal(renderSlashPrompt(withArgs, 'việc X'), 'Làm việc X nhé.');
  const withDollar = { name: 'b', description: 'd', source: 'markdown', promptTemplate: 'Tóm tắt:\n$ARGUMENTS' };
  assert.equal(renderSlashPrompt(withDollar, 'bài viết'), 'Tóm tắt:\nbài viết');
  const withArguments = { name: 'c', description: 'd', source: 'markdown', promptTemplate: 'Xử lý {{arguments}}.' };
  assert.equal(renderSlashPrompt(withArguments, 'dữ liệu'), 'Xử lý dữ liệu.');
  const noPlaceholder = { name: 'd', description: 'd', source: 'markdown', promptTemplate: 'Review code sau:' };
  assert.equal(renderSlashPrompt(noPlaceholder, 'src/a.ts'), 'Review code sau:\n\nsrc/a.ts');
  // Args chứa $& không được diễn giải thành nội dung template.
  assert.equal(renderSlashPrompt(withArgs, 'a $& b'), 'Làm a $& b nhé.');
  // Template rỗng → chỉ trả args.
  const empty = { name: 'e', description: 'd', source: 'markdown', promptTemplate: '' };
  assert.equal(renderSlashPrompt(empty, 'chỉ args'), 'chỉ args');
});

test('slash: trùng tên lệnh → lỗi tiếng Việt rõ ràng', () => {
  const registry = new SlashCommandRegistry();
  registry.register({ name: 'review', description: 'Review.', source: 'markdown', promptTemplate: 'Review {{args}}.' });
  assert.throws(
    () => registry.register({ name: 'review', description: 'Review khác.', source: 'markdown', promptTemplate: 'Khác.' }),
    (err) => {
      assert.ok(err instanceof SlashCommandError);
      assert.match(err.message, /Đã có lệnh "\/review"/);
      assert.match(err.message, /trùng tên/);
      return true;
    },
  );
});

test('slash: markdown rỗng và tên file không hợp lệ → lỗi', () => {
  const emptyDir = makeTempDir();
  writeFile(emptyDir, 'empty.md', '   \n\n');
  const registry = new SlashCommandRegistry();
  assert.throws(
    () => registry.registerFromMarkdown(emptyDir),
    (err) => {
      assert.ok(err instanceof SlashCommandError);
      assert.match(err.message, /rỗng/);
      return true;
    },
  );

  const badNameDir = makeTempDir();
  writeFile(badNameDir, 'Bad Name.md', '# Lệnh sai tên\nNội dung.\n');
  assert.throws(
    () => registry.registerFromMarkdown(badNameDir),
    (err) => {
      assert.ok(err instanceof SlashCommandError);
      assert.match(err.message, /không phải tên lệnh slash hợp lệ/);
      return true;
    },
  );

  assert.throws(
    () => registry.registerFromMarkdown(path.join(emptyDir, 'khong-ton-tai')),
    (err) => {
      assert.ok(err instanceof SlashCommandError);
      assert.match(err.message, /Không đọc được thư mục lệnh slash/);
      return true;
    },
  );
});

test('slash: registerFromBundle nhận đúng slashCommands từ resolveBundleParts', () => {
  const dir = makeTempDir();
  writeFullBundle(dir);
  const parts = loadBundle(dir);
  const registry = new SlashCommandRegistry();
  const defs = registry.registerFromBundle(parts);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'review');
  assert.equal(defs[0].source, 'plugin');
  assert.ok(defs[0].file.endsWith(path.join('commands', 'review.md')));
  const found = registry.find('review');
  assert.equal(registry.renderPrompt(found, 'src/index.ts'), '# Review code\nReview code với src/index.ts.\n');
  // Đăng ký lại cùng bundle → trùng tên.
  assert.throws(
    () => registry.registerFromBundle(parts),
    (err) => {
      assert.ok(err instanceof SlashCommandError);
      assert.match(err.message, /trùng tên/);
      return true;
    },
  );
});

test('slash: lệnh có hàm run đăng ký được mà không cần template', () => {
  const registry = new SlashCommandRegistry();
  const def = registry.register({
    name: 'ping',
    description: 'Kiểm tra bot còn sống.',
    source: 'plugin',
    run: (args) => `pong ${args}`,
  });
  assert.equal(def.source, 'plugin');
  assert.equal(registry.renderPrompt(def, 'hello'), 'hello');
});
