/**
 * MCP prompts + resources subscribe/templates + completion
 * (MCP spec 2025-11-25 — các method client đã có từ bản 2024-11-05
 * nhưng open-bot chưa implement).
 *
 *  - prompts: `prompts/list` + `prompts/get` (trả prompt đã render
 *    argument thành messages; argument bắt buộc được kiểm tra trước).
 *  - resources subscribe: `resources/subscribe` + `resources/unsubscribe`,
 *    nhận `notifications/resources/updated` qua `ResourceWatcher`
 *    (theo dõi thay đổi resource; cần transport có `onNotification` —
 *    dispatcher W5a nối sau khi client nhận được notification).
 *  - resources templates: `resources/templates/list`.
 *  - completion: `completion/complete` — gợi ý giá trị cho argument
 *    của prompt hoặc resource template.
 *
 * Module chỉ cần một transport tối thiểu (`request` + `onNotification`
 * tuỳ chọn) — điều phối viên nối client MCP thật vào sau (không sửa
 * `client.ts` ở đây).
 */

/** Transport tối thiểu mà module prompts cần. */
export interface McpRpcTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * Đăng ký nhận notification do server gửi (vd
   * `notifications/resources/updated`). Trả hàm huỷ đăng ký.
   * Không có nghĩa là transport không nhận notification — khi đó
   * `ResourceWatcher` báo lỗi rõ ràng thay vì lặng lẽ không hoạt động.
   */
  onNotification?: (handler: (method: string, params: unknown) => void) => () => void;
}

/** Lỗi parse/validate ở tầng prompts/resources/completion. */
export class PromptsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptsError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Gộp các content block của một prompt message thành text thuần. */
export function promptContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!isRecord(block)) {
      parts.push(JSON.stringify(block));
      continue;
    }
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'] as string);
    } else if (block['type'] === 'resource' && typeof block['text'] === 'string') {
      parts.push(block['text'] as string);
    } else if (block['type'] === 'resource' && typeof block['uri'] === 'string') {
      parts.push(`[resource: ${block['uri'] as string}]`);
    } else if (block['type'] === 'image') {
      parts.push('[image content — not shown as text]');
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Một argument của prompt template. */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** Một prompt template do server cung cấp (`prompts/list`). */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

/** Một message trong prompt đã render (`prompts/get`). */
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  /** Content block gốc do server trả (giữ nguyên để caller dùng tiếp). */
  content: unknown;
  /** Text gộp từ content block (tiện cho agent/LLM). */
  text: string;
}

/** Prompt đã render xong argument, sẵn sàng đưa vào hội thoại. */
export interface RenderedPrompt {
  name: string;
  description?: string;
  messages: McpPromptMessage[];
}

function parsePromptArgument(value: unknown): McpPromptArgument | null {
  if (!isRecord(value) || typeof value['name'] !== 'string' || !value['name']) return null;
  return {
    name: value['name'] as string,
    description: typeof value['description'] === 'string' ? value['description'] : undefined,
    required: value['required'] === true ? true : undefined,
  };
}

/** Parse một entry prompt trong `prompts/list` / `prompts/get`. */
export function parsePrompt(value: unknown): McpPrompt {
  if (!isRecord(value) || typeof value['name'] !== 'string' || !value['name']) {
    throw new PromptsError('Prompts: server phải trả prompt có "name" không rỗng');
  }
  const prompt: McpPrompt = { name: value['name'] as string };
  if (typeof value['description'] === 'string') prompt.description = value['description'];
  if (Array.isArray(value['arguments'])) {
    const args = (value['arguments'] as unknown[])
      .map((a) => parsePromptArgument(a))
      .filter((a): a is McpPromptArgument => a !== null);
    if (args.length > 0) prompt.arguments = args;
  }
  return prompt;
}

/** Liệt kê prompt template của server (`prompts/list`). */
export async function listPrompts(transport: McpRpcTransport): Promise<McpPrompt[]> {
  let raw: unknown;
  try {
    raw = await transport.request('prompts/list');
  } catch (err) {
    throw new PromptsError(`Prompts: liệt kê prompt thất bại: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw['prompts'])) {
    throw new PromptsError('Prompts: server phải trả { prompts: [...] } cho prompts/list');
  }
  return (raw['prompts'] as unknown[]).map((p) => parsePrompt(p));
}

/**
 * Kiểm tra argument trước khi gọi `prompts/get`: trả danh sách lỗi
 * (argument bắt buộc thiếu, argument lạ không có trong template).
 * Trả mảng rỗng khi hợp lệ. `promptDef` lấy từ `listPrompts`.
 */
export function validatePromptArguments(
  promptDef: McpPrompt,
  args: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const known = new Set((promptDef.arguments ?? []).map((a) => a.name));
  for (const arg of promptDef.arguments ?? []) {
    if (!arg.required) continue;
    const value = args[arg.name];
    if (value === undefined || value === null || value === '') {
      errors.push(`Argument "${arg.name}" là bắt buộc cho prompt "${promptDef.name}"`);
    }
  }
  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      errors.push(`Argument "${key}" không có trong prompt "${promptDef.name}"`);
    }
  }
  return errors;
}

function parsePromptMessage(value: unknown): McpPromptMessage {
  if (!isRecord(value)) {
    throw new PromptsError('Prompts: message trong prompts/get phải là một object');
  }
  const role = value['role'];
  if (role !== 'user' && role !== 'assistant') {
    throw new PromptsError(
      `Prompts: message có role không hỗ trợ: ${JSON.stringify(role)} (chỉ "user" / "assistant")`,
    );
  }
  const content = value['content'];
  return { role, content, text: promptContentToText(content) };
}

/**
 * Lấy prompt đã render (`prompts/get`): gửi argument, nhận messages.
 * Khi có `promptDef` (từ `listPrompts`), argument bắt buộc được kiểm
 * tra trước — ném `PromptsError` thay vì để server báo lỗi khó hiểu.
 */
export async function getPrompt(
  transport: McpRpcTransport,
  name: string,
  args: Record<string, unknown> = {},
  promptDef?: McpPrompt,
): Promise<RenderedPrompt> {
  if (!name) throw new PromptsError('Prompts: tên prompt không được rỗng');
  if (promptDef) {
    const errors = validatePromptArguments(promptDef, args);
    if (errors.length > 0) {
      throw new PromptsError(`Prompts: argument không hợp lệ — ${errors.join('; ')}`);
    }
  }
  let raw: unknown;
  try {
    raw = await transport.request('prompts/get', { name, arguments: args });
  } catch (err) {
    throw new PromptsError(`Prompts: lấy prompt "${name}" thất bại: ${(err as Error).message}`);
  }
  if (!isRecord(raw) || !Array.isArray(raw['messages'])) {
    throw new PromptsError(`Prompts: server phải trả { messages: [...] } cho prompts/get "${name}"`);
  }
  const rendered: RenderedPrompt = {
    name,
    messages: (raw['messages'] as unknown[]).map((m) => parsePromptMessage(m)),
  };
  if (typeof raw['description'] === 'string') rendered.description = raw['description'];
  return rendered;
}

// ---------------------------------------------------------------------------
// Resources: subscribe / templates
// ---------------------------------------------------------------------------

/** Một resource template (`resources/templates/list`). */
export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Parse một entry resource template. */
export function parseResourceTemplate(value: unknown): McpResourceTemplate {
  if (!isRecord(value) || typeof value['uriTemplate'] !== 'string' || !value['uriTemplate']) {
    throw new PromptsError('Resources: template phải có "uriTemplate" không rỗng');
  }
  const template: McpResourceTemplate = { uriTemplate: value['uriTemplate'] as string };
  if (typeof value['name'] === 'string') template.name = value['name'];
  if (typeof value['description'] === 'string') template.description = value['description'];
  if (typeof value['mimeType'] === 'string') template.mimeType = value['mimeType'];
  return template;
}

/** Liệt kê resource template của server (`resources/templates/list`). */
export async function listResourceTemplates(
  transport: McpRpcTransport,
): Promise<McpResourceTemplate[]> {
  let raw: unknown;
  try {
    raw = await transport.request('resources/templates/list');
  } catch (err) {
    throw new PromptsError(
      `Resources: liệt kê template thất bại: ${(err as Error).message}`,
    );
  }
  if (!isRecord(raw) || !Array.isArray(raw['resourceTemplates'])) {
    throw new PromptsError(
      'Resources: server phải trả { resourceTemplates: [...] } cho resources/templates/list',
    );
  }
  return (raw['resourceTemplates'] as unknown[]).map((t) => parseResourceTemplate(t));
}

/** Đăng ký theo dõi thay đổi của một resource (`resources/subscribe`). */
export async function subscribeResource(
  transport: McpRpcTransport,
  uri: string,
): Promise<void> {
  if (!uri) throw new PromptsError('Resources: uri subscribe không được rỗng');
  try {
    await transport.request('resources/subscribe', { uri });
  } catch (err) {
    throw new PromptsError(
      `Resources: subscribe "${uri}" thất bại: ${(err as Error).message}`,
    );
  }
}

/** Huỷ theo dõi một resource (`resources/unsubscribe`). */
export async function unsubscribeResource(
  transport: McpRpcTransport,
  uri: string,
): Promise<void> {
  if (!uri) throw new PromptsError('Resources: uri unsubscribe không được rỗng');
  try {
    await transport.request('resources/unsubscribe', { uri });
  } catch (err) {
    throw new PromptsError(
      `Resources: unsubscribe "${uri}" thất bại: ${(err as Error).message}`,
    );
  }
}

/** Payload của `notifications/resources/updated`. */
export interface ResourceUpdatedNotification {
  uri: string;
}

/**
 * Parse notification `notifications/resources/updated`; trả uri khi đúng
 * method + đúng hình dạng, null khi không phải notification này.
 */
export function parseResourceUpdatedNotification(
  method: string,
  params: unknown,
): ResourceUpdatedNotification | null {
  if (method !== 'notifications/resources/updated') return null;
  if (!isRecord(params) || typeof params['uri'] !== 'string' || !params['uri']) return null;
  return { uri: params['uri'] as string };
}

/** Listener nhận thông báo resource đổi (nhận uri đã đổi). */
export type ResourceUpdatedListener = (notification: ResourceUpdatedNotification) => void;

/**
 * Đăng ký nhận `notifications/resources/updated` trên transport.
 * Trả hàm huỷ đăng ký. Ném `PromptsError` khi transport không hỗ trợ
 * notification (khi đó subscribe vẫn gửi được nhưng không bao giờ nhận
 * được tin đổi — báo rõ thay vì lặng lẽ).
 */
export function onResourcesUpdated(
  transport: McpRpcTransport,
  listener: ResourceUpdatedListener,
): () => void {
  if (typeof transport.onNotification !== 'function') {
    throw new PromptsError(
      'Resources: transport không hỗ trợ nhận notification — không thể theo dõi resources/updated',
    );
  }
  return transport.onNotification((method, params) => {
    const notification = parseResourceUpdatedNotification(method, params);
    if (notification) listener(notification);
  });
}

/**
 * Theo dõi nhiều resource cùng lúc: gom subscribe theo uri (gọi
 * `resources/subscribe` một lần cho mỗi uri dù có nhiều listener),
 * dispatch `notifications/resources/updated` tới đúng listener của uri đó,
 * và tự `resources/unsubscribe` khi listener cuối cùng của uri rời đi.
 * Một instance dùng cho một server (một transport).
 */
export class ResourceWatcher {
  private readonly transport: McpRpcTransport;
  private readonly listeners = new Map<string, Set<ResourceUpdatedListener>>();
  private readonly offNotification: () => void;

  constructor(transport: McpRpcTransport) {
    this.transport = transport;
    this.offNotification = onResourcesUpdated(transport, (notification) => {
      const set = this.listeners.get(notification.uri);
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(notification);
        } catch {
          // Một listener lỗi không được làm chết các listener khác.
        }
      }
    });
  }

  /** Số uri đang được theo dõi. */
  get subscribedCount(): number {
    return this.listeners.size;
  }

  /**
   * Theo dõi một uri. Lần đầu subscribe uri này sẽ gọi
   * `resources/subscribe`; các listener sau chỉ đăng ký local.
   */
  async subscribe(uri: string, listener: ResourceUpdatedListener): Promise<void> {
    if (!uri) throw new PromptsError('Resources: uri subscribe không được rỗng');
    const existing = this.listeners.get(uri);
    if (existing) {
      existing.add(listener);
      return;
    }
    await subscribeResource(this.transport, uri);
    this.listeners.set(uri, new Set([listener]));
  }

  /**
   * Bỏ một listener khỏi uri (hoặc bỏ hết listener của uri khi không
   * truyền listener). Khi hết listener, gọi `resources/unsubscribe`.
   */
  async unsubscribe(uri: string, listener?: ResourceUpdatedListener): Promise<void> {
    const set = this.listeners.get(uri);
    if (!set) return;
    if (listener) set.delete(listener);
    else set.clear();
    if (set.size === 0) {
      this.listeners.delete(uri);
      await unsubscribeResource(this.transport, uri);
    }
  }

  /** Huỷ đăng ký notification và quên mọi listener (không unsubscribe server). */
  close(): void {
    this.listeners.clear();
    this.offNotification();
  }
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** Gợi ý completion trả về: danh sách giá trị (+ tổng số / còn nữa). */
export interface CompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

/** Tham chiếu cho `completion/complete`: prompt hoặc resource template. */
export type CompletionRef =
  | { type: 'ref/prompt'; name: string }
  | { type: 'ref/resource'; uri: string };

function parseCompletionResult(value: unknown): CompletionResult {
  if (!isRecord(value) || !isRecord(value['completion'])) {
    throw new PromptsError('Completion: server phải trả { completion: { values: [...] } }');
  }
  const completion = value['completion'] as Record<string, unknown>;
  if (!Array.isArray(completion['values'])) {
    throw new PromptsError('Completion: completion.values phải là một mảng');
  }
  const values = (completion['values'] as unknown[]).filter(
    (v): v is string => typeof v === 'string',
  );
  const out: CompletionResult = { values };
  if (typeof completion['total'] === 'number') out.total = completion['total'];
  if (typeof completion['hasMore'] === 'boolean') out.hasMore = completion['hasMore'];
  return out;
}

/**
 * Gợi ý giá trị cho một argument (`completion/complete`).
 * `ref` chỉ prompt (`ref/prompt`, theo tên) hoặc resource template
 * (`ref/resource`, theo uri template); `argument` là tên + giá trị
 * user đã gõ dở (prefix để server lọc gợi ý).
 */
export async function complete(
  transport: McpRpcTransport,
  ref: CompletionRef,
  argument: { name: string; value: string },
): Promise<CompletionResult> {
  if (!argument.name) throw new PromptsError('Completion: tên argument không được rỗng');
  let raw: unknown;
  try {
    raw = await transport.request('completion/complete', { ref, argument });
  } catch (err) {
    throw new PromptsError(`Completion: gợi ý thất bại: ${(err as Error).message}`);
  }
  return parseCompletionResult(raw);
}

/** Gợi ý giá trị cho argument của một prompt (tên prompt + tên argument). */
export async function completePromptArgument(
  transport: McpRpcTransport,
  promptName: string,
  argumentName: string,
  value: string,
): Promise<CompletionResult> {
  if (!promptName) throw new PromptsError('Completion: tên prompt không được rỗng');
  return complete(transport, { type: 'ref/prompt', name: promptName }, { name: argumentName, value });
}

/** Gợi ý giá trị cho argument của một resource template (uri template + tên argument). */
export async function completeResourceArgument(
  transport: McpRpcTransport,
  uriTemplate: string,
  argumentName: string,
  value: string,
): Promise<CompletionResult> {
  if (!uriTemplate) throw new PromptsError('Completion: uri template không được rỗng');
  return complete(
    transport,
    { type: 'ref/resource', uri: uriTemplate },
    { name: argumentName, value },
  );
}
