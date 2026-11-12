/**
 * MCP elicitation — xử lý yêu cầu `elicitation/create` do server gửi
 * (MCP spec 2025-11-25, SEP-1330 / SEP-1034 / SEP-1036).
 *
 * Module thuần logic, KHÔNG phụ thuộc transport hay UI:
 *  - server gửi request qua dispatcher (W5a) -> parse ở đây
 *  - UI (ElicitationModal) hoặc hàm prompt khác trả lời
 *  - kết quả trả về dispatcher để gửi lại server
 *
 * Hai chế độ (mode):
 *  - `form`: server gửi JSON Schema (requestedSchema); client hiện form
 *    cho user điền rồi trả object đã validate. Chỉ chứa primitive
 *    (string / number / integer / boolean) + enum single/multi-select
 *    + default cho mọi primitive. Form-mode KHÔNG BAO GIỜ dùng cho
 *    mật khẩu / API key / token / thanh toán — module từ chối thẳng
 *    các field nhạy cảm (xem `isSensitiveElicitationField`).
 *  - `url`: server gửi URL; client mở URL cho user làm tiếp ngoài băng
 *    (đăng nhập, thanh toán, xác minh). Server báo xong qua notification
 *    `notifications/elicitation/complete` (xem `ElicitationUrlTracker`).
 *
 * Lưu ý tương lai (spec 2026-07-28): elicitation chuyển sang cơ chế
 * Multi Round-Trip Requests (bỏ `elicitationId` và notification
 * complete). Module này giữ lớp abstraction mỏng (`ElicitationRequest`
 * / `ElicitResult`) để đổi được mà không sửa UI.
 */

export type ElicitationMode = 'form' | 'url';

/** Hành động user trả lời một yêu cầu elicitation. */
export type ElicitAction = 'accept' | 'decline' | 'cancel';

/** Kết quả trả về server cho `elicitation/create`. */
export interface ElicitResult {
  action: ElicitAction;
  /** Chỉ có khi action = 'accept' ở form-mode: object đã validate. */
  content?: Record<string, unknown>;
}

/** Kiểu field trong form elicitation (sau khi parse schema). */
export type ElicitationFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'string-array';

/** Một field của form, đã chuẩn hoá từ JSON Schema của server. */
export interface ElicitationFormField {
  name: string;
  type: ElicitationFieldType;
  title?: string;
  description?: string;
  required: boolean;
  /** Enum cho single-select (string) hoặc multi-select (string-array). */
  enum?: string[];
  default?: string | number | boolean | string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** Yêu cầu elicitation đã parse — đủ dữ liệu để UI render form/URL. */
export interface ElicitationRequest {
  /** Id do server cấp cho URL-mode (để theo dõi notification complete). */
  elicitationId?: string;
  /** Tên server MCP đang hỏi — UI PHẢI hiển thị rõ cho user (theo spec). */
  serverName: string;
  /** Câu hỏi / lời giải thích server gửi kèm. */
  message: string;
  mode: ElicitationMode;
  /** URL-mode: URL user cần mở (chỉ http/https). */
  url?: string;
  /** Form-mode: các field đã parse từ requestedSchema. */
  fields?: ElicitationFormField[];
  /** Schema gốc (giữ lại để debug, không dùng để render). */
  requestedSchema?: Record<string, unknown>;
}

/** Lỗi parse/validate elicitation (request sai spec hoặc dữ liệu sai). */
export class ElicitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElicitationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tên field gợi ý dữ liệu nhạy cảm — form-mode không bao giờ được hỏi. */
const SENSITIVE_FIELD_NAME =
  /(password|passwd|secret|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|private[-_ ]?key|credential|credit[-_ ]?card|card[-_ ]?number|cvv)/i;

/**
 * Field có phải dữ liệu nhạy cảm không (theo tên hoặc `format: 'password'`).
 * Server nào hỏi những thứ này qua form-mode là vi phạm spec (SEP-1036):
 * mật khẩu / key / token / thanh toán phải đi URL-mode.
 */
export function isSensitiveElicitationField(name: string, schema: Record<string, unknown>): boolean {
  if (SENSITIVE_FIELD_NAME.test(name)) return true;
  if (schema['format'] === 'password') return true;
  return false;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === 'string')) return undefined;
  return [...(value as string[])];
}

/**
 * Parse một property schema thành field. Ném `ElicitationError` khi schema
 * dùng kiểu không hỗ trợ (object lồng, array không phải enum string) hoặc
 * khi field là dữ liệu nhạy cảm (xem `isSensitiveElicitationField`).
 */
export function parseElicitationField(
  name: string,
  schema: unknown,
  required: boolean,
): ElicitationFormField {
  if (!isRecord(schema)) {
    throw new ElicitationError(`Elicitation: field "${name}" phải là một JSON Schema object`);
  }
  if (isSensitiveElicitationField(name, schema)) {
    throw new ElicitationError(
      `Elicitation: field "${name}" chứa dữ liệu nhạy cảm — form-mode không được dùng ` +
        `cho mật khẩu / API key / token / thanh toán (dùng URL-mode thay thế)`,
    );
  }
  const type = schema['type'];
  const title = typeof schema['title'] === 'string' ? schema['title'] : undefined;
  const description =
    typeof schema['description'] === 'string' ? schema['description'] : undefined;
  const minimum = asFiniteNumber(schema['minimum']);
  const maximum = asFiniteNumber(schema['maximum']);
  const minLength =
    typeof schema['minLength'] === 'number' && Number.isInteger(schema['minLength'])
      ? schema['minLength']
      : undefined;
  const maxLength =
    typeof schema['maxLength'] === 'number' && Number.isInteger(schema['maxLength'])
      ? schema['maxLength']
      : undefined;
  const pattern = typeof schema['pattern'] === 'string' ? schema['pattern'] : undefined;

  // Multi-select (SEP-1330): { type: 'array', items: { type: 'string', enum: [...] } }
  if (type === 'array') {
    const items = schema['items'];
    if (!isRecord(items) || items['type'] !== 'string') {
      throw new ElicitationError(
        `Elicitation: field "${name}" dạng array chỉ hỗ trợ items là string enum (multi-select)`,
      );
    }
    const enumValues = asStringArray(items['enum']);
    if (!enumValues || enumValues.length === 0) {
      throw new ElicitationError(
        `Elicitation: field "${name}" dạng array phải có items.enum không rỗng`,
      );
    }
    const def = schema['default'];
    const defaultValue =
      def === undefined ? undefined : asStringArray(def);
    if (def !== undefined && defaultValue === undefined) {
      throw new ElicitationError(
        `Elicitation: field "${name}" có default không phải mảng string`,
      );
    }
    if (defaultValue && defaultValue.some((v) => !enumValues.includes(v))) {
      throw new ElicitationError(
        `Elicitation: field "${name}" có default nằm ngoài enum`,
      );
    }
    return {
      name,
      type: 'string-array',
      title,
      description,
      required,
      enum: enumValues,
      default: defaultValue,
      minLength,
      maxLength,
    };
  }

  if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') {
    throw new ElicitationError(
      `Elicitation: field "${name}" có kiểu không hỗ trợ: ${JSON.stringify(type)} ` +
        `(chỉ string / number / integer / boolean / array enum)`,
    );
  }
  const field: ElicitationFormField = {
    name,
    type,
    title,
    description,
    required,
    minimum,
    maximum,
    minLength,
    maxLength,
    pattern,
  };
  // Enum single-select (SEP-1330): chỉ hợp lệ cho string.
  if (type === 'string') {
    const enumValues = schema['enum'] === undefined ? undefined : asStringArray(schema['enum']);
    if (schema['enum'] !== undefined && (!enumValues || enumValues.length === 0)) {
      throw new ElicitationError(
        `Elicitation: field "${name}" có enum phải là mảng string không rỗng`,
      );
    }
    if (enumValues) field.enum = enumValues;
  }
  // Default cho mọi primitive (SEP-1034).
  const def = schema['default'];
  if (def !== undefined) {
    if (type === 'string' && typeof def === 'string') field.default = def;
    else if (type === 'number' && typeof def === 'number') field.default = def;
    else if (type === 'integer' && typeof def === 'number' && Number.isInteger(def)) field.default = def;
    else if (type === 'boolean' && typeof def === 'boolean') field.default = def;
    else {
      throw new ElicitationError(
        `Elicitation: field "${name}" có default không khớp kiểu ${type}`,
      );
    }
    if (field.enum && typeof def === 'string' && !field.enum.includes(def)) {
      throw new ElicitationError(
        `Elicitation: field "${name}" có default nằm ngoài enum`,
      );
    }
  }
  return field;
}

/**
 * Parse `requestedSchema` (JSON Schema 2020-12, object gốc) thành danh sách
 * field. Ném `ElicitationError` khi schema sai hình dạng.
 */
export function parseElicitationSchema(schema: unknown): ElicitationFormField[] {
  if (!isRecord(schema)) {
    throw new ElicitationError('Elicitation: requestedSchema phải là một object');
  }
  if (schema['type'] !== undefined && schema['type'] !== 'object') {
    throw new ElicitationError(
      `Elicitation: requestedSchema phải có type "object", nhận được ${JSON.stringify(schema['type'])}`,
    );
  }
  const properties = schema['properties'];
  if (properties !== undefined && !isRecord(properties)) {
    throw new ElicitationError('Elicitation: requestedSchema.properties phải là một object');
  }
  const requiredRaw = schema['required'];
  const requiredList =
    requiredRaw === undefined ? [] : asStringArray(requiredRaw);
  if (requiredRaw !== undefined && !requiredList) {
    throw new ElicitationError('Elicitation: requestedSchema.required phải là mảng string');
  }
  const required = new Set(requiredList ?? []);
  const fields: ElicitationFormField[] = [];
  for (const [name, propSchema] of Object.entries(properties ?? {})) {
    fields.push(parseElicitationField(name, propSchema, required.has(name)));
  }
  return fields;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse params thô của `elicitation/create` thành `ElicitationRequest`.
 * `serverName` là tên server MCP đang hỏi (UI hiển thị cho user biết ai hỏi).
 * Ném `ElicitationError` khi thiếu message, sai mode, form-mode thiếu schema,
 * hoặc URL-mode thiếu URL http(s).
 */
export function parseElicitationRequest(params: unknown, serverName: string): ElicitationRequest {
  if (!isRecord(params)) {
    throw new ElicitationError('Elicitation: params của elicitation/create phải là một object');
  }
  if (typeof params['message'] !== 'string' || !params['message'].trim()) {
    throw new ElicitationError('Elicitation: thiếu "message" (chuỗi không rỗng)');
  }
  const message = params['message'] as string;
  const elicitationId =
    typeof params['elicitationId'] === 'string' ? params['elicitationId'] : undefined;
  const modeRaw = params['mode'];
  const mode: ElicitationMode =
    modeRaw === undefined || modeRaw === 'form' ? 'form' : modeRaw === 'url' ? 'url' : (() => {
      throw new ElicitationError(
        `Elicitation: mode không hỗ trợ: ${JSON.stringify(modeRaw)} (chỉ "form" hoặc "url")`,
      );
    })();

  if (mode === 'url') {
    const url = params['url'];
    if (typeof url !== 'string' || !isHttpUrl(url)) {
      throw new ElicitationError('Elicitation: URL-mode cần "url" http(s) hợp lệ');
    }
    return { elicitationId, serverName, message, mode, url };
  }
  if (params['requestedSchema'] === undefined) {
    throw new ElicitationError('Elicitation: form-mode cần "requestedSchema"');
  }
  const fields = parseElicitationSchema(params['requestedSchema']);
  const requestedSchema = isRecord(params['requestedSchema'])
    ? params['requestedSchema']
    : undefined;
  return { elicitationId, serverName, message, mode, fields, requestedSchema };
}

/**
 * Ép một giá trị thô (từ form UI — thường là string) về đúng kiểu field.
 * Trả `undefined` khi giá trị rỗng (để bên gọi áp default / báo thiếu).
 * Ném `ElicitationError` khi không ép được (vd "abc" cho number).
 */
export function coerceElicitedValue(field: ElicitationFormField, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && raw.trim() === '') return undefined;
  switch (field.type) {
    case 'string': {
      if (typeof raw !== 'string') throw new ElicitationError(`Field "${field.name}" phải là chuỗi`);
      return raw;
    }
    case 'number':
    case 'integer': {
      const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(num)) {
        throw new ElicitationError(`Field "${field.name}" phải là một số`);
      }
      if (field.type === 'integer' && !Number.isInteger(num)) {
        throw new ElicitationError(`Field "${field.name}" phải là số nguyên`);
      }
      return num;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1) return true;
      if (raw === 'false' || raw === 0) return false;
      throw new ElicitationError(`Field "${field.name}" phải là true/false`);
    }
    case 'string-array': {
      const arr = Array.isArray(raw) ? raw : [raw];
      if (!arr.every((v) => typeof v === 'string')) {
        throw new ElicitationError(`Field "${field.name}" phải là mảng chuỗi`);
      }
      return [...(arr as string[])];
    }
  }
}

/**
 * Validate object user điền theo danh sách field: áp default (SEP-1034),
 * ép kiểu, kiểm tra required / enum / min / max / pattern / độ dài.
 * Key lạ (không có trong schema) bị loại bỏ. Trả object đã validate;
 * ném `ElicitationError` liệt kê mọi lỗi khi dữ liệu không hợp lệ.
 */
export function validateElicitedContent(
  fields: ElicitationFormField[],
  content: unknown,
): Record<string, unknown> {
  if (!isRecord(content)) {
    throw new ElicitationError('Elicitation: content phải là một object');
  }
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    let value: unknown;
    try {
      value = coerceElicitedValue(field, content[field.name]);
    } catch (err) {
      errors.push((err as Error).message);
      continue;
    }
    if (value === undefined) {
      if (field.default !== undefined) {
        out[field.name] = field.default;
        continue;
      }
      if (field.required) errors.push(`Field "${field.name}" là bắt buộc`);
      continue;
    }
    if (field.type === 'string' && typeof value === 'string') {
      if (field.enum && !field.enum.includes(value)) {
        errors.push(`Field "${field.name}" phải là một trong: ${field.enum.join(', ')}`);
        continue;
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        errors.push(`Field "${field.name}" phải dài ít nhất ${field.minLength} ký tự`);
        continue;
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        errors.push(`Field "${field.name}" dài tối đa ${field.maxLength} ký tự`);
        continue;
      }
      if (field.pattern !== undefined) {
        let re: RegExp;
        try {
          re = new RegExp(field.pattern);
        } catch {
          errors.push(`Field "${field.name}" có pattern không hợp lệ`);
          continue;
        }
        if (!re.test(value)) {
          errors.push(`Field "${field.name}" không đúng định dạng yêu cầu`);
          continue;
        }
      }
    }
    if ((field.type === 'number' || field.type === 'integer') && typeof value === 'number') {
      if (field.minimum !== undefined && value < field.minimum) {
        errors.push(`Field "${field.name}" phải >= ${field.minimum}`);
        continue;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        errors.push(`Field "${field.name}" phải <= ${field.maximum}`);
        continue;
      }
    }
    if (field.type === 'string-array' && Array.isArray(value)) {
      const bad = (value as unknown[]).filter(
        (v) => typeof v !== 'string' || !field.enum?.includes(v),
      );
      if (bad.length > 0) {
        errors.push(`Field "${field.name}" chứa giá trị ngoài enum: ${JSON.stringify(bad)}`);
        continue;
      }
    }
    out[field.name] = value;
  }
  if (errors.length > 0) {
    throw new ElicitationError(`Elicitation: dữ liệu không hợp lệ — ${errors.join('; ')}`);
  }
  return out;
}

/** Hàm hỏi user — do UI (modal) hoặc caller khác cung cấp. Trả null = user hủy. */
export type ElicitationPrompt = (request: ElicitationRequest) => Promise<ElicitResult | null>;

/**
 * Xử lý một yêu cầu elicitation đã parse: hỏi user qua `prompt`, rồi
 * chuẩn hoá kết quả. `accept` ở form-mode được validate lại trước khi
 * trả về (phòng khi UI gửi content chưa chuẩn); `decline` / `cancel`
 * và `accept` ở URL-mode trả thẳng (không kèm content).
 * Signal bị abort (hoặc prompt trả null) -> kết quả `cancel`.
 */
export async function handleElicitationRequest(
  request: ElicitationRequest,
  prompt: ElicitationPrompt,
  options?: { signal?: AbortSignal },
): Promise<ElicitResult> {
  const signal = options?.signal;
  if (signal?.aborted) return { action: 'cancel' };
  let answer: ElicitResult | null;
  if (signal) {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      answer = await Promise.race([prompt(request), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  } else {
    answer = await prompt(request);
  }
  if (answer === null) return { action: 'cancel' };
  if (answer.action === 'accept' && request.mode === 'form') {
    const content = validateElicitedContent(request.fields ?? [], answer.content ?? {});
    return { action: 'accept', content };
  }
  if (answer.action === 'accept') return { action: 'accept' };
  return { action: answer.action };
}

/**
 * Timeout mặc định chờ server báo hoàn tất một URL-mode elicitation
 * (v0.85, P2-8): 10 phút — cùng cửa sổ với `RESPONSE_TIMEOUT_MS` của
 * coordinator (`askElicitation` chờ user trả lời modal). Chờ này có
 * giới hạn: hết timeout thì `waitForCompletion` reject `ElicitationError`
 * rõ ràng, dispatcher chuyển thành lỗi MCP `-32603` thay vì treo.
 */
export const DEFAULT_ELICITATION_URL_COMPLETION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tạo handler sẵn cho dispatcher (W5a nối sau): nhận params thô +
 * tên server, parse rồi hỏi user. Dispatcher chỉ cần đăng ký hàm này
 * cho method `elicitation/create` của client MCP.
 *
 * v0.85 (P2-8): URL-mode — khi user `accept` và request có
 * `elicitationId`, handler chờ `urlTracker.waitForCompletion(id)` tới
 * khi server gửi `notifications/elicitation/complete` rồi mới trả kết
 * quả (trước đây trả `accept` ngay mà không theo dõi user làm gì tiếp
 * ở trình duyệt). Hết timeout (`urlCompletionTimeoutMs`, mặc định 10
 * phút như trên) thì ném `ElicitationError` rõ ràng thay vì treo.
 * Form-mode, decline/cancel, URL-mode không có `elicitationId`, hoặc
 * không truyền `urlTracker` thì trả ngay như cũ (tương thích ngược).
 */
export function createElicitationHandler(
  prompt: ElicitationPrompt,
  options?: {
    signal?: AbortSignal;
    urlTracker?: ElicitationUrlTracker;
    urlCompletionTimeoutMs?: number;
  },
): (params: unknown, serverName: string) => Promise<ElicitResult> {
  return async (params: unknown, serverName: string) => {
    const request = parseElicitationRequest(params, serverName);
    const result = await handleElicitationRequest(request, prompt, options);
    if (
      result.action === 'accept' &&
      request.mode === 'url' &&
      request.elicitationId !== undefined &&
      options?.urlTracker
    ) {
      await options.urlTracker.waitForCompletion(request.elicitationId, {
        timeoutMs: options.urlCompletionTimeoutMs ?? DEFAULT_ELICITATION_URL_COMPLETION_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    return result;
  };
}

/**
 * Kiểm tra một notification có phải `notifications/elicitation/complete`
 * (URL-mode) không; trả `elicitationId` khi đúng, null khi không phải.
 */
export function parseElicitationCompleteNotification(
  method: string,
  params: unknown,
): string | null {
  if (method !== 'notifications/elicitation/complete') return null;
  if (!isRecord(params) || typeof params['elicitationId'] !== 'string') return null;
  return params['elicitationId'] as string;
}

/**
 * Theo dõi URL-mode elicitation đang chờ user hoàn tất ngoài băng:
 * UI mở URL, rồi `waitForCompletion(elicitationId)` chờ server gửi
 * `notifications/elicitation/complete`. `complete()` do dispatcher gọi
 * khi notification tới; `cancelAll()` huỷ mọi lượt chờ (vd đóng app).
 */
export class ElicitationUrlTracker {
  private readonly pending = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void; timer?: NodeJS.Timeout; onAbort?: () => void; signal?: AbortSignal }
  >();

  /** Số lượt chờ đang mở. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Chờ server báo hoàn tất cho `elicitationId`. Resolve khi xong;
   * reject `ElicitationError` khi hết `timeoutMs`, khi signal abort,
   * hoặc khi `cancelAll()` được gọi.
   */
  waitForCompletion(
    elicitationId: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    if (this.pending.has(elicitationId)) {
      throw new ElicitationError(
        `Elicitation: đã có lượt chờ cho elicitationId "${elicitationId}"`,
      );
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(new ElicitationError('Elicitation: lượt chờ đã bị huỷ'));
    }
    return new Promise<void>((resolve, reject) => {
      const entry: {
        resolve: () => void;
        reject: (err: Error) => void;
        timer?: NodeJS.Timeout;
        onAbort?: () => void;
        signal?: AbortSignal;
      } = { resolve, reject, signal };
      if (options?.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(elicitationId);
          reject(
            new ElicitationError(
              `Elicitation: hết thời gian chờ hoàn tất (${options.timeoutMs}ms) cho "${elicitationId}"`,
            ),
          );
        }, options.timeoutMs);
        entry.timer.unref?.();
      }
      if (signal) {
        entry.onAbort = () => {
          this.cleanup(elicitationId);
          reject(new ElicitationError('Elicitation: lượt chờ đã bị huỷ'));
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.set(elicitationId, entry);
    });
  }

  /**
   * Báo một URL-mode elicitation đã hoàn tất (dispatcher gọi khi nhận
   * notification). Trả true khi có lượt chờ đang đợi id này.
   */
  complete(elicitationId: string): boolean {
    const entry = this.pending.get(elicitationId);
    if (!entry) return false;
    this.cleanup(elicitationId);
    entry.resolve();
    return true;
  }

  /** Huỷ mọi lượt chờ đang mở (vd user đóng modal / đóng app). */
  cancelAll(reason = 'Elicitation: lượt chờ URL-mode đã bị huỷ'): void {
    for (const id of [...this.pending.keys()]) {
      const entry = this.pending.get(id);
      if (!entry) continue;
      this.cleanup(id);
      entry.reject(new ElicitationError(reason));
    }
  }

  private cleanup(elicitationId: string): void {
    const entry = this.pending.get(elicitationId);
    if (!entry) return;
    this.pending.delete(elicitationId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }
}
