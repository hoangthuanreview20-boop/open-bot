/**
 * Deep-link `open-bot://` — parser thuần, KHÔNG phụ thuộc Electron.
 *
 * Phân biệt với URI resource MCP (`open-bot://info`, `open-bot://workspace`
 * trong `packages/core/src/mcp/server.ts`): đó là URI nội bộ của MCP
 * server, không phải deep-link hệ điều hành. Parser này chỉ phục vụ
 * deep-link OS: người dùng / app khác mở `open-bot://...` thì hệ điều
 * hành khởi động (hoặc đánh thức) app desktop và main process chuyển
 * URL thành route nội bộ cho renderer.
 *
 * Route hỗ trợ:
 *   open-bot://                     -> { kind: 'chat' } (màn hình chính)
 *   open-bot://chat                 -> { kind: 'chat' }
 *   open-bot://bot/<botId>          -> { kind: 'bot', botId }
 *   open-bot://bot?id=<botId>       -> { kind: 'bot', botId }
 *   open-bot://settings             -> { kind: 'settings' }
 *   open-bot://canvas               -> { kind: 'canvas' }
 *
 * Dạng `open-bot:///bot/<botId>` và `open-bot:/bot/<botId>` cũng được
 * chấp nhận (một số launcher / trình duyệt gửi URL không có host).
 * Mọi URL khác (scheme sai, route lạ, thiếu botId, botId chứa ký tự
 * lạ, thừa segment, `%` encode hỏng) -> `{ ok: false, reason }`:
 * caller bỏ qua an toàn, log lý do, KHÔNG crash, KHÔNG mở gì cả.
 */

export const DEEP_LINK_SCHEME = 'open-bot';

export type DeepLinkRoute =
  | { kind: 'chat' }
  | { kind: 'bot'; botId: string }
  | { kind: 'settings' }
  | { kind: 'canvas' };

export type DeepLinkParseResult =
  | { ok: true; route: DeepLinkRoute }
  | { ok: false; reason: string };

/** Bot id do open-bot tự sinh là UUID; template/clone cũng dùng id an toàn. */
const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

function fail(reason: string): DeepLinkParseResult {
  return { ok: false, reason };
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Parse một URL `open-bot://...` thành route nội bộ.
 * Không throw với mọi đầu vào (kể cả non-string): trả `{ ok: false }`.
 */
export function parseDeepLink(raw: unknown): DeepLinkParseResult {
  if (typeof raw !== 'string') return fail('deep-link không phải chuỗi');
  const input = raw.trim();
  if (input.length === 0) return fail('deep-link rỗng');
  if (input.length > 2048) return fail('deep-link quá dài');
  // URL parser của Node chấp nhận backslash ở một số vị trí; từ chối
  // thẳng để `open-bot://bot\evil` không bị hiểu nhầm thành path.
  if (input.includes('\\')) return fail('deep-link chứa ký tự \\');
  // Từ chối segment `.` / `..` trong path TRƯỚC khi parse: URL parser
  // tự chuẩn hoá `open-bot://bot/../etc` thành `open-bot://bot/etc`,
  // che mất ý định traversal trong URL gốc.
  const pathPart = input.split(/[?#]/, 1)[0];
  for (const seg of pathPart.split('/')) {
    if (seg === '.' || seg === '..') return fail('deep-link chứa segment . / ..');
  }
  // Ký tự điều khiển / khoảng trắng giữa URL là dấu hiệu URL ghép sai.
  if (/[\u0000-\u0020\u007f]/.test(input)) return fail('deep-link chứa ký tự trắng/điều khiển');

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail('không parse được URL');
  }
  if (url.protocol.toLowerCase() !== `${DEEP_LINK_SCHEME}:`) {
    return fail(`scheme phải là ${DEEP_LINK_SCHEME}://`);
  }
  // open-bot://user:pass@... hoặc có port đều vô nghĩa với deep-link.
  if (url.username !== '' || url.password !== '' || url.port !== '') {
    return fail('deep-link không được chứa userinfo/port');
  }

  // Gom host + các segment của path thành một danh sách segment.
  //   open-bot://bot/<id>    -> host 'bot', path '/<id>'
  //   open-bot:///bot/<id>    -> host '',    path '/bot/<id>'
  //   open-bot://settings     -> host 'settings', path '/'
  const segments: string[] = [];
  if (url.hostname !== '') segments.push(url.hostname);
  for (const part of url.pathname.split('/')) {
    if (part !== '') segments.push(part);
  }
  const decoded: string[] = [];
  for (const seg of segments) {
    const d = decodeSegment(seg);
    if (d === null) return fail('segment encode hỏng (phần trăm không hợp lệ)');
    decoded.push(d);
  }

  // Không có segment nào: `open-bot://`, `open-bot:///` -> màn hình chính.
  if (decoded.length === 0) return { ok: true, route: { kind: 'chat' } };

  const [first, ...rest] = decoded as [string, ...string[]];
  const head = first.toLowerCase();

  if (head === 'chat') {
    if (rest.length > 0) return fail('route chat không nhận thêm segment');
    return { ok: true, route: { kind: 'chat' } };
  }
  if (head === 'settings') {
    if (rest.length > 0) return fail('route settings không nhận thêm segment');
    return { ok: true, route: { kind: 'settings' } };
  }
  if (head === 'canvas') {
    if (rest.length > 0) return fail('route canvas không nhận thêm segment');
    return { ok: true, route: { kind: 'canvas' } };
  }
  if (head === 'bot') {
    let botId: string | null = null;
    if (rest.length === 1) {
      botId = rest[0];
    } else if (rest.length === 0) {
      // Dạng query: open-bot://bot?id=<botId>
      const q = url.searchParams.get('id');
      if (q !== null && q !== '') botId = q;
    } else {
      return fail('route bot chỉ nhận đúng 1 botId');
    }
    if (botId === null || botId === '') return fail('route bot thiếu botId');
    if (!BOT_ID_RE.test(botId)) return fail('botId chứa ký tự không hợp lệ');
    return { ok: true, route: { kind: 'bot', botId } };
  }
  return fail(`route không hỗ trợ: ${first}`);
}

/**
 * Tìm URL deep-link đầu tiên trong argv (Windows/Linux: instance thứ
 * hai / lần khởi động qua protocol truyền URL trong argv; macOS dùng
 * event `open-url` nên không cần hàm này). Trả null nếu không có.
 * Bỏ qua argv[0] (đường dẫn executable) và argv[1] (đường dẫn app).
 */
export function extractDeepLinkFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    const trimmed = arg.trim();
    if (/^open-bot:/i.test(trimmed)) return trimmed;
  }
  return null;
}

/** Render lại route thành URL deep-link chuẩn (dùng cho log/test). */
export function deepLinkToString(route: DeepLinkRoute): string {
  switch (route.kind) {
    case 'chat':
      return `${DEEP_LINK_SCHEME}://chat`;
    case 'settings':
      return `${DEEP_LINK_SCHEME}://settings`;
    case 'canvas':
      return `${DEEP_LINK_SCHEME}://canvas`;
    case 'bot':
      return `${DEEP_LINK_SCHEME}://bot/${encodeURIComponent(route.botId)}`;
  }
}
