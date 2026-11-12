#!/usr/bin/env node
/**
 * Headless CLI cho open-bot (M8).
 *
 * Chạy bot / team từ terminal, không cần mở app desktop:
 *
 *   open-bot run --bot <id|name> --prompt "..." [--json] [--export out.json]
 *   open-bot run --provider mock --model mock --prompt "..." [--json]
 *   open-bot team apply team.json [--json]
 *
 * Tái dùng AgentCoordinator in-process (không viết agent loop mới).
 * Approval ở headless MẶC ĐỊNH TỪ CHỐI fail-closed (không có UI để
 * hiện thẻ duyệt): mọi tool call cần duyệt bị từ chối ngay, run trả
 * text `đã hủy` + exit code 3. Chỉ `--auto-approve` (cờ tường minh)
 * mới tự duyệt — không có auto-approve ngầm. Permission từ CLI engine
 * (broker M5) cũng từ chối vì CLI không gắn UI handler cho harness.
 *
 * Bot lấy từ `<dataDir>/bots.json` (mảng `{bot, provider}` — cùng
 * shape settings của desktop, provider có thể kèm `mockResponses`
 * để chạy thử không cần key). Provider API-key lấy key từ env
 * `OPENBOT_<PROVIDER>_API_KEY` (vd `OPENBOT_GEMINI_API_KEY`); không
 * có key thì lỗi rõ — CLI không bao giờ đọc Vault của desktop.
 * `dataDir` mặc định: env `OPENBOT_DATA_DIR`, nếu không thì
 * `~/.open-bot`.
 *
 * Exit code: 0 = xong; 1 = lỗi dùng/sai tham số/config; 2 = run lỗi
 * (provider lỗi, bot không chạy được); 3 = run dừng vì approval bị
 * từ chối ở headless (text `đã hủy`).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AgentCoordinator,
  FleetManager,
  LocalHarness,
  getTeamConfigPath,
  saveTeamConfig,
  validateTeamConfig,
  validateVisionAttachments,
} from '@open-bot/core';
import type {
  AgentEvent,
  BotConfig,
  CoordinatorNotification,
  CreateBotProviderConfig,
  VisionAttachment,
} from '@open-bot/core';

const VERSION = '0.50.0';

/** Text loop trả về khi approval bị từ chối (xem agent/loop.ts). */
export const APPROVAL_DENIED_TEXT = 'đã hủy';

const HELP = `open-bot ${VERSION} — headless CLI (không cần mở app desktop)

DÙNG:
  open-bot run --bot <id|name> --prompt "..." [--json] [--export FILE] [--auto-approve] [--image FILE ...]
  open-bot run --provider <id> --model <model> --prompt "..." [--json] [--export FILE] [--image FILE ...]
  open-bot team apply <file.json> [--json]
  open-bot fleet list [--json]
  open-bot fleet create --name <name> --os-user <user> [--cpu N] [--ram-gb N] [--disk-gb N] [--json]
  open-bot fleet status <id> [--json]
  open-bot fleet start|stop|restart|suspend|activate <id> [--json]
  open-bot fleet remove <id> [--delete-data] [--json]
  open-bot fleet capacity [--cpu N] [--ram-gb N] [--json]
  open-bot fleet audit [--json]
  open-bot fleet usage <id> [--json]
  open-bot fleet add-member <id> --user <userId> --role <admin|member|chat-only> [--json]
  open-bot fleet remove-member <id> --user <userId> [--json]
  open-bot fleet set-role <id> --user <userId> --role <admin|member|chat-only> [--json]
  open-bot --help

LỆNH:
  run           Chạy 1 prompt qua 1 bot, in kết quả ra stdout.
                --bot: bot trong <dataDir>/bots.json (khớp id hoặc tên).
                --provider/--model: tạo bot tạm (không lưu) với provider đó;
                provider mock chạy không cần key (trả lời scripted).
  team apply    Áp dụng cấu hình team từ file JSON: validate rồi ghi
                <dataDir>/team.json (ghi đè file cũ).
  fleet         Quản lý tầng fleet đa người dùng (đội D): mỗi workspace
                1 OS user + 1 service + 1 port loopback + thư mục riêng,
                dữ liệu ở <dataDir>/fleet. Service chỉ bind 127.0.0.1.
                list/status/capacity/audit/usage chỉ đọc; create/start/
                stop/restart/remove/suspend/activate thay đổi trạng thái.
                Lưu ý: 'fleet health' không có ở CLI — token health chỉ
                giữ trong bộ nhớ của process đã start service, nên CLI
                dùng 'fleet status' (kiểm tra pid còn sống) thay thế.

CỜ CHUNG:
  --data-dir DIR   Thư mục dữ liệu (mặc định env OPENBOT_DATA_DIR, nếu không
                   thì ~/.open-bot). bots.json / team.json / group-chats.json
                   đều nằm đây.
  --json           Xuất kết quả dạng JSON máy đọc được (run: {botId, text,
                   stopped, runId, approvalDenied}; team apply: {ok, id,
                   name, members, sharedBots, path}).
  --export FILE    (run) Ghi kết quả JSON vào FILE, thêm vào stdout thường.
  --image FILE     (run) Đính kèm 1 ảnh cho lượt này (lặp lại được, tối
                   đa 5 ảnh; chỉ PNG/JPEG/GIF/WebP). Ảnh đi tới model
                   qua đúng kênh vision của desktop (validate + gate
                   model hỗ trợ vision, fail-closed). --prompt được
                   bỏ trống khi chỉ gửi ảnh.
  --auto-approve   (run) TỰ DUYỆT mọi tool call cần duyệt trong run này.
                   Mặc định (không có cờ): approval ở headless BỊ TỪ CHỐI
                   fail-closed vì không có UI để hiện thẻ duyệt — run trả
                   text "đã hủy", exit code 3. Không có auto-approve ngầm.

KEY:
  Provider API-key lấy từ env OPENBOT_<PROVIDER>_API_KEY
  (vd OPENBOT_GEMINI_API_KEY, OPENBOT_OPENAI_API_KEY). CLI không đọc
  Vault của desktop và không dùng key nào khác.

EXIT CODE: 0 xong · 1 lỗi dùng/config · 2 run lỗi · 3 approval bị từ chối.
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`open-bot: ${message}\n`);
  process.exit(code);
}

/** Flags đã parse: một key lặp lại (vd --image) thành mảng string. */
export type CliFlags = Record<string, string | boolean | string[]>;

function resolveDataDir(args: CliFlags): string {
  const flag = args['data-dir'];
  if (typeof flag === 'string' && flag.trim() !== '') return path.resolve(flag.trim());
  const env = process.env['OPENBOT_DATA_DIR'];
  if (env && env.trim() !== '') return path.resolve(env.trim());
  return path.join(os.homedir(), '.open-bot');
}

/** Parse argv dạng `--key value` / `--flag` / positional. Một key lặp
 *  lại (vd `--image a.png --image b.png`) gom thành mảng, giữ thứ tự. */
function parseArgs(argv: string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = [];
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        const prev = flags[key];
        if (Array.isArray(prev)) prev.push(next);
        else if (typeof prev === 'string') flags[key] = [prev, next];
        else flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

interface BotsFileEntry {
  bot: BotConfig;
  provider: CreateBotProviderConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadBotsFile(dataDir: string): BotsFileEntry[] {
  const file = path.join(dataDir, 'bots.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`bots.json hỏng (${file}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) fail(`bots.json sai định dạng: cần mảng [{bot, provider}].`);
  const out: BotsFileEntry[] = [];
  for (const entry of parsed as unknown[]) {
    if (!isRecord(entry) || !isRecord(entry['bot']) || !isRecord(entry['provider'])) {
      fail('bots.json sai định dạng: mỗi entry cần {bot, provider} là object.');
    }
    out.push(entry as unknown as BotsFileEntry);
  }
  return out;
}

/** Key provider từ env OPENBOT_<ID>_API_KEY (mock thì không cần key). */
function apiKeyFromEnv(providerId: string): string | undefined {
  if (providerId === 'mock') return undefined;
  const envName = `OPENBOT_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const value = process.env[envName];
  return value && value.trim() !== '' ? value : undefined;
}

/** MIME theo đuôi file cho --image (khớp VISION_ALLOWED_MIME_TYPES). */
const IMAGE_EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * v0.89a (vision qua headless CLI): đọc các file `--image` thành
 * `VisionAttachment[]` (base64). File không đọc được / đuôi không hỗ
 * trợ / quá giới hạn → fail (exit 1) với lỗi rõ ràng, chưa chạy bot.
 * Validate cuối bằng `validateVisionAttachments` của core (cùng luật
 * với desktop: tối đa 5 ảnh, 10 MB/ảnh, 20 MB tổng).
 */
function loadImageAttachments(flags: CliFlags): VisionAttachment[] {
  const raw = flags['image'];
  if (raw === undefined) return [];
  const paths = Array.isArray(raw) ? raw : [raw];
  const attachments: VisionAttachment[] = [];
  for (const p of paths) {
    if (typeof p !== 'string' || p.trim() === '') {
      fail('--image cần đường dẫn file ảnh: --image <file>.');
    }
    const file = path.resolve(p.trim());
    const ext = path.extname(file).toLowerCase();
    const mimeType = IMAGE_EXT_TO_MIME[ext];
    if (!mimeType) {
      fail(
        `ảnh "${p}" có đuôi "${ext || '(không có đuôi)'}" không hỗ trợ — chỉ PNG, JPEG, GIF và WebP.`,
      );
    }
    let data: string;
    try {
      data = fs.readFileSync(file).toString('base64');
    } catch (err) {
      fail(`không đọc được ảnh "${p}": ${err instanceof Error ? err.message : String(err)}`);
    }
    attachments.push({ mimeType, data, name: path.basename(file) });
  }
  const vision = validateVisionAttachments(attachments);
  if (!vision.ok) fail(vision.error);
  return vision.attachments;
}

async function cmdRun(flags: CliFlags): Promise<number> {
  // v0.89a: --prompt được bỏ trống khi có --image (tin chỉ-ảnh, như
  // desktop chat:send). Không prompt lẫn không ảnh thì vẫn lỗi như cũ.
  const prompt = typeof flags['prompt'] === 'string' ? flags['prompt'].trim() : '';
  const attachments = loadImageAttachments(flags);
  if (prompt === '' && attachments.length === 0) {
    fail('run cần --prompt "..." không rỗng (hoặc --image <file> để gửi ảnh).');
  }
  const dataDir = resolveDataDir(flags);
  const asJson = flags['json'] === true;
  const exportFile = typeof flags['export'] === 'string' ? flags['export'] : undefined;
  const autoApprove = flags['auto-approve'] === true;
  if (autoApprove) {
    process.stderr.write(
      'open-bot: cảnh báo: --auto-approve bật — mọi tool call cần duyệt trong run này sẽ được tự duyệt.\n',
    );
  }

  let bot: BotConfig;
  let provider: CreateBotProviderConfig;
  const botRef = flags['bot'];
  const providerId = flags['provider'];
  if (typeof botRef === 'string' && botRef.trim() !== '') {
    const entries = loadBotsFile(dataDir);
    const found = entries.find(
      (e) => e.bot.id === botRef || e.bot.name.toLowerCase() === botRef.toLowerCase(),
    );
    if (!found) {
      fail(
        `Không thấy bot "${botRef}" trong ${path.join(dataDir, 'bots.json')} — kiểm tra id/tên bot, hoặc dùng --provider/--model để tạo bot tạm.`,
      );
    }
    bot = found.bot;
    provider = found.provider;
  } else if (typeof providerId === 'string' && providerId.trim() !== '') {
    const model = flags['model'];
    if (typeof model !== 'string' || model.trim() === '') {
      fail('run với --provider cần thêm --model <model>.');
    }
    const id = providerId.trim();
    bot = {
      id: `cli-${Date.now()}`,
      name: `CLI ${id}`,
      providerId: id,
      model: model.trim(),
      systemPrompt: 'Bạn là trợ lý chạy từ terminal. Trả lời ngắn gọn.',
      workspaceDir: path.join(dataDir, 'workspaces', 'cli'),
      autoApprove: false,
    };
    provider = {
      id,
      label: id,
      defaultModel: model.trim(),
      ...(id === 'mock'
        ? { mockResponses: [{ text: 'mock reply' }] }
        : {}),
    };
  } else {
    fail('run cần --bot <id|name> hoặc --provider <id> --model <model>.');
  }

  // Provider API-key: lấy từ env; mock không cần. Không có key → lỗi
  // rõ trước khi tạo bot (không gọi provider rồi mới lỗi khó hiểu).
  const apiKey = apiKeyFromEnv(provider.id);
  if (provider.id !== 'mock' && !provider.apiKey && !apiKey) {
    fail(
      `Provider "${provider.id}" cần key: đặt env OPENBOT_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY, hoặc thêm "apiKey" vào entry provider trong bots.json.`,
    );
  }
  if (apiKey) provider = { ...provider, apiKey };

  // v0.50 (M8): coordinator in-process + harness KHÔNG gắn UI handler
  // → permission từ CLI engine bị broker từ chối fail-closed (như cũ).
  // Approval của loop (tool call) đi qua event 'approval-needed': CLI
  // trả lời NGAY (deny mặc định, allow chỉ khi --auto-approve) thay vì
  // chờ hết timeout 10 phút của coordinator.
  let coordinator: AgentCoordinator | null = null;
  const harness = new LocalHarness({ dataDir });
  coordinator = new AgentCoordinator({
    dataDir,
    harness,
    emit: (notification: CoordinatorNotification) => {
      if (notification.event !== 'agent.event') return;
      const event = notification.data as AgentEvent;
      if (event.kind !== 'approval-needed' || !coordinator) return;
      const payload = event.payload as { callId?: unknown; call?: { name?: unknown } };
      const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
      if (!callId) return;
      const toolName = typeof payload.call?.name === 'string' ? payload.call.name : '?';
      if (autoApprove) {
        process.stderr.write(`open-bot: tự duyệt (theo --auto-approve): ${toolName}\n`);
        coordinator.respondApproval({ callId, approved: true });
      } else {
        process.stderr.write(
          `open-bot: từ chối approval headless (không có UI): ${toolName} — dùng --auto-approve để tự duyệt tường minh.\n`,
        );
        coordinator.respondApproval({ callId, approved: false });
      }
    },
  });

  try {
    await coordinator.createBot({ bot, provider });
    const result = await coordinator.run({
      botId: bot.id,
      text: prompt,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    const approvalDenied = result.text === APPROVAL_DENIED_TEXT;
    const output = {
      botId: bot.id,
      botName: bot.name,
      text: result.text,
      stopped: result.stopped,
      runId: result.runId,
      approvalDenied,
    };
    if (exportFile) {
      const outPath = path.resolve(exportFile);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
      process.stderr.write(`open-bot: đã ghi kết quả JSON vào ${outPath}\n`);
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } else {
      process.stdout.write(`${result.text}\n`);
    }
    return approvalDenied ? 3 : 0;
  } catch (err) {
    process.stderr.write(`open-bot: run lỗi: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  } finally {
    try {
      coordinator.shutdown();
    } catch {
      // Shutdown là best-effort; exit code đã quyết ở trên.
    }
  }
}

function cmdTeamApply(positional: string[], flags: CliFlags): number {
  const file = positional[0];
  if (!file) fail('team apply cần đường dẫn file JSON: open-bot team apply <file.json>.');
  const dataDir = resolveDataDir(flags);
  const asJson = flags['json'] === true;
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (err) {
    fail(`Không đọc được file team "${file}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`File team "${file}" không phải JSON hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
  }
  let team;
  try {
    team = validateTeamConfig(parsed);
  } catch (err) {
    fail(`Cấu hình team không hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
  }
  saveTeamConfig(dataDir, team);
  const output = {
    ok: true,
    id: team.id,
    name: team.name,
    members: team.members.length,
    sharedBots: team.sharedBots.length,
    path: getTeamConfigPath(dataDir),
  };
  if (asJson) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    process.stdout.write(
      `Đã áp dụng team "${team.name}" (id ${team.id}): ${team.members.length} thành viên, ${team.sharedBots.length} bot chia sẻ → ${output.path}\n`,
    );
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  if (flags['help'] === true || flags['h'] === true || positional.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const [cmd, sub] = positional;
  if (cmd === 'run') {
    return cmdRun(flags);
  }
  if (cmd === 'fleet') {
    return cmdFleet(sub, positional.slice(2), flags);
  }
  if (cmd === 'team' && sub === 'apply') {
    return cmdTeamApply(positional.slice(2), flags);
  }
  if (cmd === 'team') {
    fail('team chỉ hỗ trợ "apply": open-bot team apply <file.json>.');
  }
  process.stdout.write(HELP);
  return fail(`Không rõ lệnh "${cmd}".`, 1);
}

/**
 * Lệnh `fleet` (đội D) — quản lý tầng fleet đa người dùng từ terminal.
 * Fleet root = <dataDir>/fleet (cùng chỗ desktop dùng).
 *
 * Lưu ý vòng đời process: `start`/`restart` để service chạy tiếp sau
 * khi CLI thoát (service spawn detached trên POSIX) nên KHÔNG dispose
 * ở 2 lệnh đó; các lệnh còn lại dispose (no-op vì không start gì).
 * `stop` dùng pid đã lưu trong registry nên dừng được service do
 * desktop (process khác) start.
 */
async function cmdFleet(
  sub: string | undefined,
  positional: string[],
  flags: CliFlags,
): Promise<number> {
  const dataDir = resolveDataDir(flags);
  const manager = new FleetManager({ rootDir: path.join(dataDir, 'fleet') });
  const asJson = flags['json'] === true;
  const out = (obj: unknown, text: string): void => {
    process.stdout.write(asJson ? `${JSON.stringify(obj)}\n` : text);
  };
  const needId = (): string => {
    const id = positional[0];
    if (!id) fail(`fleet ${sub ?? ''} cần id workspace: open-bot fleet ${sub ?? '<lệnh>'} <id>.`);
    return id;
  };
  const numFlag = (key: string, fallback: number): number => {
    const raw = flags[key];
    if (typeof raw !== 'string') return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  // start/restart để service chạy tiếp sau khi CLI thoát.
  const leavesRunningService = sub === 'start' || sub === 'restart';
  try {
    switch (sub) {
      case 'list': {
        const list = manager.listFleet();
        out(
          list,
          list.length === 0
            ? 'Chưa có workspace fleet nào.\n'
            : `${list
                .map(
                  (s) =>
                    `${s.workspace.id}  ${s.workspace.name}  os-user=${s.workspace.osUser}  port=${s.workspace.port}  ${s.workspace.status}  service=${s.service.state}${s.service.pid !== undefined ? ` (pid ${s.service.pid})` : ''}  iso=${s.workspace.isolationLevel}`,
                )
                .join('\n')}\n`,
        );
        return 0;
      }
      case 'create': {
        const name = flags['name'];
        const osUser = flags['os-user'];
        if (typeof name !== 'string' || name.trim() === '') {
          fail('fleet create cần --name <tên>: open-bot fleet create --name alice --os-user alice.');
        }
        if (typeof osUser !== 'string' || osUser.trim() === '') {
          fail('fleet create cần --os-user <user>: open-bot fleet create --name alice --os-user alice.');
        }
        const ws = await manager.createWorkspace({
          name: name.trim(),
          osUser: osUser.trim(),
          cpuCores: numFlag('cpu', 1),
          ramBytes: Math.round(numFlag('ram-gb', 1) * 1024 ** 3),
          diskBytes: Math.round(numFlag('disk-gb', 10) * 1024 ** 3),
        });
        out(ws, `Đã tạo workspace "${ws.name}" (id ${ws.id}, os-user ${ws.osUser}, port ${ws.port}, ${ws.isolationLevel}).\n`);
        return 0;
      }
      case 'remove': {
        const id = needId();
        manager.removeWorkspace(id, undefined, { deleteData: flags['delete-data'] === true });
        out({ removed: true, id }, `Đã xoá workspace ${id}${flags['delete-data'] === true ? ' (kèm thư mục dữ liệu)' : ''}.\n`);
        return 0;
      }
      case 'status': {
        const status = manager.getStatus(needId());
        out(
          status,
          `${status.workspace.id}  ${status.workspace.name}  ${status.workspace.status}  service=${status.service.state}${status.service.pid !== undefined ? ` (pid ${status.service.pid})` : ''}${status.service.uptimeMs !== null ? `  uptime ${Math.round(status.service.uptimeMs / 1000)}s` : ''}${status.service.lastError ? `  lỗi: ${status.service.lastError}` : ''}\n`,
        );
        return 0;
      }
      case 'start':
      case 'stop':
      case 'restart': {
        const id = needId();
        const status =
          sub === 'start'
            ? await manager.startService(id)
            : sub === 'stop'
              ? await manager.stopService(id)
              : await manager.restartService(id);
        out(status, `Workspace ${status.workspace.name}: service=${status.service.state}${status.service.pid !== undefined ? ` (pid ${status.service.pid})` : ''}.\n`);
        return 0;
      }
      case 'suspend':
      case 'activate': {
        const id = needId();
        const ws = sub === 'suspend' ? await manager.suspendWorkspace(id) : manager.activateWorkspace(id);
        out(ws, `Workspace "${ws.name}": ${ws.status}.\n`);
        return 0;
      }
      case 'capacity': {
        const check = await manager.checkCapacity({
          cpuCores: numFlag('cpu', 1),
          ramBytes: Math.round(numFlag('ram-gb', 1) * 1024 ** 3),
          diskBytes: Math.round(numFlag('disk-gb', 10) * 1024 ** 3),
        });
        out(
          check,
          check.ok
            ? `Máy đủ sức chứa (còn ${check.headroom.cpuCores} core, ${Math.round(check.headroom.ramBytes / 1024 ** 3)} GB RAM, ${Math.round(check.headroom.diskBytes / 1024 ** 3)} GB đĩa).${check.busy ? ` Lưu ý: máy đang bận (${check.busyReason ?? ''}).` : ''}\n`
            : `Máy KHÔNG đủ sức chứa: ${check.reasonDetail ?? check.reason ?? ''}\n`,
        );
        return check.ok ? 0 : 1;
      }
      case 'audit': {
        const verify = manager.verifyAudit();
        const events = manager.listAudit().slice(-20);
        out(
          { verify, events },
          verify.ok
            ? `Audit log OK (${verify.checked} sự kiện). 20 sự kiện gần nhất:\n${events.map((e) => `  #${e.seq} ${new Date(e.at).toISOString()} ${e.actor} ${e.action} ${e.target}`).join('\n') || '  (trống)'}\n`
            : `Audit log LỖI tại dòng ${verify.badLine}: ${verify.reason ?? ''}\n`,
        );
        return verify.ok ? 0 : 1;
      }
      case 'decisions': {
        const verify = manager.verifyDecisions();
        const decisions = manager.listDecisions().slice(-20);
        out(
          { verify, decisions },
          verify.ok
            ? `Decision log OK (${verify.checked} mục). 20 quyết định gần nhất:\n${decisions.map((d) => `  #${d.seq} ${new Date(d.at).toISOString()} ${d.actor} ${d.action} ${d.target} → ${d.decision}${d.reason ? ` (${d.reason})` : ''}`).join('\n') || '  (trống)'}\n`
            : `Decision log LỖI tại dòng ${verify.badLine}: ${verify.reason ?? ''}\n`,
        );
        return verify.ok ? 0 : 1;
      }
      case 'usage': {
        const id = needId();
        const summary = manager.recordUsage(id);
        out(
          summary,
          summary
            ? `Workspace ${id}: ${summary.samples} mẫu, CPU tối đa ${summary.cpuSecondsMax !== null ? `${summary.cpuSecondsMax}s` : '—'}, RAM mới nhất ${summary.rssBytesLatest !== null ? `${Math.round(summary.rssBytesLatest / 1024 ** 2)} MB` : '—'}, đĩa ${summary.diskBytesLatest !== null ? `${Math.round(summary.diskBytesLatest / 1024)} KB` : '—'}.\n`
            : `Workspace ${id}: chưa có mẫu mức dùng nào.\n`,
        );
        return 0;
      }
      case 'add-member':
      case 'remove-member':
      case 'set-role': {
        const id = needId();
        const userId = flags['user'];
        if (typeof userId !== 'string' || userId.trim() === '') {
          fail(`fleet ${sub} cần --user <userId>.`);
        }
        if (sub === 'remove-member') {
          const ws = manager.removeMember(id, userId.trim());
          out(ws, `Đã xoá thành viên "${userId.trim()}" khỏi workspace "${ws.name}".\n`);
          return 0;
        }
        const role = flags['role'];
        if (role !== 'admin' && role !== 'member' && role !== 'chat-only') {
          fail(`fleet ${sub} cần --role <admin|member|chat-only>.`);
        }
        const ws =
          sub === 'add-member'
            ? manager.addMember(id, { userId: userId.trim(), role })
            : manager.setMemberRole(id, userId.trim(), role);
        out(ws, `Workspace "${ws.name}": ${ws.members.map((m) => `${m.userId} (${m.role})`).join(', ') || 'không còn thành viên'}.\n`);
        return 0;
      }
      case undefined:
        fail('fleet cần subcommand: list | create | remove | status | start | stop | restart | suspend | activate | capacity | audit | decisions | usage | add-member | remove-member | set-role.');
        break;
      default:
        fail(`Không rõ lệnh fleet "${sub}".`);
        break;
    }
    return 0;
  } finally {
    // start/restart: service phải chạy tiếp sau khi CLI thoát.
    if (!leavesRunningService) await manager.dispose();
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`open-bot: lỗi: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
