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
  ALL_HOOK_EVENTS,
  BotComputerHealthProber,
  buildVerbatimWakeUp,
  ConversationBudgetHistory,
  FleetManager,
  HeadlessJobRunner,
  HOOK_COMMANDS_FILE,
  JsonFileRoutineStore,
  LocalHarness,
  OllamaEmbeddings,
  openVerbatimStoreForWorkspace,
  RiskAnalyzer,
  RiskRuleStore,
  decideConfirmation,
  getTeamConfigPath,
  loadHeadlessJobFile,
  parseConfirmationPolicy,
  runVerbatimMemoryMcpHttp,
  runVerbatimMemoryMcpStdio,
  createMockProvider,
  createProvider,
  query,
  readHookLogFile,
  readTestGateConfig,
  saveTeamConfig,
  summarizeHookLogRecords,
  testGateCommands,
  testRunHookCommand,
  validateHookSettingsFiles,
  validateTeamConfig,
  validateHookCommandEntry,
  validateVisionAttachments,
} from '@open-bot/core';
import { createHarnessV2Tools } from '@open-bot/tools';
import type {
  AgentEvent,
  BotConfig,
  CoordinatorNotification,
  CreateBotProviderConfig,
  RiskRule,
  HookCommandSettingsEntry,
  HookEventKind,
  VisionAttachment,
} from '@open-bot/core';

const VERSION = '0.50.0';

/** Text loop trả về khi approval bị từ chối (xem agent/loop.ts). */
export const APPROVAL_DENIED_TEXT = 'đã hủy';

const HELP = `open-bot ${VERSION} — headless CLI (không cần mở app desktop)

DÙNG:
  open-bot run --bot <id|name> --prompt "..." [--json] [--export FILE] [--auto-approve] [--image FILE ...]
  open-bot run --provider <id> --model <model> --prompt "..." [--json] [--export FILE] [--image FILE ...]
  open-bot run --job <file.json> [--json] [--export FILE]
  open-bot query --prompt "..." [--provider <id>] [--model <model>] [--system-prompt "..."] [--max-turns N] [--auto-approve] [--mock-response "..."] [--json]
  open-bot team apply <file.json> [--json]
  open-bot harness routines list [--json]
  open-bot harness health [--bot <id>] [--json]
  open-bot harness webhook-status [--json]
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
  open-bot risk check --tool <name> --args '<json>' [--workspace DIR] [--policy <policy>] [--json]
  open-bot risk rules list [--json]
  open-bot risk rules add --id <id> --level <low|medium|high> --score <0-100> --description <text> [--tool <name>] [--tool-pattern <re>] [--args-pattern <re>] [--args-key <key>]
  open-bot risk rules remove --id <id>
  open-bot risk allow add|remove <entry> [--json]
  open-bot risk deny add|remove <entry> [--json]
  open-bot risk budget list [--bot <id>] [--json]
  open-bot risk budget totals [--bot <id>] [--json]
  open-bot memory-mcp [--workspace DIR] [--backend sqlite|jsonl] [--read-only] [--embed]
  open-bot memory-mcp --http [--port N] [--workspace DIR] [--backend sqlite|jsonl]
  open-bot memory search <query> [--workspace DIR] [--limit N] [--wing W] [--room R] [--embed] [--json]
  open-bot memory list [--workspace DIR] [--limit N] [--wing W] [--room R] [--json]
  open-bot memory stats [--workspace DIR] [--json]
  open-bot memory backfill [--workspace DIR]
  open-bot memory wakeup [--workspace DIR] [--wing W] [--query Q] [--json]
  open-bot memory prune --older-than-days N [--workspace DIR] [--keep-tag TAG] [--json]
  open-bot hooks list [--json]
  open-bot hooks test <name> [--event <Event>] [--json]
  open-bot hooks log [--limit N] [--summary] [--json]
  open-bot hooks gate [--json]
  open-bot hooks validate [--json]  open-bot --help

LỆNH:
  run           Chạy 1 prompt qua 1 bot, in kết quả ra stdout.
                --bot: bot trong <dataDir>/bots.json (khớp id hoặc tên).
                --provider/--model: tạo bot tạm (không lưu) với provider đó;
                provider mock chạy không cần key (trả lời scripted).
                --job: chạy job kiểu CI từ file JSON (v0.97 harness v2):
                {version: 1, bot|provider+model, prompt, timeoutMs?,
                autoApprove?, ndjson?, ndjsonFile?}. Kết quả in JSON
                (hoặc text), exit code 0 xong / 1 lỗi config / 2 run
                lỗi / 3 approval bị từ chối. Với ndjson: true, event
                cli.job.started/completed ghi ra stdout dạng NDJSON.
  query         Chạy 1 prompt qua Agent SDK query() (v1.01, Team T6):
                agent loop trong process, stream event text ra stdout
                (hoặc JSON với --json). --provider mặc định mock (trả
                lời --mock-response, không cần key); provider thật lấy
                key từ env OPENBOT_<PROVIDER>_API_KEY. Không có tool
                mặc định; tool cần duyệt bị từ chối trừ --auto-approve.
  harness       Harness v2 (v0.97): routines list (đọc
                <dataDir>/routines-v2.json), health (probe CPU/RAM/
                đĩa/process/heartbeat của computer bot), webhook-status
                (tóm tắt log delivery webhook đã ký).
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
  risk          Risk budget (v1.01, đội T3): chấm risk cho 1 tool call
                (check — dùng đúng rule của <dataDir>/risk-rules.json),
                quản lý rule custom + allowlist/denylist, xem lịch sử
                budget theo conversation (<dataDir>/budget-history.json).
                check chỉ CHẤM, không chạy tool — an toàn để thử rule.
                rules add/remove và allow/deny ghi vào risk-rules.json.
  memory-mcp    (v1.01) MCP server cho verbatim memory — để Claude Code,
                Codex CLI, Cursor, Gemini CLI… dùng chung kho memory
                nguyên văn với open-bot. Mặc định chạy stdio (NDJSON qua
                stdin/stdout): thêm vào MCP client bằng
                claude mcp add open-bot-verbatim -- open-bot memory-mcp.
                5 tool: memory.save / memory.search / memory.list /
                memory.delete / memory.stats. Store ở
                <workspace>/.open-bot/verbatim (SQLite mặc định, JSONL
                khi --backend jsonl). --workspace mặc định là thư mục
                hiện tại. --read-only tắt save/delete. --embed bật
                recall ngữ nghĩa qua Ollama local (nomic-embed-text).
                --http chạy Streamable HTTP trên loopback thay vì stdio
                (mặc định chỉ đọc; muốn ghi qua HTTP thì thêm
                --allow-writes). Log ra stderr, KHÔNG bao giờ ra
                stdout (stdout là kênh MCP).
  memory        (v1.01) Đọc/ghi verbatim memory từ terminal (cùng store
                với memory-mcp và desktop: <workspace>/.open-bot/verbatim).
                search: recall hybrid (BM25; --embed bật ngữ nghĩa qua
                Ollama local). list: liệt kê mới nhất trước. stats: tổng
                record / đã embed / backend. backfill: embed toàn bộ
                record chưa có vector qua Ollama (cần Ollama chạy).
                wakeup: in khối context đầu session (mới nhất + liên
                quan tới --query). prune: xoá record cũ hơn N ngày
                (trừ record có tag --keep-tag, lặp lại được).
                --workspace mặc định là thư mục hiện tại; --json xuất JSON.
  hooks         Lifecycle hooks (v1.01): đọc <dataDir>/hooks-commands.json
                (cùng file coordinator đọc khi stateDir là dataDir này —
                desktop dùng userData riêng, nên hook của desktop và của
                CLI là 2 file khác nhau). list: liệt kê hook lệnh shell;
                test <name>: chạy thử hook 1 lần với event mẫu (không
                chạm tool thật); log: các lần hook chạy gần đây từ
                <dataDir>/hook-executions.jsonl (--summary: thống kê
                theo từng hook); gate: cấu hình test gate (lệnh kiểm
                tra chạy khi subagent dừng); validate: kiểm tra cả 2
                file cấu hình hook và báo mọi lỗi (exit 1 khi có lỗi).
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
  // v0.97 (harness v2): --job chạy job kiểu CI từ file JSON.
  if (typeof flags['job'] === 'string' && flags['job'].trim() !== '') {
    return cmdRunJob(flags);
  }
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

  // Provider API-key đã kiểm tra ở trên; chạy bot qua hàm dùng chung
  // với --job (v0.97) để cả hai đường cùng xử lý approval fail-closed.
  let outcome: { botId: string; botName: string; text: string; stopped: boolean; runId: string };
  try {
    outcome = await executeBotRun({ bot, provider, prompt, attachments, autoApprove, dataDir });
  } catch (err) {
    process.stderr.write(`open-bot: run lỗi: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const approvalDenied = outcome.text === APPROVAL_DENIED_TEXT;
  const output = { ...outcome, approvalDenied };
  if (exportFile) {
    const outPath = path.resolve(exportFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
    process.stderr.write(`open-bot: đã ghi kết quả JSON vào ${outPath}\n`);
  }
  if (asJson) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    process.stdout.write(`${outcome.text}\n`);
  }
  return approvalDenied ? 3 : 0;
}

/**
 * Chạy 1 bot turn headless qua coordinator in-process (dùng chung cho
 * `run` thường và `run --job`).
 *
 * v0.50 (M8): coordinator + harness KHÔNG gắn UI handler → permission
 * từ CLI engine bị broker từ chối fail-closed. Approval của loop (tool
 * call) đi qua event 'approval-needed': CLI trả lời NGAY (deny mặc
 * định, allow chỉ khi autoApprove) thay vì chờ hết timeout 10 phút
 * của coordinator. `abortSignal` (job timeout) đua với run: khi hết
 * giờ, run bị dừng qua coordinator.stopBot và hàm này throw lỗi
 * timeout để HeadlessJobRunner trả exit code 2.
 */
async function executeBotRun(opts: {
  bot: BotConfig;
  provider: CreateBotProviderConfig;
  prompt: string;
  attachments: VisionAttachment[];
  autoApprove: boolean;
  dataDir: string;
  abortSignal?: AbortSignal;
}): Promise<{ botId: string; botName: string; text: string; stopped: boolean; runId: string }> {
  const { bot, provider, prompt, attachments, autoApprove, dataDir, abortSignal } = opts;
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
    const runPromise = coordinator.run({
      botId: bot.id,
      text: prompt,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    let result: Awaited<typeof runPromise>;
    if (abortSignal) {
      result = await Promise.race([
        runPromise,
        new Promise<never>((_resolve, reject) => {
          if (abortSignal.aborted) {
            reject(new Error('Job timed out.'));
            return;
          }
          abortSignal.addEventListener(
            'abort',
            () => {
              try {
                void coordinator?.stopBot?.({ botId: bot.id });
              } catch {
                // Stop là best-effort; lỗi timeout vẫn được báo dưới đây.
              }
              reject(new Error('Job timed out.'));
            },
            { once: true },
          );
        }),
      ]);
    } else {
      result = await runPromise;
    }
    return {
      botId: bot.id,
      botName: bot.name,
      text: result.text ?? '',
      stopped: result.stopped,
      runId: result.runId ?? '',
    };
  } finally {
    try {
      coordinator.shutdown();
    } catch {
      // Shutdown là best-effort.
    }
  }
}

/**
 * v0.97 (harness v2): `open-bot run --job <file.json>` — chạy job kiểu
 * CI từ file: đọc + validate job (HeadlessJobRunner), giải quyết
 * bot/provider như `run` thường, chạy qua executeBotRun, in kết quả
 * JSON (hoặc text) + NDJSON khi job yêu cầu, exit code theo
 * HeadlessJobResult (0 / 1 / 2 / 3). Provider mock và CLI-kind không
 * đi qua router (shouldBypassRouter trong core).
 */
async function cmdRunJob(flags: CliFlags): Promise<number> {
  const jobFile = (flags['job'] as string).trim();
  const dataDir = resolveDataDir(flags);
  const asJson = flags['json'] === true;
  const exportFile = typeof flags['export'] === 'string' ? flags['export'] : undefined;
  let job;
  try {
    job = loadHeadlessJobFile(jobFile);
  } catch (err) {
    fail(`Job file không hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
  }
  const autoApprove = job.autoApprove === true;
  if (autoApprove) {
    process.stderr.write(
      'open-bot: cảnh báo: job bật autoApprove — mọi tool call cần duyệt trong run này sẽ được tự duyệt.\n',
    );
  }
  let bot: BotConfig;
  let provider: CreateBotProviderConfig;
  if (typeof job.bot === 'string' && job.bot.trim() !== '') {
    const entries = loadBotsFile(dataDir);
    const found = entries.find(
      (e) => e.bot.id === job.bot || e.bot.name.toLowerCase() === job.bot!.toLowerCase(),
    );
    if (!found) {
      fail(
        `Không thấy bot "${job.bot}" trong ${path.join(dataDir, 'bots.json')} — kiểm tra id/tên bot, hoặc dùng provider/model trong job.`,
      );
    }
    bot = found.bot;
    provider = found.provider;
  } else {
    const id = (job.provider as string).trim();
    bot = {
      id: `cli-${Date.now()}`,
      name: `CLI ${id}`,
      providerId: id,
      model: (job.model as string).trim(),
      systemPrompt: 'Bạn là trợ lý chạy từ terminal. Trả lời ngắn gọn.',
      workspaceDir: path.join(dataDir, 'workspaces', 'cli'),
      autoApprove: false,
    };
    provider = {
      id,
      label: id,
      defaultModel: (job.model as string).trim(),
      ...(id === 'mock' ? { mockResponses: [{ text: 'mock reply' }] } : {}),
    };
  }
  const apiKey = apiKeyFromEnv(provider.id);
  if (provider.id !== 'mock' && !provider.apiKey && !apiKey) {
    fail(
      `Provider "${provider.id}" cần key: đặt env OPENBOT_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY, hoặc thêm "apiKey" vào entry provider trong bots.json.`,
    );
  }
  if (apiKey) provider = { ...provider, apiKey };
  const attachments: VisionAttachment[] = [];
  if (job.imageFiles) {
    const imageFlags: CliFlags = { image: job.imageFiles.length === 1 ? job.imageFiles[0] as string : job.imageFiles };
    attachments.push(...loadImageAttachments(imageFlags));
  }
  const prompt = typeof job.prompt === 'string' ? job.prompt : '';
  const runner = new HeadlessJobRunner(
    async (jobArg, runOpts) => {
      const outcome = await executeBotRun({
        bot,
        provider,
        prompt,
        attachments,
        autoApprove,
        dataDir,
        abortSignal: runOpts.signal,
      });
      return outcome;
    },
    { ndjsonStream: process.stdout },
  );
  const result = await runner.runJob(job);
  const output = {
    jobName: result.jobName,
    botId: result.botId,
    botName: result.botName,
    text: result.text,
    stopped: result.stopped,
    runId: result.runId,
    approvalDenied: result.approvalDenied,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    eventsEmitted: result.eventsEmitted,
  };
  if (exportFile) {
    const outPath = path.resolve(exportFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
    process.stderr.write(`open-bot: đã ghi kết quả JSON vào ${outPath}\n`);
  }
  if (asJson || !job.ndjson) {
    process.stdout.write(asJson ? `${JSON.stringify(output)}\n` : `${result.text}\n`);
  }
  return result.exitCode;
}

/**
 * v0.97 (harness v2): `open-bot harness <routines|health|webhook-status>`.
 * Chỉ đọc trạng thái local (routines file, probe máy, log delivery) —
 * không chạy bot, không chạm provider, không đọc Vault.
 */
async function cmdHarness(sub: string | undefined, positional: string[], flags: CliFlags): Promise<number> {
  const dataDir = resolveDataDir(flags);
  const asJson = flags['json'] === true;
  switch (sub) {
    case 'routines': {
      if (positional[0] !== 'list') {
        fail('harness routines chỉ hỗ trợ "list": open-bot harness routines list [--json].');
      }
      const store = new JsonFileRoutineStore(dataDir);
      const routines = store.list();
      const rows = routines.map((r) => {
        const runs = store.listRuns(r.id);
        const latest = runs.length > 0 ? runs[runs.length - 1] : undefined;
        return {
          id: r.id,
          name: r.name,
          botId: r.botId,
          trigger: r.trigger,
          enabled: r.enabled,
          nextRunAt: r.nextRunAt ?? null,
          lastRunAt: r.lastRunAt ?? null,
          latestRun: latest ? { id: latest.id, status: latest.status, attempt: latest.attempt } : null,
        };
      });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(rows)}\n`);
      } else if (rows.length === 0) {
        process.stdout.write('Chưa có routine v2 nào.\n');
      } else {
        process.stdout.write(
          `${rows.map((r) => `${r.id}  ${r.name}  [${r.enabled ? 'enabled' : 'disabled'}]  trigger=${r.trigger.kind}  next=${r.nextRunAt ?? '—'}  latest=${r.latestRun ? r.latestRun.status : '—'}`).join('\n')}\n`,
        );
      }
      return 0;
    }
    case 'health': {
      const botId = typeof flags['bot'] === 'string' && flags['bot'].trim() !== '' ? flags['bot'].trim() : 'local';
      // Probe nền: không chặn turn, không gọi provider — chỉ đo máy local.
      const prober = new BotComputerHealthProber({});
      prober.register({ botId });
      const health = await prober.probeOne(botId);
      if (!health) fail(`Không probe được bot "${botId}".`);
      if (asJson) {
        process.stdout.write(`${JSON.stringify(health)}\n`);
      } else {
        const lines = [
          `Bot "${health.botId}": ${health.status.toUpperCase()} (probe ${health.probeDurationMs}ms, ${health.probedAt})`,
        ];
        if (health.cpuLoad !== undefined) lines.push(`  CPU load: ${Math.round(health.cpuLoad * 100)}%`);
        if (health.memoryUsedRatio !== undefined) lines.push(`  memory used: ${Math.round(health.memoryUsedRatio * 100)}%`);
        if (health.diskUsedRatio !== undefined) lines.push(`  disk used: ${Math.round(health.diskUsedRatio * 100)}%`);
        if (health.reasons.length > 0) lines.push(`  reasons: ${health.reasons.join(' ')}`);
        process.stdout.write(`${lines.join('\n')}\n`);
      }
      return health.status === 'unhealthy' ? 2 : 0;
    }
    case 'webhook-status': {
      const tools = createHarnessV2Tools({ stateDir: dataDir });
      const tool = tools.find((t) => t.definition.name === 'harness_webhook_status');
      if (!tool) fail('Không tìm thấy tool harness_webhook_status.');
      const text = await tool.execute({}, { workspaceDir: dataDir, botId: 'cli' });
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ status: text })}\n`);
      } else {
        process.stdout.write(`${text}\n`);
      }
      return 0;
    }
    case undefined:
      fail('harness cần subcommand: routines list | health [--bot <id>] | webhook-status.');
      break;
    default:
      fail(`Không rõ lệnh harness "${sub}".`);
      break;
  }
  return 0;
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

/**
 * v1.01 (Đội T4): `open-bot memory-mcp` — MCP server cho verbatim memory.
 *
 * Mặc định stdio (để MCP client spawn trực tiếp); `--http` chạy
 * Streamable HTTP loopback. Store mở theo workspace (`--workspace`,
 * mặc định cwd) tại `<workspace>/.open-bot/verbatim`. Không cần API
 * key; `--embed` gắn Ollama local cho recall ngữ nghĩa. Mọi log ra
 * stderr — stdout là kênh JSON-RPC của MCP khi chạy stdio.
 */
async function cmdMemoryMcp(flags: CliFlags): Promise<number> {
  const workspaceRaw = flags['workspace'];
  const workspaceDir =
    typeof workspaceRaw === 'string' && workspaceRaw.trim() !== ''
      ? path.resolve(workspaceRaw.trim())
      : process.cwd();
  const backendRaw = flags['backend'];
  const backend =
    backendRaw === 'jsonl' ? 'jsonl' : backendRaw === 'sqlite' ? 'sqlite' : undefined;
  if (backendRaw !== undefined && backend === undefined) {
    fail('--backend chỉ nhận "sqlite" hoặc "jsonl".');
  }
  const readOnly = flags['read-only'] === true;
  const useEmbed = flags['embed'] === true;
  const useHttp = flags['http'] === true;
  const allowWritesHttp = flags['allow-writes'] === true;
  const portRaw = flags['port'];
  let port = 0;
  if (typeof portRaw === 'string') {
    const parsed = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      fail('--port phải là số cổng 0..65535.');
    }
    port = parsed;
  }

  let embedder: OllamaEmbeddings | undefined;
  if (useEmbed) {
    embedder = new OllamaEmbeddings();
    const available = await embedder.isAvailable();
    if (!available) {
      process.stderr.write(
        'open-bot: cảnh báo: Ollama chưa chạy — recall chạy bằng từ khoá (BM25), không có ngữ nghĩa.\n',
      );
      embedder = undefined;
    }
  }

  const opened = openVerbatimStoreForWorkspace(workspaceDir, {
    ...(backend !== undefined ? { backend } : {}),
    ...(embedder !== undefined ? { embedder } : {}),
  });
  const log = (message: string): void => {
    process.stderr.write(`open-bot: ${message}\n`);
  };
  log(
    `verbatim memory MCP: backend=${opened.backendKind} dir=${opened.dir}` +
      (opened.fallbackReason !== undefined ? ` (fallback: ${opened.fallbackReason})` : '') +
      (readOnly ? ' read-only' : '') +
      (useEmbed && embedder !== undefined ? ' embed=ollama' : ''),
  );

  try {
    if (useHttp) {
      const httpServer = await runVerbatimMemoryMcpHttp(opened.store, {
        allowWrites: allowWritesHttp,
        port,
        onLog: log,
      });
      log(`verbatim memory MCP HTTP: ${httpServer.url} (loopback only)`);
      // Giữ process sống tới khi nhận SIGINT/SIGTERM.
      await new Promise<void>((resolve) => {
        const shutdown = (): void => {
          void httpServer.close().then(() => resolve(), () => resolve());
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
      });
    } else {
      await runVerbatimMemoryMcpStdio(opened.store, {
        allowWrites: !readOnly,
        onLog: log,
      });
    }
    return 0;
  } finally {
    await opened.store.close();
  }
}

/**
 * v1.01 (Đội T4): `open-bot memory <search|list|stats|backfill>` — đọc/
 * ghi verbatim memory từ terminal. Chỉ đọc/ghi local, không cần key.
 * `--json` xuất JSON máy đọc được; mặc định in text ngắn gọn.
 */
async function cmdMemory(sub: string | undefined, positional: string[], flags: CliFlags): Promise<number> {
  const workspaceRaw = flags['workspace'];
  const workspaceDir =
    typeof workspaceRaw === 'string' && workspaceRaw.trim() !== ''
      ? path.resolve(workspaceRaw.trim())
      : process.cwd();
  const asJson = flags['json'] === true;
  const limitRaw = flags['limit'];
  let limit = 10;
  if (typeof limitRaw === 'string') {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
      fail('--limit phải là số nguyên 1..1000.');
    }
    limit = parsed;
  }
  const wingRaw = flags['wing'];
  const roomRaw = flags['room'];
  const wing = typeof wingRaw === 'string' && wingRaw.trim() !== '' ? wingRaw.trim() : undefined;
  const room = typeof roomRaw === 'string' && roomRaw.trim() !== '' ? roomRaw.trim() : undefined;

  const opened = openVerbatimStoreForWorkspace(workspaceDir);
  try {
    switch (sub) {
      case 'search': {
        const query = positional[0];
        if (query === undefined || query.trim() === '') {
          fail('memory search cần query: open-bot memory search <query>.');
        }
        let embedder: OllamaEmbeddings | undefined;
        if (flags['embed'] === true) {
          embedder = new OllamaEmbeddings();
          if (!(await embedder.isAvailable())) {
            process.stderr.write('open-bot: cảnh báo: Ollama chưa chạy — tìm bằng từ khoá (BM25).\n');
            embedder = undefined;
          }
        }
        const result = await opened.store.search(query.trim(), {
          limit,
          filter: {
            ...(wing !== undefined ? { wing } : {}),
            ...(room !== undefined ? { room } : {}),
          },
          ...(embedder !== undefined ? { embedder } : {}),
        });
        if (asJson) {
          process.stdout.write(
            `${JSON.stringify(
              {
                hits: result.hits.map((h) => ({
                  id: h.record.id,
                  text: h.record.text,
                  wing: h.record.wing,
                  room: h.record.room,
                  tags: h.record.tags,
                  createdAt: h.record.createdAt,
                  score: h.score,
                  keywordScore: h.keywordScore,
                  ...(h.semanticScore !== undefined ? { semanticScore: h.semanticScore } : {}),
                })),
                usedFallback: result.usedFallback,
                ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
                candidates: result.candidates,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          if (result.hits.length === 0) {
            process.stdout.write('Không tìm thấy memory nào.\n');
          } else {
            for (const hit of result.hits) {
              process.stdout.write(
                `• [${hit.score.toFixed(3)}] ${hit.record.wing}/${hit.record.room} — ${hit.record.text}\n`,
              );
            }
            if (result.usedFallback) {
              process.stdout.write(`(tìm theo từ khoá${result.fallbackReason !== undefined ? `: ${result.fallbackReason}` : ''})\n`);
            }
          }
        }
        return 0;
      }
      case 'list': {
        const { records, total } = await opened.store.list({
          limit,
          filter: {
            ...(wing !== undefined ? { wing } : {}),
            ...(room !== undefined ? { room } : {}),
          },
        });
        if (asJson) {
          process.stdout.write(`${JSON.stringify({ records, total }, null, 2)}\n`);
        } else if (records.length === 0) {
          process.stdout.write('Chưa có memory nguyên văn nào.\n');
        } else {
          for (const record of records) {
            process.stdout.write(`• ${record.wing}/${record.room} [${record.createdAt.slice(0, 10)}] ${record.text}\n`);
          }
          process.stdout.write(`(${records.length}/${total})\n`);
        }
        return 0;
      }
      case 'stats': {
        const stats = await opened.store.stats();
        if (asJson) {
          process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
        } else {
          process.stdout.write(
            `verbatim memory (${opened.backendKind}): ${stats.total} record, ${stats.embedded} đã embed, ` +
              `${stats.wings} wing, ${stats.rooms} room\n`,
          );
        }
        return 0;
      }
      case 'backfill': {
        const embedder = new OllamaEmbeddings();
        if (!(await embedder.isAvailable())) {
          fail('backfill cần Ollama đang chạy (model nomic-embed-text).');
        }
        const result = await opened.store.backfillEmbeddings(embedder);
        if (asJson) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(
            `backfill: đã embed ${result.embedded} record, bỏ qua ${result.skipped} (đã có vector), lỗi ${result.failed} (model ${result.model}).\n`,
          );
        }
        return 0;
      }
      case 'wakeup': {
        const queryRaw = flags['query'];
        const query = typeof queryRaw === 'string' && queryRaw.trim() !== '' ? queryRaw.trim() : undefined;
        const wake = await buildVerbatimWakeUp(opened.store, {
          ...(wing !== undefined ? { wing } : {}),
          ...(query !== undefined ? { query } : {}),
        });
        if (asJson) {
          process.stdout.write(`${JSON.stringify(wake, null, 2)}\n`);
        } else if (wake.text === '') {
          process.stdout.write('Chưa có memory nguyên văn nào để wake-up.\n');
        } else {
          process.stdout.write(`${wake.text}\n`);
        }
        return 0;
      }
      case 'prune': {
        const daysRaw = flags['older-than-days'];
        const days = typeof daysRaw === 'string' ? Number.parseInt(daysRaw, 10) : NaN;
        if (!Number.isInteger(days) || days < 1) {
          fail('memory prune cần --older-than-days N (số ngày, ≥ 1).');
        }
        const keepRaw = flags['keep-tag'];
        const keepTags: string[] =
          keepRaw === undefined
            ? []
            : Array.isArray(keepRaw)
              ? keepRaw.filter((v): v is string => typeof v === 'string')
              : typeof keepRaw === 'string'
                ? [keepRaw]
                : [];
        const deleted = await opened.store.prune({ olderThanDays: days, keepTags });
        if (asJson) {
          process.stdout.write(`${JSON.stringify({ deleted, olderThanDays: days, keepTags }, null, 2)}\n`);
        } else {
          process.stdout.write(`prune: đã xoá ${deleted} record cũ hơn ${days} ngày.\n`);
        }
        return 0;
      }
      case undefined:
        fail('memory cần subcommand: search | list | stats | backfill.');
        break;
      default:
        fail(`Không rõ lệnh memory "${sub}".`);
        break;
    }
    return 0;
  } finally {
    await opened.store.close();
  }
}

/**
 * v1.01 (Team T6): `open-bot query --prompt "..." [...]` — chạy 1 prompt
 * qua Agent SDK `query()` (agent loop trong process, không cần bot lưu
 * trong bots.json, không cần mở desktop). Text stream ra stdout khi
 * chạy (trừ --json: chỉ in JSON cuối). Exit code: 0 = xong; 1 = lỗi
 * dùng/sai tham số/config; 2 = run lỗi hoặc bị abort.
 */
async function cmdQuery(flags: CliFlags): Promise<number> {
  const prompt = flags['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    fail('query cần --prompt "...".');
  }
  const providerId =
    typeof flags['provider'] === 'string' && flags['provider'].trim() !== ''
      ? flags['provider'].trim()
      : 'mock';
  const model =
    typeof flags['model'] === 'string' && flags['model'].trim() !== ''
      ? flags['model'].trim()
      : 'mock';
  const asJson = flags['json'] === true;
  const autoApprove = flags['auto-approve'] === true;
  const maxTurnsRaw = flags['max-turns'];
  const maxTurns =
    typeof maxTurnsRaw === 'string' && Number.isFinite(Number(maxTurnsRaw)) && Number(maxTurnsRaw) > 0
      ? Math.floor(Number(maxTurnsRaw))
      : 25;
  const systemPrompt =
    typeof flags['system-prompt'] === 'string' && flags['system-prompt'].trim() !== ''
      ? flags['system-prompt']
      : undefined;
  const mockResponse =
    typeof flags['mock-response'] === 'string' && flags['mock-response'].trim() !== ''
      ? flags['mock-response']
      : 'mock reply';
  let provider;
  if (providerId === 'mock') {
    provider = createMockProvider([{ text: mockResponse }]);
  } else {
    const apiKey = apiKeyFromEnv(providerId);
    if (!apiKey) {
      fail(
        `Provider "${providerId}" cần key: đặt env OPENBOT_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY.`,
      );
    }
    provider = createProvider({
      id: providerId,
      label: providerId,
      apiKey,
      defaultModel: model,
    });
  }
  try {
    const handle = query(prompt, {
      provider,
      model,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      maxTurns,
      autoApprove,
      workspaceDir: process.cwd(),
    });
    // Stream text ngay khi có (trừ --json: chỉ in JSON cuối để stdout
    // parse được).
    const stream = (async (): Promise<void> => {
      for await (const event of handle) {
        if (!asJson && event.type === 'text') process.stdout.write(event.text);
      }
    })();
    const result = await handle.result();
    await stream;
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write('\n');
    }
    if (result.aborted) {
      process.stderr.write('open-bot: query bị abort.\n');
      return 2;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`open-bot: query lỗi: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

/**
 * v1.01 (T2): `open-bot hooks <list|test|log|gate>`.
 *
 * Chỉ đọc/ghi file trạng thái hook trong <dataDir> (cùng tên file
 * coordinator dùng: hooks-commands.json, hooks-test-gate.json,
 * hook-executions.jsonl) — không chạy bot, không chạm provider, không
 * đọc Vault. `test` chạy thử 1 hook lệnh với event mẫu (xem
 * testRunHookCommand): lệnh thật được spawn, nhưng payload là mẫu
 * chỉ-đọc nên không có tool thật hay subagent thật nào chạy.
 */
async function cmdHooks(
  sub: string | undefined,
  positional: string[],
  flags: CliFlags,
): Promise<number> {
  const dataDir = resolveDataDir(flags);
  const asJson = flags['json'] === true;

  const loadCommands = (): HookCommandSettingsEntry[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        fs.readFileSync(path.join(dataDir, HOOK_COMMANDS_FILE), 'utf8'),
      );
    } catch {
      return [];
    }
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { commands?: unknown } | null)?.commands ?? []);
    if (!Array.isArray(list)) return [];
    const out: HookCommandSettingsEntry[] = [];
    for (const raw of list) {
      const result = validateHookCommandEntry(raw);
      if (result.valid && result.entry) out.push(result.entry);
    }
    return out;
  };

  switch (sub) {
    case 'list': {
      const commands = loadCommands();
      const gate = readTestGateConfig(dataDir);
      const gateCommands = testGateCommands(gate);
      if (asJson) {
        process.stdout.write(
          `${JSON.stringify({ commands, testGate: gate ?? {} })}\n`,
        );
      } else if (commands.length === 0) {
        process.stdout.write(
          `Chưa có hook lệnh nào trong ${path.join(dataDir, HOOK_COMMANDS_FILE)}.\n`,
        );
        if (gateCommands.length > 0) {
          process.stdout.write(`Test gate: ${gateCommands.join(' → ')}\n`);
        }
      } else {
        const lines = commands.map(
          (c) =>
            `${c.name}  [${c.enabled === false ? 'disabled' : 'enabled'}]  ${c.events.join(',')}  timeout=${c.timeoutMs ?? 10000}ms\n  ${c.command}${c.description ? `\n  ${c.description}` : ''}`,
        );
        process.stdout.write(`${lines.join('\n')}\n`);
        if (gateCommands.length > 0) {
          process.stdout.write(`Test gate: ${gateCommands.join(' → ')}\n`);
        }
      }
      return 0;
    }
    case 'test': {
      const name = positional[0];
      if (!name) {
        fail('hooks test cần tên hook: open-bot hooks test <name> [--event <Event>].');
      }
      const commands = loadCommands();
      const entry = commands.find((c) => c.name === name);
      if (!entry) {
        fail(`Không tìm thấy hook lệnh "${name}" trong ${path.join(dataDir, HOOK_COMMANDS_FILE)}.`);
      }
      const eventFlag = flags['event'];
      let event: HookEventKind | undefined;
      if (typeof eventFlag === 'string' && eventFlag.trim() !== '') {
        const wanted = eventFlag.trim() as HookEventKind;
        if (!ALL_HOOK_EVENTS.includes(wanted)) {
          fail(
            `Event không hợp lệ: "${eventFlag}". Event hợp lệ: ${ALL_HOOK_EVENTS.join(', ')}.`,
          );
        }
        event = wanted;
      }
      let result;
      try {
        result = await testRunHookCommand(entry, {
          ...(event ? { event } : {}),
          workspaceDir: dataDir,
        });
      } catch (err) {
        fail(`Không chạy thử được hook "${name}": ${err instanceof Error ? err.message : String(err)}`);
      }
      if (asJson) {
        process.stdout.write(`${JSON.stringify(result)}\\n`);
      } else {
        const lines = [
          `Hook "${result.name}" (${result.event}, ${result.durationMs}ms, cwd ${result.cwd}):`,
          result.ok
            ? `  decision: ${result.decision?.action ?? 'allow'}${result.decision?.reason ? ` — ${result.decision.reason}` : ''}`
            : `  ERROR: ${result.error ?? 'hook failed'}`,
          `  exit: ${result.exitCode === null ? `signal ${result.signal ?? '?'}` : result.exitCode}${result.timedOut ? ' (timeout)' : ''}`,
        ];
        if (result.stdout.trim()) lines.push(`  stdout:\n${result.stdout.trim()}`);
        if (result.stderr.trim()) lines.push(`  stderr:\n${result.stderr.trim()}`);
        process.stdout.write(`${lines.join('\n')}\n`);
      }
      return result.ok ? 0 : 1;
    }
    case 'log': {
      const limitRaw = flags['limit'];
      const limit =
        typeof limitRaw === 'string' && Number.isFinite(Number(limitRaw))
          ? Math.max(1, Math.min(500, Math.floor(Number(limitRaw))))
          : 50;
      const records = readHookLogFile(
        path.join(dataDir, 'hook-executions.jsonl'),
        limit,
      );
      if (flags['summary'] === true) {
        const perHook = summarizeHookLogRecords(records);
        const totals = {
          total: records.length,
          blocks: records.filter((r) => r.action === 'block').length,
          errors: records.filter((r) => r.action === 'error').length,
          timeouts: records.filter((r) => r.timedOut).length,
        };
        if (asJson) {
          process.stdout.write(`${JSON.stringify({ totals, perHook })}\n`);
        } else if (records.length === 0) {
          process.stdout.write('Chưa có lần hook chạy nào được ghi.\n');
        } else {
          const lines = [
            `Tổng: ${totals.total} lần chạy · ${totals.blocks} block · ${totals.errors} lỗi · ${totals.timeouts} timeout`,
            ...perHook.map(
              (s) =>
                `${s.hookName}  ${s.total} lần · ${s.blocks} block · ${s.errors} lỗi · ${s.timeouts} timeout · trung bình ${s.avgDurationMs}ms${s.lastAt ? ` · mới nhất ${s.lastAt}` : ''}`,
            ),
          ];
          process.stdout.write(`${lines.join('\n')}\n`);
        }
        return 0;
      }
      if (asJson) {
        process.stdout.write(`${JSON.stringify(records)}\n`);
      } else if (records.length === 0) {
        process.stdout.write('Chưa có lần hook chạy nào được ghi.\n');
      } else {
        process.stdout.write(
          `${records
            .map(
              (r) =>
                `${r.at}  ${r.hookName}  ${r.event}  ${r.action}  ${r.durationMs}ms${r.timedOut ? '  timeout' : ''}${r.reason ? `  — ${r.reason}` : ''}${r.error ? `  — ${r.error}` : ''}`,
            )
            .join('\n')}\n`,
        );
      }
      return 0;
    }
    case 'gate': {
      const gate = readTestGateConfig(dataDir);
      const gateCommands = testGateCommands(gate);
      if (asJson) {
        process.stdout.write(`${JSON.stringify(gate ?? {})}\n`);
      } else if (gateCommands.length === 0) {
        process.stdout.write(
          'Test gate chưa cấu hình (file hooks-test-gate.json không có lệnh kiểm tra).\n',
        );
      } else {
        process.stdout.write(
          `Test gate (${gateCommands.length} lệnh, chạy tuần tự, dừng ở lệnh fail đầu tiên):\n${gateCommands.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}${gate?.timeoutMs !== undefined ? `\nTimeout mỗi lệnh: ${gate.timeoutMs}ms` : ''}\n`,
        );
      }
      return 0;
    }
    case 'validate': {
      const issues = validateHookSettingsFiles(dataDir);
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ valid: issues.length === 0, issues })}\n`);
      } else if (issues.length === 0) {
        process.stdout.write('Cấu hình hooks hợp lệ (không có lỗi).\n');
      } else {
        process.stdout.write(
          `Cấu hình hooks có ${issues.length} lỗi:\n${issues.map((i) => `  ${i.field}: ${i.message}`).join('\n')}\n`,
        );
      }
      return issues.length === 0 ? 0 : 1;
    }
    case undefined:
      fail('hooks cần subcommand: list | test <name> [--event <Event>] | log [--limit N] [--summary] | gate | validate.');
      break;
    default:
      fail(`Không rõ lệnh hooks "${sub}".`);
      break;
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
  if (cmd === 'query') {
    return cmdQuery(flags);
  }
  if (cmd === 'run') {
    return cmdRun(flags);
  }
  if (cmd === 'harness') {
    return cmdHarness(sub, positional.slice(2), flags);
  }
  if (cmd === 'fleet') {
    return cmdFleet(sub, positional.slice(2), flags);
  }
  if (cmd === 'risk') {
    return cmdRisk(sub, positional.slice(2), flags);
  }
  if (cmd === 'hooks') {
    return cmdHooks(sub, positional.slice(2), flags);
  }
  if (cmd === 'team' && sub === 'apply') {
    return cmdTeamApply(positional.slice(2), flags);
  }
  if (cmd === 'team') {
    fail('team chỉ hỗ trợ "apply": open-bot team apply <file.json>.');
  }
  if (cmd === 'memory-mcp') {
    return cmdMemoryMcp(flags);
  }
  if (cmd === 'memory') {
    return cmdMemory(sub, positional.slice(2), flags);
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

/**
 * Lệnh `risk` (v1.01, Đội T3) — risk budget từ terminal, không cần mở app.
 *
 *  - `risk check` chấm risk cho 1 tool call (dùng rule custom trong
 *    <dataDir>/risk-rules.json + rule built-in) rồi in đánh giá + quyết
 *    định của policy. CHỈ CHẤM, không chạy tool — an toàn để thử rule.
 *  - `risk rules list|add|remove` quản lý rule custom (file risk-rules.json).
 *  - `risk allow|deny add|remove <entry>` quản lý allowlist/denylist
 *    (entry: `tool` hoặc `tool:regex` — denylist thắng allowlist).
 *  - `risk budget list|totals` đọc <dataDir>/budget-history.json (lịch
 *    sử budget coordinator đã ghi sau mỗi run).
 *
 * Exit code: 0 = xong (kể cả khi assessment là high/denied — đó là kết
 * quả chấm, không phải lỗi); 1 = lỗi dùng/sai tham số/file.
 */
function cmdRisk(sub: string | undefined, positional: string[], flags: CliFlags): number {
  const dataDir = resolveDataDir(flags);
  const asJson = flags['json'] === true;
  const out = (obj: unknown, text: string): void => {
    process.stdout.write(asJson ? `${JSON.stringify(obj)}\n` : text);
  };
  const store = new RiskRuleStore(dataDir);
  const group = positional[0];

  if (sub === 'check') {
    const tool = typeof flags['tool'] === 'string' ? flags['tool'] : '';
    if (!tool) fail('risk check cần --tool <tên tool>.');
    let args: Record<string, unknown> = {};
    if (typeof flags['args'] === 'string' && flags['args'].trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(flags['args']);
        if (!isRecord(parsed)) fail('--args phải là JSON object.');
        args = parsed;
      } catch (err) {
        fail(`--args không phải JSON hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const workspaceDir = typeof flags['workspace'] === 'string' ? flags['workspace'] : undefined;
    const policy = parseConfirmationPolicy(flags['policy']);
    const analyzer = new RiskAnalyzer(store.toAnalyzerOptions());
    const assessment = analyzer.analyze(tool, args, workspaceDir ? { workspaceDir } : {});
    // Denylist → loop chặn cứng, không hỏi duyệt (policy không áp dụng).
    const decision = assessment.denied
      ? { needsConfirmation: false, reason: 'Denylist — loop chặn cứng, không hỏi duyệt.' }
      : decideConfirmation(policy, assessment);
    const result = {
      tool,
      args,
      risk: assessment,
      policy,
      needsConfirmation: decision.needsConfirmation,
      reason: decision.reason,
    };
    if (asJson) {
      out(result, '');
    } else {
      const lines = [
        `tool: ${tool}`,
        `risk: ${assessment.level} (${assessment.score}/100)`,
        ...assessment.reasons.map((r) => `  - ${r}`),
        ...(assessment.matchedRuleIds.length > 0 ? [`rules: ${assessment.matchedRuleIds.join(', ')}`] : []),
        ...(assessment.denied
          ? ['BỊ CHẶN (denylist — loop chặn cứng, tool sẽ không chạy)']
          : [
              `policy: ${policy} → ${decision.needsConfirmation ? 'CẦN DUYỆT' : 'chạy ngay không hỏi'}`,
              `  ${decision.reason}`,
            ]),
      ];
      out(result, `${lines.join('\n')}\n`);
    }
    return 0;
  }

  if (sub === 'rules') {
    if (group === 'list') {
      const rules = store.listRules();
      const payload = {
        file: store.path,
        rules,
        disabledBuiltinRuleIds: store.listDisabledBuiltinRuleIds(),
      };
      if (asJson) {
        out(payload, '');
      } else {
        const lines = [`risk rules (${store.path ?? 'chỉ trong bộ nhớ'}): ${rules.length} rule custom`];
        for (const r of rules) {
          lines.push(`  ${r.id} [${r.level} ${r.score}] ${r.description}`);
        }
        const disabled = store.listDisabledBuiltinRuleIds();
        if (disabled.length > 0) lines.push(`built-in đã tắt: ${disabled.join(', ')}`);
        out(payload, `${lines.join('\n')}\n`);
      }
      return 0;
    }
    if (group === 'add') {
      const id = typeof flags['id'] === 'string' ? flags['id'].trim() : '';
      const level = typeof flags['level'] === 'string' ? flags['level'].trim() : '';
      const scoreRaw = typeof flags['score'] === 'string' ? Number(flags['score']) : NaN;
      const description = typeof flags['description'] === 'string' ? flags['description'].trim() : '';
      if (!id || !description) fail('risk rules add cần --id <id> --description <text>.');
      if (level !== 'low' && level !== 'medium' && level !== 'high') {
        fail('risk rules add cần --level low|medium|high.');
      }
      if (!Number.isFinite(scoreRaw) || scoreRaw < 0 || scoreRaw > 100) {
        fail('risk rules add cần --score 0–100.');
      }
      const rule: RiskRule = {
        id,
        description,
        level,
        score: Math.floor(scoreRaw),
        ...(typeof flags['tool'] === 'string' && flags['tool'].trim() ? { tool: flags['tool'].trim() } : {}),
        ...(typeof flags['tool-pattern'] === 'string' && flags['tool-pattern'].trim()
          ? { toolPattern: flags['tool-pattern'].trim() }
          : {}),
        ...(typeof flags['args-pattern'] === 'string' && flags['args-pattern'].trim()
          ? { argsPattern: flags['args-pattern'].trim() }
          : {}),
        ...(typeof flags['args-key'] === 'string' && flags['args-key'].trim()
          ? { argsKey: flags['args-key'].trim() }
          : {}),
      };
      try {
        const saved = store.addRule(rule);
        out({ ok: true, rule: saved }, `Đã lưu rule "${saved.id}" [${saved.level} ${saved.score}].\n`);
      } catch (err) {
        fail(`Không lưu được rule: ${err instanceof Error ? err.message : String(err)}`);
      }
      return 0;
    }
    if (group === 'remove') {
      const id = typeof flags['id'] === 'string' ? flags['id'].trim() : '';
      if (!id) fail('risk rules remove cần --id <id>.');
      const removed = store.removeRule(id);
      out({ ok: removed, id }, removed ? `Đã xoá rule "${id}".\n` : `Không có rule "${id}".\n`);
      return 0;
    }
    fail('risk rules cần subcommand: list | add | remove.');
    return 1;
  }

  if (sub === 'allow' || sub === 'deny') {
    const action = group;
    const entry = positional[1];
    if (action !== 'add' && action !== 'remove') {
      fail(`risk ${sub} cần add|remove: open-bot risk ${sub} add <entry>.`);
    }
    if (!entry) fail(`risk ${sub} ${action} cần <entry> (tool hoặc tool:regex).`);
    try {
      const changed =
        sub === 'allow'
          ? action === 'add'
            ? store.addAllowlist(entry)
            : store.removeAllowlist(entry)
          : action === 'add'
            ? store.addDenylist(entry)
            : store.removeDenylist(entry);
      out(
        { ok: true, changed, list: sub, entry },
        changed
          ? `Đã ${action === 'add' ? 'thêm vào' : 'xoá khỏi'} ${sub}list: ${entry}\n`
          : `Không đổi (${entry} đã ${action === 'add' ? 'có trong' : 'không có trong'} ${sub}list).\n`,
      );
    } catch (err) {
      fail(`${sub}list: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 0;
  }

  if (sub === 'budget') {
    const history = new ConversationBudgetHistory(dataDir);
    const botId = typeof flags['bot'] === 'string' ? flags['bot'] : undefined;
    if (group === 'list') {
      const entries = botId ? history.listForBot(botId) : history.listAll();
      if (asJson) {
        out({ file: history.path, entries }, '');
      } else {
        const lines = [`budget history (${history.path ?? 'chỉ trong bộ nhớ'}): ${entries.length} conversation`];
        for (const e of entries) {
          const cost = e.costUsd === null ? '?' : `$${e.costUsd.toFixed(4)}`;
          lines.push(
            `  ${e.conversationId} bot=${e.botId} model=${e.model ?? '?'} tokens=${e.totalTokens} cost=${cost} status=${e.status}`,
          );
        }
        out({ entries }, `${lines.join('\n')}\n`);
      }
      return 0;
    }
    if (group === 'totals') {
      if (!botId) {
        const totals = history.totalsAll();
        out(
          { ...totals },
          `tất cả bot: ${totals.conversations} conversation, ${totals.totalTokens} token, ` +
            `cost ${totals.totalCostUsd === null ? '?' : `$${totals.totalCostUsd.toFixed(4)}`}, ` +
            `warning ${totals.warningCount}, exceeded ${totals.exceededCount}\n`,
        );
        return 0;
      }
      const totals = history.totalsForBot(botId);
      out(
        { ...totals },
        `bot ${botId}: ${totals.conversations} conversation, ${totals.totalTokens} token, ` +
          `cost ${totals.totalCostUsd === null ? '?' : `$${totals.totalCostUsd.toFixed(4)}`}, ` +
          `warning ${totals.warningCount}, exceeded ${totals.exceededCount}\n`,
      );
      return 0;
    }
    fail('risk budget cần subcommand: list | totals.');
    return 1;
  }

  fail('risk cần subcommand: check | rules list|add|remove | allow|deny add|remove | budget list|totals.');
  return 1;
}


main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`open-bot: lỗi: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
