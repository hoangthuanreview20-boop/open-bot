/**
 * Handoff chuẩn giữa các bot — v0.12 mục 1.
 *
 * Khi agent A chuyển việc cho bot B (tool `transfer_to_<tên bot>`), toàn bộ
 * hội thoại liên quan — yêu cầu gốc của user, tóm tắt các bước đã làm, kết
 * quả trung gian — được mang sang B trong một payload duy nhất, để B tiếp
 * tục thay vì bắt đầu lại từ đầu.
 *
 * Module này là API thuần (pure): không gọi provider, không chạm
 * coordinator, không chạm memory hay loop. Điều phối viên sẽ nối nó vào
 * coordinator (đăng ký tool `transfer_to_X`) và vào loop sau; ở đây chỉ
 * định nghĩa payload, kiểm tra hop và ghi lịch sử để trace/debug.
 *
 * Quy ước đặt tên (theo pattern OpenAI Agents SDK, viết lại từ đầu):
 * tool chuyển cho bot tên `code` là `transfer_to_code`; tên bot được
 * slug hoá (chữ thường, ký tự lạ thành `_`) để thành tên tool hợp lệ.
 */

export const MAX_HANDOFF_HOPS = 5;

/** Số ký tự tối đa của transcript mang sang bot nhận (chống tràn context). */
export const MAX_HANDOFF_TRANSCRIPT_CHARS = 20_000;

/** Số ký tự tối đa cho một kết quả trung gian trong payload. */
export const MAX_HANDOFF_RESULT_CHARS = 5_000;

export type HandoffRole = 'system' | 'user' | 'assistant' | 'tool';

/** Một dòng hội thoại mang sang bot nhận (tương thích ChatMessage). */
export interface HandoffMessage {
  role: HandoffRole;
  content: string;
  /** Tên tool, chỉ dùng cho role 'tool'. */
  toolCallId?: string;
}

export interface HandoffIntermediateResult {
  /** Bước đã làm, vd "đọc file src/index.ts". */
  step: string;
  /** Kết quả của bước đó (đã cắt ngắn khi build payload). */
  output: string;
}

/** Một lần handoff đã xảy ra — dùng để trace/debug và chống lặp. */
export interface HandoffRecord {
  fromBot: string;
  toBot: string;
  /** Lý do chuyển, vd "cần chuyên môn code". */
  reason: string;
  /** Số hop tính tới lần này (1 = lần chuyển đầu tiên của chuỗi). */
  hop: number;
  createdAt: string;
}

export interface HandoffPayload {
  fromBot: string;
  toBot: string;
  reason: string;
  createdAt: string;
  /** Số hop của chuỗi handoff này (đã tính lần hiện tại). */
  hopCount: number;
  maxHops: number;
  hopsRemaining: number;
  /** Yêu cầu gốc của user (dòng user đầu tiên của transcript). */
  originalRequest: string;
  /** Tóm tắt các bước đã làm + kết quả trung gian (do caller soạn hoặc tự sinh). */
  summary: string;
  /** Toàn bộ hội thoại liên quan (đã cắt ngắn nếu quá dài). */
  transcript: HandoffMessage[];
  /** Kết quả trung gian từng bước (đã cắt ngắn từng mục). */
  intermediateResults: HandoffIntermediateResult[];
  /** Lịch sử handoff của chuỗi này, bao gồm lần hiện tại (mới nhất cuối). */
  history: HandoffRecord[];
}

export interface CreateHandoffInput {
  fromBot: string;
  toBot: string;
  /** Lý do chuyển việc; trống thì dùng lý do mặc định. */
  reason?: string;
  /** Hội thoại liên quan (ít nhất 1 dòng). */
  transcript: HandoffMessage[];
  /** Tóm tắt các bước đã làm; trống thì tự sinh từ transcript. */
  summary?: string;
  intermediateResults?: HandoffIntermediateResult[];
  /** Lịch sử handoff của chuỗi này trước lần chuyển hiện tại. */
  history?: HandoffRecord[];
  /** Giới hạn hop; mặc định MAX_HANDOFF_HOPS (5). */
  maxHops?: number;
}

export interface HopCheck {
  allowed: boolean;
  /** Số hop sẽ là sau lần chuyển tiếp theo (hop hiện tại + 1). */
  nextHop: number;
  maxHops: number;
  hopsRemaining: number;
  /** Lý do chặn, chỉ có khi allowed = false. */
  blockReason?: string;
}

// ---------------------------------------------------------------------------
// Tên tool transfer_to_<bot>
// ---------------------------------------------------------------------------

/** Slug hoá tên bot thành phần hợp lệ của tên tool: chữ thường, `_` thay ký tự lạ. */
export function slugifyBotName(botName: string): string {
  return botName
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Tên tool để chuyển việc cho bot này, vd `transfer_to_code`. */
export function transferToolNameFor(botName: string): string {
  const slug = slugifyBotName(botName);
  if (!slug) throw new Error('transfer_to_X cần tên bot không rỗng (sau khi slug hoá).');
  return `transfer_to_${slug}`;
}

/** Có phải tool handoff `transfer_to_<...>` không. */
export function isTransferTool(toolName: string): boolean {
  return toolName.startsWith('transfer_to_') && toolName.length > 'transfer_to_'.length;
}

/**
 * Lấy slug tên bot từ tên tool handoff, hoặc null khi không phải tool
 * handoff. Lưu ý: trả về slug, không phải tên gốc (tên gốc có dấu/khoảng
 * trắng không giữ được qua tên tool — host cần map slug → bot id).
 */
export function parseTransferToolName(toolName: string): string | null {
  if (!isTransferTool(toolName)) return null;
  return toolName.slice('transfer_to_'.length);
}

// ---------------------------------------------------------------------------
// Hop counter + chống lặp
// ---------------------------------------------------------------------------

/**
 * Kiểm tra xem có được handoff thêm một hop nữa không.
 * - `hopCount` là số hop đã xảy ra trong chuỗi (0 = chưa chuyển lần nào).
 * - Vượt `maxHops` thì chặn, kèm lý do rõ ràng bằng tiếng Việt.
 */
export function checkHop(hopCount: number, maxHops: number = MAX_HANDOFF_HOPS): HopCheck {
  const max = Math.max(1, Math.floor(maxHops));
  const current = Math.max(0, Math.floor(hopCount));
  const nextHop = current + 1;
  if (nextHop > max) {
    return {
      allowed: false,
      nextHop,
      maxHops: max,
      hopsRemaining: 0,
      blockReason:
        `Đã vượt giới hạn handoff: chuỗi này đã chuyển ${current} lần (tối đa ${max} lần). ` +
        `Dừng ở đây để tránh lặp vô hạn A→B→A — trả kết quả hiện tại cho user thay vì chuyển tiếp.`,
    };
  }
  return { allowed: true, nextHop, maxHops: max, hopsRemaining: max - nextHop };
}

/**
 * Phát hiện vòng lặp A→B→A trong lịch sử: trả về true khi cặp
 * (fromBot → toBot) sắp chuyển đã từng xảy ra trong chuỗi. Đây là tín
 * hiệu cảnh báo (caller có thể vẫn cho qua nếu hop còn), còn giới hạn
 * hop ở checkHop mới là rào chặn cứng.
 */
export function wouldRepeatHandoff(
  history: HandoffRecord[],
  fromBot: string,
  toBot: string,
): boolean {
  const from = fromBot.trim();
  const to = toBot.trim();
  return history.some((r) => r.fromBot === from && r.toBot === to);
}

/** Chuỗi bot đã đi qua theo lịch sử, vd ["A", "B", "A"] (để hiển thị trace). */
export function handoffChain(history: HandoffRecord[]): string[] {
  const chain: string[] = [];
  for (const record of history) {
    if (chain.length === 0) chain.push(record.fromBot);
    chain.push(record.toBot);
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Tóm tắt + cắt ngắn transcript
// ---------------------------------------------------------------------------

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... đã cắt ngắn còn ${maxChars} ký tự ...]`;
}

/** Yêu cầu gốc của user: nội dung dòng user đầu tiên, '' khi không có. */
export function extractOriginalRequest(transcript: HandoffMessage[]): string {
  const firstUser = transcript.find((m) => m.role === 'user');
  return firstUser ? firstUser.content.trim() : '';
}

/**
 * Tóm tắt transcript thành vài dòng: yêu cầu gốc + số dòng theo role +
 * 3 dòng gần nhất (đã cắt ngắn). Dùng khi caller không soạn summary riêng.
 */
export function summarizeTranscript(transcript: HandoffMessage[]): string {
  const request = extractOriginalRequest(transcript);
  const counts = new Map<string, number>();
  for (const m of transcript) counts.set(m.role, (counts.get(m.role) ?? 0) + 1);
  const countText = [...counts.entries()].map(([role, n]) => `${n} ${role}`).join(', ');
  const lines: string[] = [];
  if (request) lines.push(`Yêu cầu gốc của user: ${truncate(request, 500)}`);
  lines.push(`Hội thoại đã có ${transcript.length} dòng (${countText}).`);
  const recent = transcript.slice(-3);
  for (const m of recent) {
    lines.push(`- [${m.role}] ${truncate(m.content.replace(/\s+/g, ' ').trim(), 300)}`);
  }
  return lines.join('\n');
}

/** Cắt ngắn transcript về tối đa `maxChars` (ưu tiên giữ dòng đầu + dòng cuối). */
export function truncateTranscript(
  transcript: HandoffMessage[],
  maxChars: number = MAX_HANDOFF_TRANSCRIPT_CHARS,
): HandoffMessage[] {
  const total = transcript.reduce((sum, m) => sum + m.content.length, 0);
  if (total <= maxChars) return transcript.map((m) => ({ ...m }));
  // Giữ dòng user đầu tiên + các dòng cuối cho đủ ngân sách ký tự.
  const kept: HandoffMessage[] = [];
  let used = 0;
  const firstUserIdx = transcript.findIndex((m) => m.role === 'user');
  if (firstUserIdx >= 0) {
    const first = transcript[firstUserIdx];
    kept.push({ ...first, content: truncate(first.content, Math.min(first.content.length, 2_000)) });
    used += kept[0].content.length;
  }
  for (let i = transcript.length - 1; i >= 0 && used < maxChars; i--) {
    if (i === firstUserIdx) continue;
    const msg = transcript[i];
    const budget = Math.max(0, maxChars - used);
    if (budget <= 0) break;
    kept.push({ ...msg, content: truncate(msg.content, budget) });
    used += kept[kept.length - 1].content.length;
  }
  // Khôi phục đúng thứ tự thời gian (dòng đầu giữ đầu, các dòng cuối giữ cuối).
  const tail = kept.slice(1).reverse();
  return firstUserIdx >= 0 ? [kept[0], ...tail] : tail;
}

// ---------------------------------------------------------------------------
// Build payload
// ---------------------------------------------------------------------------

/**
 * Tạo payload handoff từ transcript + metadata.
 * - Ném lỗi khi: from/to rỗng, from == to, transcript rỗng, vượt giới hạn hop.
 * - Không ném lỗi khi cặp handoff đã từng xảy ra (chỉ là vòng lặp tiềm
 *   ẩn) — caller xem `wouldRepeatHandoff()` để cảnh báo; rào chặn cứng
 *   vẫn là hop counter.
 */
export function createHandoff(input: CreateHandoffInput): HandoffPayload {
  const fromBot = input.fromBot.trim();
  const toBot = input.toBot.trim();
  if (!fromBot) throw new Error('Handoff cần tên bot nguồn (fromBot) không rỗng.');
  if (!toBot) throw new Error('Handoff cần tên bot đích (toBot) không rỗng.');
  if (fromBot === toBot) {
    throw new Error(`Không handoff cho chính mình: fromBot và toBot đều là "${fromBot}".`);
  }
  if (!input.transcript || input.transcript.length === 0) {
    throw new Error('Handoff cần transcript không rỗng — bot nhận cần biết user đã hỏi gì.');
  }
  for (const m of input.transcript) {
    if (typeof m.content !== 'string' || m.content.trim() === '') {
      throw new Error('Handoff: transcript có dòng nội dung rỗng — bỏ dòng đó hoặc điền nội dung.');
    }
  }
  const history = [...(input.history ?? [])];
  const hop = checkHop(history.length, input.maxHops ?? MAX_HANDOFF_HOPS);
  if (!hop.allowed) throw new Error(hop.blockReason ?? 'Đã vượt giới hạn handoff.');
  const record: HandoffRecord = {
    fromBot,
    toBot,
    reason: (input.reason ?? '').trim() || 'chuyển việc cho bot chuyên môn phù hợp hơn',
    hop: hop.nextHop,
    createdAt: new Date().toISOString(),
  };
  const summary = (input.summary ?? '').trim() || summarizeTranscript(input.transcript);
  return {
    fromBot,
    toBot,
    reason: record.reason,
    createdAt: record.createdAt,
    hopCount: hop.nextHop,
    maxHops: hop.maxHops,
    hopsRemaining: hop.hopsRemaining,
    originalRequest: extractOriginalRequest(input.transcript),
    summary,
    transcript: truncateTranscript(input.transcript),
    intermediateResults: (input.intermediateResults ?? []).map((r) => ({
      step: r.step.trim(),
      output: truncate(r.output, MAX_HANDOFF_RESULT_CHARS),
    })),
    history: [...history, record],
  };
}

/**
 * Render payload thành một khối text để chèn vào đầu context của bot
 * nhận (vd làm system message bổ sung hoặc user message đầu tiên), để
 * bot nhận tiếp tục công việc mà không hỏi lại user từ đầu.
 */
export function formatHandoffForPrompt(payload: HandoffPayload): string {
  const lines: string[] = [
    `[handoff] Bot "${payload.fromBot}" chuyển việc này cho bạn (bot "${payload.toBot}") — hop ${payload.hopCount}/${payload.maxHops}.`,
    `Lý do: ${payload.reason}`,
    `Yêu cầu gốc của user: ${payload.originalRequest || '(không rõ)'}`,
    ``,
    `Tóm tắt các bước đã làm:`,
    payload.summary,
  ];
  if (payload.intermediateResults.length > 0) {
    lines.push('', 'Kết quả trung gian:');
    for (const r of payload.intermediateResults) {
      lines.push(`- ${r.step}: ${r.output.replace(/\s+/g, ' ').trim()}`);
    }
  }
  lines.push(
    '',
    `Lịch sử handoff: ${handoffChain(payload.history).join(' → ')}`,
    `Tiếp tục công việc từ đây, đừng hỏi lại user những gì đã có trong hội thoại trên.`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Lịch sử handoff (trace/debug) — giữ trong bộ nhớ, không ghi file.
// ---------------------------------------------------------------------------

/**
 * Sổ ghi handoff của một phiên/coordinator: append-only, tra cứu theo
 * bot, phát hiện lặp. Không tự persist — host muốn lưu lâu dài thì tự
 * serialize `list()` (JSON) ra nơi khác.
 */
export class HandoffLog {
  private readonly records: HandoffRecord[] = [];

  /** Ghi một lần handoff (thường là `payload.history.at(-1)`). */
  record(entry: HandoffRecord): void {
    this.records.push({ ...entry });
  }

  /** Ghi toàn bộ history của một payload (bỏ qua các record đã có). */
  recordPayload(payload: HandoffPayload): void {
    for (const entry of payload.history) {
      const exists = this.records.some(
        (r) =>
          r.fromBot === entry.fromBot &&
          r.toBot === entry.toBot &&
          r.hop === entry.hop &&
          r.createdAt === entry.createdAt,
      );
      if (!exists) this.record(entry);
    }
  }

  /** Toàn bộ lịch sử, theo thứ tự ghi. */
  list(): HandoffRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  /** Các lần handoff có bot này tham gia (nguồn hoặc đích). */
  listForBot(botName: string): HandoffRecord[] {
    const name = botName.trim();
    return this.list().filter((r) => r.fromBot === name || r.toBot === name);
  }

  /** Cặp (from → to) này đã từng xảy ra chưa (dấu hiệu lặp A→B→A). */
  hasRepeated(fromBot: string, toBot: string): boolean {
    return wouldRepeatHandoff(this.records, fromBot, toBot);
  }

  /** Số hop đã xảy ra trong chuỗi gần nhất (độ dài lịch sử). */
  hopCount(): number {
    return this.records.length;
  }

  clear(): void {
    this.records.length = 0;
  }
}
