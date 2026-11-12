/**
 * Plugin sandbox worker (v0.14, item 1).
 *
 * Đây là entry point chạy TRONG tiến trình con của plugin sandbox (được
 * fork từ `sandbox.ts`). Nó vẫn dùng `loadPlugin` hiện có (in-process đối
 * với tiến trình con), nhưng code plugin chỉ chạy trong process con này —
 * plugin treo/crash/rò rỉ bộ nhớ không kéo theo tiến trình coordinator.
 *
 * Giao thức IPC JSON với host (`process.send` / `on('message')`):
 *   Host -> worker:
 *     { id, method: 'init', pluginDir }     — tải plugin (nếu chưa tải
 *       từ argv thì tải ở đây)
 *     { id, method: 'callTool', tool, args }
 *     { id, method: 'ping' }
 *     { id, method: 'listTools' }
 *   Worker -> host:
 *     { id, ok: true, result } | { id, ok: false, error: { message } }
 *     { id: '__ready__', ok, result: { tools, definitions, heapSizeLimitMb } }
 *       — gửi một lần khi plugin tải xong (hoặc thất bại) lúc khởi động.
 *       `definitions` là [{definition, needsApproval}] để host dựng lại
 *       Tool cho registry mà không cần load plugin in-process.
 *
 * `pluginDir` được nhận qua `process.argv[2]` (host fork với args) hoặc
 * qua message `init` đầu tiên — cả hai đường đều được hỗ trợ.
 *
 * Khi parent chết / kênh IPC đóng (`disconnect`), worker tự thoát sạch
 * với `process.exit(0)` để không còn process con mồ côi.
 */
import { getHeapStatistics } from 'node:v8';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Tool, ToolDefinition } from '@open-bot/core';
import { loadPlugin, loadPluginFromManifest, type LoadedPlugin } from './loader';
import { loadBundle } from './bundle';

/** Một tool của plugin, đủ thông tin để host dựng lại Tool cho registry
 *  (v0.14 integration: definition + needsApproval, không chỉ tên). */
export interface SandboxedToolInfo {
  definition: ToolDefinition;
  needsApproval: boolean;
}

type WorkerRequest = {
  id?: unknown;
  method?: unknown;
  pluginDir?: unknown;
  tool?: unknown;
  args?: unknown;
};

type WorkerResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { message: string };
};

let loaded: LoadedPlugin | null = null;
let toolsByName = new Map<string, Tool>();

function send(msg: WorkerResponse): void {
  try {
    process.send?.(msg);
  } catch {
    // Parent đã chết / kênh IPC đã đóng — không còn ai nghe.
  }
}

function heapSizeLimitMb(): number {
  return Math.round(getHeapStatistics().heap_size_limit / (1024 * 1024));
}

function readyPayload(): {
  tools: string[];
  definitions: SandboxedToolInfo[];
  heapSizeLimitMb: number;
} {
  return {
    tools: [...toolsByName.keys()],
    definitions: [...toolsByName.values()].map((t) => ({
      definition: t.definition,
      needsApproval: t.needsApproval,
    })),
    heapSizeLimitMb: heapSizeLimitMb(),
  };
}

function doLoad(pluginDir: string): LoadedPlugin {
  let next: LoadedPlugin;
  if (fs.existsSync(path.join(pluginDir, 'manifest.json'))) {
    next = loadPlugin(pluginDir);
  } else {
    // Bundle (plugin.json/bundle.json): chỉ có tool khi bundle khai `main`.
    const parts = loadBundle(pluginDir);
    if (!parts.manifest.main || !parts.main) {
      throw new Error(
        `Bundle "${parts.manifest.id}" không có entry "main" — không có tool để chạy trong sandbox.`,
      );
    }
    next = loadPluginFromManifest(
      { ...parts.manifest, main: parts.manifest.main },
      pluginDir,
      'plugin.json',
    );
  }
  loaded = next;
  toolsByName = new Map(next.tools.map((t) => [t.definition.name, t]));
  return next;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Gửi một message rồi thoát với code 1 (dùng khi plugin tải thất bại
 *  lúc khởi động — host sẽ khởi động lại worker hoặc đánh dấu dead). */
function sendThenExit(msg: WorkerResponse): void {
  try {
    process.send?.(msg, () => process.exit(1));
    // Phòng trường hợp callback không bao giờ chạy (IPC đã đóng):
    setTimeout(() => process.exit(1), 500).unref?.();
  } catch {
    process.exit(1);
  }
}

function reply(id: string, ok: boolean, result?: unknown, message?: string): void {
  send(
    ok
      ? { id, ok: true, result }
      : { id, ok: false, error: { message: message ?? 'Lỗi không rõ trong plugin worker.' } },
  );
}

async function handleMessage(msg: unknown): Promise<void> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
  const req = msg as WorkerRequest;
  if (typeof req.id !== 'string' || req.id === '') return;
  const id = req.id;

  switch (req.method) {
    case 'init': {
      if (loaded !== null) {
        reply(id, true, readyPayload());
        return;
      }
      const dir = typeof req.pluginDir === 'string' ? req.pluginDir : process.argv[2];
      if (typeof dir !== 'string' || dir === '') {
        const message = 'Plugin worker chưa nhận được pluginDir (argv hoặc message init).';
        reply(id, false, undefined, message);
        sendThenExit({ id: '__ready__', ok: false, error: { message } });
        return;
      }
      try {
        doLoad(dir);
        send({ id: '__ready__', ok: true, result: readyPayload() });
        reply(id, true, readyPayload());
      } catch (err) {
        const message = `Không tải được plugin từ "${dir}": ${errMessage(err)}`;
        reply(id, false, undefined, message);
        sendThenExit({ id: '__ready__', ok: false, error: { message } });
      }
      return;
    }
    case 'callTool': {
      if (loaded === null) {
        reply(id, false, undefined, 'Plugin chưa được tải — worker chưa nhận message init.');
        return;
      }
      if (typeof req.tool !== 'string' || req.tool === '') {
        reply(id, false, undefined, 'callTool cần "tool" là tên tool (chuỗi không rỗng).');
        return;
      }
      const tool = toolsByName.get(req.tool);
      if (tool === undefined) {
        reply(
          id,
          false,
          undefined,
          `Plugin "${loaded.manifest.id}" không có tool "${req.tool}". ` +
            `Các tool có sẵn: ${[...toolsByName.keys()].join(', ') || '(không có)'}.`,
        );
        return;
      }
      const args =
        req.args !== undefined && typeof req.args === 'object' && req.args !== null
          ? (req.args as Record<string, unknown>)
          : {};
      try {
        // workspaceDir của worker là cwd kế thừa từ host; tool chạy trong
        // process con nên mọi tác dụng phụ (fs/shell) đều bị cô lập ở đây.
        const out = await tool.execute(args, {
          workspaceDir: process.cwd(),
          botId: 'sandbox-worker',
        });
        reply(id, true, typeof out === 'string' ? out : String(out ?? ''));
      } catch (err) {
        reply(id, false, undefined, errMessage(err));
      }
      return;
    }
    case 'ping': {
      reply(id, true, { pong: true });
      return;
    }
    case 'listTools': {
      reply(id, true, readyPayload());
      return;
    }
    default: {
      reply(id, false, undefined, `Plugin worker không biết method "${String(req.method)}".`);
      return;
    }
  }
}

/** Khởi động worker: chỉ chạy khi file này là entry của process con. */
function startWorker(): void {
  // Parent chết / IPC đóng: thoát sạch, không để process con mồ côi.
  process.on('disconnect', () => process.exit(0));
  process.on('message', (msg: unknown) => {
    void handleMessage(msg).catch((err: unknown) => {
      process.stderr.write(`[plugin-worker] lỗi xử lý message: ${errMessage(err)}\n`);
    });
  });

  // Host fork với args [pluginDir]: tải ngay để host biết worker sẵn sàng.
  const argvDir = process.argv[2];
  if (typeof argvDir === 'string' && argvDir !== '') {
    try {
      doLoad(argvDir);
      send({ id: '__ready__', ok: true, result: readyPayload() });
    } catch (err) {
      const message = `Không tải được plugin từ "${argvDir}": ${errMessage(err)}`;
      sendThenExit({ id: '__ready__', ok: false, error: { message } });
    }
  }
  // Không có argv: chờ message `init` đầu tiên từ host.
}

if (require.main === module) {
  startWorker();
}
