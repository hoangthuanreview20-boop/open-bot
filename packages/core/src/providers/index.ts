/**
 * Provider registry: builds a Provider from a ProviderConfig and exposes
 * the metadata the UI needs to render the provider picker.
 */

import type { Provider, ProviderConfig } from '../types';
import { throwIfAborted } from './abort';
export {
  createAbortController,
  isAbortError,
  throwIfAborted,
  withTimeout,
} from './abort';
export type { AbortableRequest, WithTimeoutResult } from './abort';
import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './anthropic';
import {
  AiderCliProvider,
  AIDER_MODEL_ID,
  AIDER_PROVIDER_ID,
  AmazonQCliProvider,
  AMAZON_Q_MODEL_ID,
  AMAZON_Q_PROVIDER_ID,
  ClaudeCodeCliProvider,
  CLAUDE_CODE_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  CodexCliProvider,
  CODEX_MODEL_ID,
  CODEX_PROVIDER_ID,
  ContinueCliProvider,
  CONTINUE_CLI_MODEL_ID,
  CONTINUE_CLI_PROVIDER_ID,
  CopilotCliProvider,
  COPILOT_CLI_MODEL_ID,
  COPILOT_CLI_PROVIDER_ID,
  CursorCliProvider,
  CURSOR_CLI_MODEL_ID,
  CURSOR_CLI_PROVIDER_ID,
  CustomAcpCliProvider,
  CUSTOM_ACP_MODEL_ID,
  CUSTOM_ACP_PROVIDER_ID,
  GeminiCliProvider,
  GEMINI_CLI_MODEL_ID,
  GEMINI_CLI_PROVIDER_ID,
  GrokCliProvider,
  GROK_CLI_MODEL_ID,
  GROK_CLI_PROVIDER_ID,
  KiroCliProvider,
  KIRO_CLI_MODEL_ID,
  KIRO_CLI_PROVIDER_ID,
  OpenCodeCliProvider,
  OPENCODE_MODEL_ID,
  OPENCODE_PROVIDER_ID,
  WindsurfCliProvider,
  WINDSURF_MODEL_ID,
  WINDSURF_PROVIDER_ID,
} from './cli/index';
import { GeminiProvider, GEMINI_DEFAULT_MODEL } from './gemini';
import { OllamaProvider, OLLAMA_BASE_URL, OLLAMA_DEFAULT_MODEL } from './ollama';
import { OpenAIProvider, OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL } from './openai';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { XAI_BASE_URL, XAI_DEFAULT_MODEL, XAIProvider } from './xai';
import {
  COMPATIBLE_PRESETS,
  listCompatiblePresets,
  resolvePreset,
} from '../models/presets';
import type { CompatiblePreset } from '../models/presets';

export { COMPATIBLE_PRESETS, listCompatiblePresets, resolvePreset };
export type { CompatiblePreset };

export { AnthropicProvider } from './anthropic';
export {
  AcpClient,
  ACP_PROTOCOL_VERSION,
  AiderCliProvider,
  AIDER_MODEL_ID,
  AIDER_PROVIDER_ID,
  AmazonQCliProvider,
  AMAZON_Q_MODEL_ID,
  AMAZON_Q_PROVIDER_ID,
  BaseAcpCliProvider,
  ACP_CLI_DEFAULT_TIMEOUT_MS,
  BaseOneShotCliProvider,
  ONE_SHOT_CLI_DEFAULT_TIMEOUT_MS,
  ClaudeCodeCliProvider,
  CLAUDE_CODE_MODEL_ID,
  CLAUDE_CODE_PROVIDER_ID,
  CodexAppServerClient,
  CodexCliProvider,
  CODEX_MODEL_ID,
  CODEX_PROVIDER_ID,
  ContinueCliProvider,
  CONTINUE_CLI_MODEL_ID,
  CONTINUE_CLI_PROVIDER_ID,
  CopilotCliProvider,
  COPILOT_CLI_MODEL_ID,
  COPILOT_CLI_PROVIDER_ID,
  CursorCliProvider,
  CURSOR_CLI_MODEL_ID,
  CURSOR_CLI_PROVIDER_ID,
  CustomAcpCliProvider,
  CUSTOM_ACP_MODEL_ID,
  CUSTOM_ACP_PROVIDER_ID,
  GeminiCliProvider,
  GEMINI_CLI_MODEL_ID,
  GEMINI_CLI_PROVIDER_ID,
  GrokCliProvider,
  GROK_CLI_MODEL_ID,
  GROK_CLI_PROVIDER_ID,
  JsonRpcResponseError,
  JsonRpcStdioClient,
  KiroCliProvider,
  KIRO_CLI_MODEL_ID,
  KIRO_CLI_PROVIDER_ID,
  OpenCodeCliProvider,
  OPENCODE_MODEL_ID,
  OPENCODE_PROVIDER_ID,
  WindsurfCliProvider,
  WINDSURF_MODEL_ID,
  WINDSURF_PROVIDER_ID,
} from './cli/index';
export type {
  AcpClientOptions,
  AcpCliProviderIdentity,
  AcpCliProviderOptions,
  AcpPromptResult,
  AcpStopReason,
  AiderCliProviderOptions,
  AmazonQCliProviderOptions,
  ClaudeCodeCliProviderOptions,
  CodexAppServerClientOptions,
  CodexCliProviderOptions,
  CodexTurnResult,
  ContinueCliProviderOptions,
  CopilotCliProviderOptions,
  CursorCliProviderOptions,
  CustomAcpCliProviderOptions,
  GeminiCliProviderOptions,
  GrokCliProviderOptions,
  JsonRpcClientOptions,
  JsonRpcStats,
  KiroCliProviderOptions,
  OneShotCliProviderIdentity,
  OneShotCliProviderOptions,
  OpenCodeCliProviderOptions,
  WindsurfCliProviderOptions,
} from './cli/index';
export { GeminiProvider } from './gemini';
export { OllamaProvider, OLLAMA_BASE_URL, OLLAMA_DEFAULT_MODEL } from './ollama';
export type { OllamaLocalModelInfo } from './ollama';
export { OpenAIProvider } from './openai';
export { OpenAICompatibleProvider } from './openaiCompatible';
export { XAIProvider } from './xai';

export interface ProviderMeta {
  id: string;
  label: string;
  defaultModel: string;
  /** True when the user must supply their own API key for this provider. */
  needsKey: boolean;
  defaultBaseUrl: string;
  /**
   * v0.5: well-known presets for the 'openai-compatible' provider
   * (DeepSeek, Qwen, Mistral, Together, Groq, OpenRouter). Picking a
   * preset fills baseUrl + defaultModel; the user still supplies
   * their own key in the Vault.
   */
  presets?: CompatiblePreset[];
  /**
   * M1: 'cli' = provider chạy qua CLI đã đăng nhập trên máy user
   * (không cần API key, cần detector + opt-in); mặc định 'api'.
   */
  kind?: 'api' | 'cli';
  /** M1: kind của detected engine tương ứng (vd 'claude' cho claude-code). */
  detectedKind?: string;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: OPENAI_DEFAULT_MODEL,
    needsKey: true,
    defaultBaseUrl: OPENAI_BASE_URL,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    needsKey: true,
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    defaultModel: GEMINI_DEFAULT_MODEL,
    needsKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  {
    id: 'xai',
    label: 'xAI',
    defaultModel: XAI_DEFAULT_MODEL,
    needsKey: true,
    defaultBaseUrl: XAI_BASE_URL,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultModel: OLLAMA_DEFAULT_MODEL,
    needsKey: false,
    defaultBaseUrl: OLLAMA_BASE_URL,
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible (tùy chỉnh)',
    defaultModel: '',
    needsKey: false,
    defaultBaseUrl: '',
    presets: [...COMPATIBLE_PRESETS],
  },
  {
    id: CLAUDE_CODE_PROVIDER_ID,
    label: 'Claude Code (CLI)',
    defaultModel: CLAUDE_CODE_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'claude',
  },
  {
    id: CODEX_PROVIDER_ID,
    label: 'Codex (CLI)',
    defaultModel: CODEX_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'codex',
  },
  {
    id: GROK_CLI_PROVIDER_ID,
    label: 'Grok CLI',
    defaultModel: GROK_CLI_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'grok',
  },
  {
    id: OPENCODE_PROVIDER_ID,
    label: 'OpenCode (CLI)',
    defaultModel: OPENCODE_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'opencode',
  },
  {
    id: GEMINI_CLI_PROVIDER_ID,
    label: 'Gemini CLI',
    defaultModel: GEMINI_CLI_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'gemini',
  },
  {
    id: CURSOR_CLI_PROVIDER_ID,
    label: 'Cursor CLI',
    defaultModel: CURSOR_CLI_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'cursor',
  },
  {
    // M3: CLI ACP tuỳ chỉnh — provider id duy nhất; bot nào dùng CLI
    // nào phân biệt bằng model (= slug). detectedKind là tiền tố
    // 'custom-acp' (kind đầy đủ là `custom-acp:<slug>`); main process
    // resolve slug riêng trong providerConfigFor, không dùng nhánh
    // generic dưới đây.
    id: CUSTOM_ACP_PROVIDER_ID,
    label: 'Custom ACP CLI',
    defaultModel: CUSTOM_ACP_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'custom-acp',
  },
  {
    // M4 (sóng B): Aider — one-shot `--message`; auth bằng API key
    // của user (detector 'env-present'), không có tài khoản đăng nhập.
    id: AIDER_PROVIDER_ID,
    label: 'Aider (CLI)',
    defaultModel: AIDER_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'aider',
  },
  {
    // M4 (sóng B): Continue CLI — one-shot `-p` (EXPERIMENTAL, cờ
    // chưa được docs chính thức xác nhận đầy đủ).
    id: CONTINUE_CLI_PROVIDER_ID,
    label: 'Continue CLI',
    defaultModel: CONTINUE_CLI_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'continue',
  },
  {
    // M4 (sóng B): Amazon Q CLI — one-shot `chat --no-interactive`.
    id: AMAZON_Q_PROVIDER_ID,
    label: 'Amazon Q CLI',
    defaultModel: AMAZON_Q_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'amazonq',
  },
  {
    // M4 (sóng B): GitHub Copilot CLI — ACP `copilot --acp --stdio`
    // (public preview).
    id: COPILOT_CLI_PROVIDER_ID,
    label: 'GitHub Copilot CLI',
    defaultModel: COPILOT_CLI_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'copilot',
  },
  {
    // M4 (sóng B): Windsurf — ACP `devin acp` (Devin CLI, binary
    // `devin`; EXPERIMENTAL). Trạng thái detector là 'unknown' nên
    // main process cho phép dùng khi user đã bật nguồn (xem
    // providerConfigFor).
    id: WINDSURF_PROVIDER_ID,
    label: 'Windsurf (CLI)',
    defaultModel: WINDSURF_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'windsurf',
  },
  {
    // v0.76: Kiro CLI — kế tiếp của Amazon Q CLI — one-shot
    // `chat --no-interactive` (prompt là đối số vị trí, xem kiroCli.ts).
    id: KIRO_CLI_PROVIDER_ID,
    label: 'Kiro CLI',
    defaultModel: KIRO_CLI_MODEL_ID,
    needsKey: false,
    defaultBaseUrl: '',
    kind: 'cli',
    detectedKind: 'kiro',
  },
];

/**
 * v0.15: bọc `chat()` bằng kiểm tra hủy trước khi gọi — mọi provider đi
 * qua `createProvider` đều reject ngay khi `req.signal` đã hủy, kể cả
 * provider chưa tự nối signal xuống fetch (Anthropic/Gemini, xem báo
 * cáo v0.15 item 7). Hủy GIỮA CHỪNG chỉ có tác dụng với provider đã nối
 * signal vào fetch (họ OpenAI-compatible: openai/ollama/xai/
 * openai-compatible — xem `openaiCompatible.ts`); provider khác vẫn
 * chạy hết lần fetch hiện tại rồi mới dừng ở step sau (do loop kiểm tra).
 * Không có signal = hành vi cũ. Chỉ bọc `chat`, giữ nguyên object
 * provider (không mất method riêng như `OllamaProvider.pullModel`).
 */
function wrapChatWithAbortCheck(provider: Provider): Provider {
  const originalChat = provider.chat.bind(provider);
  provider.chat = async (req) => {
    throwIfAborted(req.signal);
    return originalChat(req);
  };
  return provider;
}

/** Build a Provider from a stored config. Throws on an unknown provider id. */
export function createProvider(config: ProviderConfig): Provider {
  let provider: Provider;
  switch (config.id) {
    case 'openai':
      provider = new OpenAIProvider(config);
      break;
    case 'anthropic':
      provider = new AnthropicProvider(config);
      break;
    case 'gemini':
      provider = new GeminiProvider(config);
      break;
    case 'xai':
      provider = new XAIProvider(config);
      break;
    case 'ollama':
      provider = new OllamaProvider(config);
      break;
    case 'openai-compatible':
      provider = new OpenAICompatibleProvider(config);
      break;
    case CLAUDE_CODE_PROVIDER_ID:
      // M1: CLI driver — binaryPath bắt buộc (do detector tìm thấy);
      // constructor throw khi trống (fail-closed, không đoán PATH).
      provider = new ClaudeCodeCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case CODEX_PROVIDER_ID:
      // M2: CLI driver Codex (app-server JSON-RPC) — binaryPath bắt
      // buộc như claude-code; constructor throw khi trống (fail-closed).
      provider = new CodexCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case GROK_CLI_PROVIDER_ID:
      // M2: CLI driver Grok (ACP) — binaryPath bắt buộc như claude-code.
      provider = new GrokCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case OPENCODE_PROVIDER_ID:
      // M3: CLI driver OpenCode (ACP `opencode acp`) — binaryPath bắt
      // buộc như grok-cli; constructor throw khi trống (fail-closed).
      provider = new OpenCodeCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case GEMINI_CLI_PROVIDER_ID:
      // M3: CLI driver Gemini CLI (ACP `gemini --acp`, fallback
      // `--experimental-acp` cho bản cũ) — binaryPath bắt buộc.
      provider = new GeminiCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case CURSOR_CLI_PROVIDER_ID:
      // M3: CLI driver Cursor CLI (ACP `cursor-agent acp` + bước
      // authenticate `cursor_login`) — binaryPath bắt buộc.
      provider = new CursorCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case CUSTOM_ACP_PROVIDER_ID:
      // M3: CLI ACP tuỳ chỉnh — binaryPath + acpArgs (argv ACP do user
      // khai báo) đều bắt buộc; thiếu thì constructor throw
      // (fail-closed). Binary/args do main process resolve từ registry
      // (providerConfigFor) theo slug = config.defaultModel.
      provider = new CustomAcpCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        acpArgs: config.cliArgs ?? [],
        cwd: config.cliCwd,
      });
      break;
    case AIDER_PROVIDER_ID:
      // M4 (sóng B): Aider — one-shot `--message` (+ `--yes-always`,
      // `--no-auto-commits`, `--no-pretty`); binaryPath bắt buộc.
      provider = new AiderCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case CONTINUE_CLI_PROVIDER_ID:
      // M4 (sóng B): Continue CLI — one-shot `-p` (EXPERIMENTAL);
      // binaryPath bắt buộc.
      provider = new ContinueCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case AMAZON_Q_PROVIDER_ID:
      // M4 (sóng B): Amazon Q CLI — one-shot `chat --no-interactive
      // --input`; binaryPath bắt buộc.
      provider = new AmazonQCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case COPILOT_CLI_PROVIDER_ID:
      // M4 (sóng B): GitHub Copilot CLI — ACP `copilot --acp
      // --stdio`; binaryPath bắt buộc.
      provider = new CopilotCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case WINDSURF_PROVIDER_ID:
      // M4 (sóng B): Windsurf — ACP `devin acp` (binary bắt buộc là
      // `devin`; constructor từ chối launcher của editor).
      provider = new WindsurfCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    case KIRO_CLI_PROVIDER_ID:
      // v0.76: Kiro CLI — one-shot `chat --no-interactive <prompt>`
      // (prompt vị trí, không `--input`); binaryPath bắt buộc.
      provider = new KiroCliProvider(config, {
        binaryPath: config.cliBinary ?? '',
        cwd: config.cliCwd,
      });
      break;
    default:
      throw new Error(`Không rõ provider id: ${config.id}`);
  }
  return wrapChatWithAbortCheck(provider);
}
