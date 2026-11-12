/**
 * Structured output — kết quả cuối theo JSON Schema (v0.12 mục 8 — W4d).
 *
 * Cho phép một run yêu cầu câu trả lời cuối theo JSON Schema: parse text
 * cuối của model thành JSON, validate theo schema, và (tuỳ chọn) thử lại
 * tối đa N lần với prompt nhắc model trả đúng JSON.
 *
 * Validator TỰ VIẾT, không thêm dependency. Hỗ trợ: type
 * object/array/string/number/integer/boolean/null, required, enum,
 * properties, items, additionalProperties, và thêm minimum/maximum,
 * minLength/maxLength, minItems/maxItems.
 *
 * Module PURE + dễ test: không đọc file, không gọi mạng, không gọi
 * provider trực tiếp — việc thử lại đi qua callback `StructuredProducer`
 * (test dùng hàm giả).
 *
 * NỐI VÀO LOOP (dành cho điều phối viên — KHÔNG sửa ở đây):
 * - Thêm option `structuredOutput?: StructuredOutputOptions` vào
 *   `AgentRunnerOptions` (loop.ts).
 * - Trước run: nối `buildStructuredPromptHint(schema, language)` vào
 *   system prompt của run.
 * - Sau khi loop có text cuối: gọi `parseStructuredWithRetry` với một
 *   producer gọi lại `provider.chat()` kèm `retryHint` (như một user
 *   message nhắc model trả đúng JSON). Hết lượt thử mà vẫn lỗi → trả
 *   lỗi cho user bằng `formatStructuredError(result)` (kèm text gốc),
 *   không giao JSON sai schema cho user.
 */

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/** Một phần của JSON Schema — chỉ các keyword validator này hỗ trợ. */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
}

/** Option `structuredOutput` cho run — điều phối viên nối vào loop. */
export interface StructuredOutputOptions {
  schema: JsonSchema;
  /** Số lần thử lại tối đa khi parse/validate fail. Mặc định 2. */
  maxRetries?: number;
  /** Ngôn ngữ của prompt nhắc + thông báo lỗi. Mặc định 'vi'. */
  language?: 'vi' | 'en';
}

export interface SchemaValidationError {
  /** Đường dẫn tới field lỗi, vd `$`, `$.verdict`, `$.findings[0].severity`. */
  path: string;
  message: string;
}

const JSON_SCHEMA_TYPES: readonly JsonSchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && !Number.isNaN(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

/**
 * Validate một giá trị theo JSON Schema. Trả về danh sách lỗi chi tiết
 * từng field (mảng rỗng = hợp lệ). Không ném lỗi — schema lạ cũng trả
 * về lỗi trong danh sách thay vì throw.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = '$',
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  // Không dùng isPlainObject() ở đây: nó thu hẹp JsonSchema thành
  // Record<string, unknown> và làm mất kiểu của các field schema.
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    errors.push({ path, message: 'Schema không hợp lệ: schema phải là object.' });
    return errors;
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((allowed) => deepEqual(value, allowed))) {
      errors.push({
        path,
        message: `giá trị không nằm trong enum cho phép (${JSON.stringify(schema.enum)})`,
      });
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const known = types.filter((t) => (JSON_SCHEMA_TYPES as readonly string[]).includes(t));
    for (const t of types) {
      if (!(JSON_SCHEMA_TYPES as readonly string[]).includes(t)) {
        errors.push({ path, message: `kiểu "${t}" trong schema không được hỗ trợ` });
      }
    }
    if (known.length > 0 && !known.some((t) => matchesType(value, t))) {
      errors.push({
        path,
        message: `kiểu phải là ${known.join(' hoặc ')}, nhận được ${describeValue(value)}`,
      });
      // Sai kiểu thì không kiểm tra sâu thêm được (vd properties của string).
      return errors;
    }
    if (known.length === 0) return errors;
  }

  if (isPlainObject(value)) {
    for (const field of schema.required ?? []) {
      if (value[field] === undefined) {
        errors.push({ path: `${path}.${field}`, message: `thiếu trường bắt buộc "${field}"` });
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        errors.push(...validateAgainstSchema(value[key], subSchema, `${path}.${key}`));
      }
    }
    const extraKeys = Object.keys(value).filter((k) => !(k in properties));
    if (schema.additionalProperties === false) {
      for (const key of extraKeys) {
        errors.push({
          path: `${path}.${key}`,
          message: `trường "${key}" không được phép (additionalProperties: false)`,
        });
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const key of extraKeys) {
        errors.push(
          ...validateAgainstSchema(value[key], schema.additionalProperties, `${path}.${key}`),
        );
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({
        path,
        message: `mảng cần ít nhất ${schema.minItems} phần tử, nhận được ${value.length}`,
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({
        path,
        message: `mảng tối đa ${schema.maxItems} phần tử, nhận được ${value.length}`,
      });
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${i}]`));
      });
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path,
        message: `chuỗi cần ít nhất ${schema.minLength} ký tự, nhận được ${value.length}`,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        path,
        message: `chuỗi tối đa ${schema.maxLength} ký tự, nhận được ${value.length}`,
      });
    }
  }

  if (typeof value === 'number' && !Number.isNaN(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `số phải >= ${schema.minimum}, nhận được ${value}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `số phải <= ${schema.maximum}, nhận được ${value}` });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Trích JSON khỏi text của model
// ---------------------------------------------------------------------------

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Trích chuỗi JSON khỏi text model: thử text nguyên vẹn, rồi block
 * ```json ... ```, rồi đoạn từ `{`/`[` đầu tiên tới `}`/`]` cuối cùng.
 * Trả null khi không tìm được JSON parse được.
 */
export function extractJsonText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (tryParseJson(trimmed) !== undefined) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const inner = fence[1].trim();
    if (tryParseJson(inner) !== undefined) return inner;
  }
  const startBrace = trimmed.indexOf('{');
  const startBracket = trimmed.indexOf('[');
  let start = -1;
  let endChar = '';
  if (startBrace !== -1 && (startBracket === -1 || startBrace < startBracket)) {
    start = startBrace;
    endChar = '}';
  } else if (startBracket !== -1) {
    start = startBracket;
    endChar = ']';
  }
  if (start !== -1) {
    const end = trimmed.lastIndexOf(endChar);
    if (end > start) {
      const candidate = trimmed.slice(start, end + 1);
      if (tryParseJson(candidate) !== undefined) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Parse + validate text cuối của model
// ---------------------------------------------------------------------------

export interface StructuredParseResult<T = unknown> {
  ok: boolean;
  /** Giá trị đã parse (có cả khi validate fail — để retry/debug). */
  value?: T;
  /** Lỗi parse/validate, rỗng khi ok. */
  errors: SchemaValidationError[];
  /** Text gốc của model (giữ nguyên để báo lỗi / thử lại). */
  rawText: string;
}

/**
 * Parse text cuối của model thành JSON rồi validate theo schema.
 * Không ném lỗi: mọi thất bại trả về `ok: false` kèm lỗi chi tiết +
 * text gốc.
 */
export function parseStructuredOutput<T = unknown>(
  text: string,
  schema: JsonSchema,
): StructuredParseResult<T> {
  const rawText = text;
  const jsonText = extractJsonText(text);
  if (jsonText === null) {
    return {
      ok: false,
      errors: [
        {
          path: '$',
          message: 'Không tìm thấy JSON hợp lệ trong câu trả lời của model.',
        },
      ],
      rawText,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          path: '$',
          message: `JSON parse lỗi: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      rawText,
    };
  }
  const errors = validateAgainstSchema(value, schema);
  if (errors.length > 0) {
    return { ok: false, value: value as T, errors, rawText };
  }
  return { ok: true, value: value as T, errors: [], rawText };
}

// ---------------------------------------------------------------------------
// Prompt hướng dẫn + nhắc thử lại
// ---------------------------------------------------------------------------

/**
 * Đoạn hướng dẫn nhét vào system prompt của run: ép model trả kết quả
 * cuối là JSON thuần đúng schema, không thêm giải thích.
 */
export function buildStructuredPromptHint(
  schema: JsonSchema,
  language: 'vi' | 'en' = 'vi',
): string {
  const schemaText = JSON.stringify(schema, null, 2);
  const required = schema.required ?? [];
  if (language === 'en') {
    return (
      'Your FINAL answer MUST be a single valid JSON value matching the schema below. ' +
      'Do not add explanations, greetings, or markdown fences around the JSON.\n' +
      'Schema (JSON Schema):\n' +
      schemaText +
      (required.length > 0 ? `\nRequired fields: ${required.join(', ')}.` : '')
    );
  }
  return (
    'Kết quả CUỐI CÙNG của bạn PHẢI là một JSON thuần hợp lệ, đúng schema dưới đây. ' +
    'Không thêm lời giải thích, lời chào hay markdown fence bên ngoài JSON.\n' +
    'Schema (JSON Schema):\n' +
    schemaText +
    (required.length > 0 ? `\nCác trường bắt buộc: ${required.join(', ')}.` : '')
  );
}

/** Prompt nhắc model thử lại sau một lần trả JSON không hợp lệ. */
export function buildStructuredRetryHint(
  errors: SchemaValidationError[],
  language: 'vi' | 'en' = 'vi',
): string {
  const shown = errors.slice(0, 10);
  const lines = shown.map((e) => `- ${e.path}: ${e.message}`).join('\n');
  const extra = errors.length > 10 ? `\n… và ${errors.length - 10} lỗi khác.` : '';
  if (language === 'en') {
    return (
      'Your previous answer was not valid. Errors:\n' +
      lines +
      extra +
      '\nPlease return ONLY JSON matching the schema, with no extra explanation.'
    );
  }
  return (
    'Lần trả trước của bạn không hợp lệ. Lỗi:\n' +
    lines +
    extra +
    '\nHãy trả lại CHỈ JSON đúng schema, không thêm giải thích.'
  );
}

/** Câu báo lỗi cho user khi structured output thất bại sau mọi lần thử. */
export function formatStructuredError(
  result: StructuredParseResult,
  language: 'vi' | 'en' = 'vi',
): string {
  const lines = result.errors.map((e) => `- ${e.path}: ${e.message}`).join('\n');
  if (language === 'en') {
    return (
      'Could not produce a valid structured answer:\n' +
      lines +
      `\nOriginal model text:\n${result.rawText}`
    );
  }
  return (
    'Không tạo được kết quả đúng định dạng yêu cầu:\n' +
    lines +
    `\nVăn bản gốc của model:\n${result.rawText}`
  );
}

// ---------------------------------------------------------------------------
// Thử lại tối đa N lần
// ---------------------------------------------------------------------------

/**
 * Callback sản xuất text: lần thử `attempt` (0 = lần đầu), `retryHint`
 * rỗng ở lần đầu và là prompt nhắc lỗi ở các lần sau. Production: gọi
 * lại `provider.chat()` với retryHint như một user message. Test: hàm giả.
 */
export type StructuredProducer = (attempt: number, retryHint: string) => Promise<string>;

export interface StructuredRetryResult<T = unknown> extends StructuredParseResult<T> {
  /** Số lần đã thử (1 = thành công ngay lần đầu). */
  attempts: number;
}

/**
 * Parse + validate, thử lại tối đa `maxRetries` lần khi fail. Mỗi lần
 * thử lại, producer nhận prompt nhắc liệt kê lỗi lần trước. Hết lượt mà
 * vẫn fail → trả kết quả lỗi cuối cùng kèm text gốc (không throw).
 */
export async function parseStructuredWithRetry<T = unknown>(
  produce: StructuredProducer,
  schema: JsonSchema,
  opts: { maxRetries?: number; language?: 'vi' | 'en' } = {},
): Promise<StructuredRetryResult<T>> {
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? 2));
  const language = opts.language ?? 'vi';
  let retryHint = '';
  let last: StructuredParseResult<T> | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const text = await produce(attempt, retryHint);
    const result = parseStructuredOutput<T>(text, schema);
    if (result.ok) return { ...result, attempts: attempt + 1 };
    last = result;
    retryHint = buildStructuredRetryHint(result.errors, language);
  }
  return { ...(last as StructuredParseResult<T>), attempts: maxRetries + 1 };
}
