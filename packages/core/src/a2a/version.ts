/**
 * A2A protocol version negotiation (v0.97, Đội T2) — A2A 1.0.
 *
 * A2A 1.0 stable 03/2026, 1.0.1 05/2026 (xem docs/repo-survey-v097.md
 * §2). Client và server có thể nói các bản khác nhau: trước khi giao
 * task, hai bên đàm phán bản chung cao nhất mà cả hai đều hỗ trợ.
 * Quy tắc tương thích của open-bot:
 *  - Cùng major (1.x) → tương thích; bản đàm phán = bản cao nhất
 *    chung (vd client [1.0, 1.0.1] + server [1.0] → 1.0).
 *  - Khác major (vd 2.0) → KHÔNG tương thích, từ chối giao task
 *    với lỗi rõ ràng thay vì gửi rồi nhận lỗi khó hiểu.
 *  - Card không ghi protocolVersion → coi như 1.0 (server cũ
 *    trước khi có version negotiation), kèm cảnh báo.
 *  - Chuỗi version lạ (không parse được) → không tương thích.
 *
 * Chỉ dùng type + helper thuần, không gọi mạng.
 */

/** Bản protocol mà open-bot nói (bản mới nhất nó hỗ trợ). */
export const A2A_PROTOCOL_VERSION = '1.0.1';

/** Mọi bản protocol open-bot hỗ trợ, mới nhất trước. */
export const A2A_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['1.0.1', '1.0'];

/** Bản protocol tối thiểu open-bot chấp nhận từ phía đối tác. */
export const A2A_MIN_PROTOCOL_VERSION = '1.0';

export interface A2aParsedVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

/**
 * Parse chuỗi version dạng `MAJOR.MINOR` hoặc `MAJOR.MINOR.PATCH`
 * (chấp nhận thêm hậu tố `-rc.1`/`+build` thì bỏ qua phần hậu tố).
 * Trả null khi không parse được (vd '', 'v1', 'banana', '1.0.0.0').
 */
export function parseA2aProtocolVersion(raw: string | undefined | null): A2aParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return { major, minor, patch, raw: text };
}

/**
 * So sánh hai bản đã parse: <0 khi a < b, 0 khi bằng, >0 khi a > b.
 * So theo major → minor → patch.
 */
export function compareA2aProtocolVersions(
  a: A2aParsedVersion,
  b: A2aParsedVersion,
): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Hai bản có tương thích không: cùng major VÀ cả hai đều >= bản tối
 * thiểu (1.0). Bản 0.x (tiền-1.0) không tương thích với 1.x.
 */
export function isCompatibleProtocolVersion(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const pa = parseA2aProtocolVersion(a);
  const pb = parseA2aProtocolVersion(b);
  if (!pa || !pb) return false;
  if (pa.major !== pb.major) return false;
  const min = parseA2aProtocolVersion(A2A_MIN_PROTOCOL_VERSION);
  if (!min) return false;
  return compareA2aProtocolVersions(pa, min) >= 0 && compareA2aProtocolVersions(pb, min) >= 0;
}

export interface A2aNegotiationResult {
  /** true khi tìm được bản chung (cùng major 1.x). */
  ok: boolean;
  /** Bản chung cao nhất (null khi không đàm phán được). */
  negotiated: string | null;
  /** Bản client đề xuất mà server không hỗ trợ (để log/cảnh báo). */
  unsupportedRequested?: string[];
  /** Lý do khi ok=false (hiển thị cho user). */
  reason?: string;
}

/**
 * Đàm phán bản protocol chung: trong cùng major 1.x, bản minor mới
 * tương thích ngược với bản cũ — hai bên dùng được bản cao nhất mà
 * cả hai đều "nói được", tức min(max(client), max(server)). Vd
 * client [1.0.1] + server [1.0] → 1.0; client [1.0] + server
 * [1.0.1] → 1.0. Khác major hoặc một bên không có bản 1.x nào →
 * fail closed. Danh sách trống một bên → coi như bên đó chỉ nói
 * bản mặc định của open-bot (1.0.1).
 */
export function negotiateProtocolVersion(
  clientVersions: readonly string[] | undefined | null,
  serverVersions: readonly string[] | undefined | null,
): A2aNegotiationResult {
  const clientList = Array.isArray(clientVersions) && clientVersions.length > 0
    ? clientVersions
    : [A2A_PROTOCOL_VERSION];
  const serverList = Array.isArray(serverVersions) && serverVersions.length > 0
    ? serverVersions
    : [A2A_PROTOCOL_VERSION];
  const ownMajor = parseA2aProtocolVersion(A2A_PROTOCOL_VERSION)?.major ?? 1;
  const min = parseA2aProtocolVersion(A2A_MIN_PROTOCOL_VERSION) as A2aParsedVersion;
  const usable = (list: readonly string[]): A2aParsedVersion[] =>
    list
      .map((v) => parseA2aProtocolVersion(v))
      .filter(
        (v): v is A2aParsedVersion =>
          v !== null && v.major === ownMajor && compareA2aProtocolVersions(v, min) >= 0,
      );
  const clientUsable = usable(clientList);
  const serverUsable = usable(serverList);
  if (clientUsable.length === 0 || serverUsable.length === 0) {
    return {
      ok: false,
      negotiated: null,
      unsupportedRequested: clientList.filter((v) => {
        const p = parseA2aProtocolVersion(v);
        return !p || p.major !== ownMajor || compareA2aProtocolVersions(p, min) < 0;
      }),
      reason:
        `Không có protocol version chung: client nói [${clientList.join(', ')}], ` +
        `server nói [${serverList.join(', ')}] — open-bot chỉ hỗ trợ major 1.x.`,
    };
  }
  const maxOf = (list: A2aParsedVersion[]): A2aParsedVersion =>
    [...list].sort(compareA2aProtocolVersions).pop() as A2aParsedVersion;
  const clientMax = maxOf(clientUsable);
  const serverMax = maxOf(serverUsable);
  const best = compareA2aProtocolVersions(clientMax, serverMax) <= 0 ? clientMax : serverMax;
  const unsupported = clientList.filter((v) => {
    const p = parseA2aProtocolVersion(v);
    return !p || p.major !== ownMajor || compareA2aProtocolVersions(p, min) < 0;
  });
  return {
    ok: true,
    negotiated: best.raw,
    ...(unsupported.length > 0 ? { unsupportedRequested: unsupported } : {}),
  };
}

export interface A2aCardVersionCheck {
  /** true khi card dùng được (tương thích major 1.x). */
  ok: boolean;
  /** Bản protocol trong card (null khi card không ghi — coi như 1.0). */
  cardVersion: string | null;
  /** Bản sẽ dùng khi giao tiếp với agent này. */
  negotiated: string | null;
  /** Cảnh báo không chặn (vd card không ghi version, bản cũ). */
  warnings: string[];
  /** Lý do khi ok=false. */
  reason?: string;
}

/**
 * Kiểm tra protocol version trong một Agent Card (client đọc card
 * xong gọi hàm này trước khi giao task). Card thiếu
 * `protocolVersion` → coi như 1.0 + cảnh báo (server cũ); card
 * ghi bản major khác (vd 2.0) → ok=false.
 */
export function checkAgentCardVersion(
  card: { protocolVersion?: string | null } | undefined | null,
): A2aCardVersionCheck {
  if (!card || typeof card !== 'object') {
    return {
      ok: false,
      cardVersion: null,
      negotiated: null,
      warnings: [],
      reason: 'Không có Agent Card để kiểm tra protocol version.',
    };
  }
  const raw = typeof card.protocolVersion === 'string' ? card.protocolVersion : null;
  if (raw === null || raw.trim().length === 0) {
    return {
      ok: true,
      cardVersion: null,
      negotiated: A2A_MIN_PROTOCOL_VERSION,
      warnings: [
        'Agent Card không ghi protocolVersion — coi như 1.0 (agent cũ, trước version negotiation).',
      ],
    };
  }
  const parsed = parseA2aProtocolVersion(raw);
  if (!parsed) {
    return {
      ok: false,
      cardVersion: raw,
      negotiated: null,
      warnings: [],
      reason: `protocolVersion trong Agent Card không đọc được: "${raw}".`,
    };
  }
  const result = negotiateProtocolVersion([raw], [...A2A_SUPPORTED_PROTOCOL_VERSIONS]);
  if (!result.ok) {
    return {
      ok: false,
      cardVersion: raw,
      negotiated: null,
      warnings: [],
      reason: result.reason,
    };
  }
  const warnings: string[] = [];
  if (compareA2aProtocolVersions(parsed, parseA2aProtocolVersion(A2A_PROTOCOL_VERSION) as A2aParsedVersion) < 0) {
    warnings.push(
      `Agent dùng protocol ${raw} (cũ hơn ${A2A_PROTOCOL_VERSION} của open-bot) — vẫn tương thích, một số tính năng mới có thể thiếu.`,
    );
  }
  return { ok: true, cardVersion: raw, negotiated: result.negotiated, warnings };
}

/**
 * Header version client gửi kèm mỗi request A2A (`A2A-Version`).
 * Server cũ bỏ qua header lạ nên gửi kèm là an toàn.
 */
export function a2aVersionHeader(): Record<string, string> {
  return { 'A2A-Version': A2A_PROTOCOL_VERSION };
}
