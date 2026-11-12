/**
 * Ước lượng token, hiệu chuẩn bằng tokenizer thật (v0.24, W17b).
 *
 * Gap ghi từ lâu: `compaction.ts` và `smallModel.ts` đều ước lượng token
 * bằng `ceil(chars / 4)`. Hệ số đó sai lệch lớn theo loại text. v0.21
 * (W13b) thay bằng heuristic theo từng loại đoạn text — nhưng các điểm
 * "kỳ vọng" của nó chỉ là ước lượng từ quy tắc BPE công khai, chưa từng
 * đo bằng tokenizer thật. Bản này hiệu chuẩn heuristic đó bằng
 * `tiktoken` (devDependency, `cl100k_base` — BPE của họ GPT-3.5/4) trên
 * corpus đoạn văn/code thật (xem `tests/token-benchmark-corpus.mjs`).
 *
 * Quy tắc (mỗi quy tắc đều có số đo đằng sau — xem benchmark dưới):
 *  - từ Latin ASCII: `1 + max(0, số_chữ − 8) / 5` — từ thường ≤8 chữ
 *    là 1 token trong BPE khi đứng sau khoảng trắng (`" renovated"` =
 *    1 token, `" construction"` = 1 token); chỉ từ dài mới tách thêm.
 *    (Quy tắc cũ `số_chữ/4` tính thừa ~30% trên văn xuôi tiếng Anh.)
 *  - từ Latin có dấu (vd tiếng Việt): `2.25` token/âm tiết cố định
 *    (+ thêm như từ ASCII nếu dài hơn 8 chữ, hiếm) — đo thật: âm tiết
 *    tiếng Việt ~2.2 token (ký tự có dấu tách thành nhiều byte-token;
 *    vd `"Tôi"` = 3, `"đang"` = 2, `"thành"` = 1 khi có khoảng trắng
 *    trước). Quy tắc cũ (+0.25) tính thiếu ~38%.
 *  - chữ CJK (Hán/Hiragana/Katakana/Hangul): `1.25` token/chữ — đo
 *    thật trên văn xuôi: Hán ~1.22, Nhật ~1.16, Hàn ~1.0–1.5 ký tự
 *    hiếm tách thành 2 token. Quy tắc cũ (1/chữ) tính thiếu ~19%.
 *  - dãy số: `max(1, ceil(số_chữ_số / 3))` — BPE tách số theo nhóm tối
 *    đa ~3 chữ số (`"2026"` → 2 token), giữ nguyên từ v0.21.
 *  - dãy ký tự đặc biệt: `ceil(số_ký_tự / 3)` — chạy dài ký tự đặc
 *    biệt thường gộp (`"!!!"` = 1, `"..."` = 1, `"((()))"` = 2).
 *  - ký tự emoji: `2.75` token/ký tự (đo: 😀 = 2, 🎉/🔥/👏 = 3,
 *    🇻🇳 = 6 cho 2 ký tự) — variation selector U+FE0F và ZWJ U+200D
 *    tính 0 (chúng chỉ sửa emoji đứng trước). Quy tắc cũ
 *    (`ceil(n/2)` cho cả dãy) tính thiếu ~68% trên tin nhắn emoji.
 *  - dấu câu đơn gộp với từ sau: một ký tự dấu câu trong tập
 *    `. / < : ; ( [ { " $ % * + - = |` đứng sát trước một từ Latin
 *    thường gộp thành 1 token với từ đó (`".log"`, `"/api"`, `"<K"`,
 *    `"(x"` đều = 1 token), nên dấu đó tính 0; các dấu `' # @ & ? !
 *    ~ ^ \`` không gộp (`"'x"` = 2 token). Ngoại lệ: `'` + đuôi rút
 *    gọn (`'s/'t/'d/'m/'re/'ll/'ve`, vd `"don't"` = 2 token) tính 0.
 *  - khoảng trắng: KHÔNG còn tính 0 tuyệt đối. Khoảng trắng đứng
 *    trước từ Latin/Hangul/dấu câu/emoji thì gộp vào token sau (1
 *    khoảng trắng = 0; dãy ≥2 khoảng trắng = 1 token — `"  "` và
 *    `"    "` đều là 1 token); khoảng trắng trước dãy số hoặc chữ
 *    Hán/Kana thì đứng riêng (mỗi khoảng trắng = 1 token — `" 123"`
 *    = `" "` + `"123"`); khoảng trắng cuối chuỗi = 1 token; xuống
 *    dòng gộp với dấu câu đứng trước (`"{\n"`, `";\n"` đều = 1 token)
 *    nhưng đứng riêng sau từ thường (`"hello\nworld"` = 3 token),
 *    nên mỗi cặp `"\n\n"` sau từ thường tính ~1 token.
 * Tổng phân số được `ceil` một lần ở cuối (không ceil từng từ, để
 * nhiều từ ngắn không bị đội lên).
 *
 * BENCHMARK (đo bằng `tiktoken` 1.0.22, `cl100k_base`, corpus
 * `tests/token-benchmark-corpus.mjs`: 22 mẫu — 4 Anh, 4 Việt, 4 code,
 * 4 CJK, 3 số, 3 đặc biệt/emoji; sai số tương đối = |ước − thật|/thật):
 *  - tiếng Anh:      trung bình 3.1%, tệ nhất 6.0%  (cũ: 30.3% / 41.8%)
 *  - tiếng Việt:     trung bình 0.4%, tệ nhất 0.6%  (cũ: 38.4% / 38.9%)
 *  - code JS/TS:     trung bình 4.6%, tệ nhất 9.6%  (cũ: 22.2% / 31.4%)
 *  - CJK:            trung bình 1.4%, tệ nhất 3.3%  (cũ: 19.2% / 22.2%)
 *  - chuỗi số:       trung bình 0.0%, tệ nhất 0.0%  (cũ: 6.9% / 10.9%)
 *  - đặc biệt/emoji: trung bình 6.2%, tệ nhất 14.0% (cũ: 42.9% / 68.0%)
 *  - TOÀN CORPUS:   trung bình 2.6% (cũ: 26.8%).
 * ("Cũ" = heuristic v0.21 đo trên cùng corpus; xem test
 * `tests/token-estimate-v020.test.mjs` để tái tạo.)
 *
 * GIỚI HẠN CÒN LẠI (đừng dùng hàm này để tính tiền chính xác):
 *  - Số đo trên là so với `cl100k_base` của OpenAI. Grok (xAI),
 *    Anthropic, Gemini dùng BPE khác nên sai số với chúng chỉ là tham
 *    chiếu — thứ tự độ lớn tương tự nhưng từng con số sẽ lệch.
 *  - Văn bản lặp lại một câu ngắn (corpus tổng hợp cũ) là trường hợp
 *    xấu nhất: câu CJK quen thuộc gộp bigram (`"一个"` = 1 token cho
 *    2 chữ) nên ước lượng thừa ~33% (thật 1300, ước 1725); câu tiếng
 *    Việt lặp thừa ~19% (thật 1751, ước 2075) vì câu đó chứa nhiều âm
 *    tiết 1-token (`"thành"`, `"Minh"`, `"hay"`). Văn xuôi thật không
 *    lặp thì sát như bảng trên. Hướng ước lượng thừa là hướng an toàn
 *    cho compaction/guard (kích hoạt sớm hơn thay vì muộn hơn).
 *  - Chuỗi ký tự lặp vô nghĩa (`"a"×100` thật 13 token nhưng ước 20;
 *    `"z"×100` thật 50) không theo quy tắc nào — BPE gộp ký tự lặp
 *    theo từng token có sẵn trong vocab, heuristic không đoán được.
 *  - Số token từng âm tiết tiếng Việt dao động 1–4 theo tần suất từ
 *    (âm tiết quen thuộc gộp với khoảng trắng thành 1 token); 2.25 là
 *    trung bình, từng câu ngắn có thể lệch ±20%.
 * Khi cần số token CHÍNH XÁC (vd tính chi phí), phải đếm bằng
 * tokenizer thật của provider — hàm này không thay thế việc đó.
 */

/** Tách text thành: khoảng trắng | 1 ký tự CJK | từ | dãy số | dãy khác. */
const CHUNK_RE =
  /(\s+)|[\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]|[\p{L}]+|[\p{N}]+|[^\s\p{L}\p{N}]+/gu;

/** Một ký tự CJK đơn (đã tách riêng bởi `CHUNK_RE`). */
const CJK_CHAR_RE =
  /^[\u1100-\u11FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]$/u;

/** Ký tự Hangul (tiếng Hàn): khoảng trắng trước nó gộp như từ Latin,
 *  khác với chữ Hán/Kana (khoảng trắng đứng riêng) — đo thật: `" 서울"`
 *  gộp thành `" 서"` + …, còn `" 这"` = `" "` + `"这"` (2 token). */
const HANGUL_CHAR_RE = /^[\u1100-\u11FF\uAC00-\uD7AF]$/u;

/** Ký tự emoji (pictographic, cờ, dingbat, modifier màu da). */
const EMOJI_CHAR_RE =
  /[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F3FB}-\u{1F3FF}]/u;

/**
 * Dấu câu đơn gộp với từ Latin đứng sát sau thành 1 token BPE (đo thật
 * bằng `cl100k_base`: `".log"`, `"/api"`, `"<K"`, `"<div"`, `":x"`,
 * `";x"`, `"(x"`, `"[x"`, `"{x"`, `"\"x"`, `"$x"`, `"%x"`, `"*x"`,
 * `"+x"`, `"-x"`, `"=x"`, `"|x"` đều = 1 token). Các dấu `' # @ & ? !
 * ~ ^ \`` KHÔNG gộp (`"'x"`, `"#x"`, `"@x"`, `"&x"`, `"?x"`, `"!x"`,
 * `"~x"`, `"^x"`, `"\`x"` đều = 2 token).
 */
const MERGE_PUNCT = new Set([...'./<:;([{"$%*+-=|']);

/** Đuôi rút gọn sau `'`: `"don't"` = `"don"` + `"'t"` (2 token). */
const CONTRACTION_TAIL_RE = /^(s|t|d|m|re|ll|ve)$/i;

/** Từ Latin ASCII: 1 token + thêm 1 token mỗi 5 chữ sau chữ thứ 8. */
const ASCII_WORD_FREE_CHARS = 8;
const ASCII_WORD_EXTRA_DIVISOR = 5;

/** Từ Latin có dấu: trung bình 2.25 token/âm tiết (đo thật ~2.2). */
const NON_ASCII_WORD_TOKENS = 2.25;

/** Một ký tự CJK: 1.25 token (đo thật trên văn xuôi ~1.2). */
const CJK_TOKENS_PER_CHAR = 1.25;

/** Dãy số: tối đa 3 chữ số/token. */
const DIGITS_PER_TOKEN = 3;

/** Dãy ký tự đặc biệt: 3 ký tự/token (`"!!!"` = 1, `"((()))"` = 2). */
const PUNCT_CHARS_PER_TOKEN = 3;

/** Một ký tự emoji: 2.75 token (😀 = 2, 🎉/🔥/👏 = 3). */
const EMOJI_TOKENS_PER_CHAR = 2.75;

type ChunkKind = 'cjk' | 'hangul' | 'word' | 'num' | 'other';

function chunkKind(part: string): ChunkKind {
  if (CJK_CHAR_RE.test(part)) return HANGUL_CHAR_RE.test(part) ? 'hangul' : 'cjk';
  if (/^[\p{L}]+$/u.test(part)) return 'word';
  if (/^[\p{N}]+$/u.test(part)) return 'num';
  return 'other';
}

/**
 * Token của một dãy khoảng trắng, phụ thuộc vào ngữ cảnh hai bên
 * (đo thật bằng `cl100k_base`):
 *  - xuống dòng: gộp với dấu câu đứng trước (`"{\n"`, `";\n"` = 1
 *    token) nên tính 0; sau từ/số/chữ CJK thì đứng riêng, mỗi cặp
 *    `"\n\n"` gộp thành 1 token → `ceil(số_\n / 2)`;
 *  - khoảng trắng (space/tab): trước dãy số hoặc chữ Hán/Kana thì
 *    mỗi ký tự đứng riêng (`" 123"` = `" "` + `"123"`); trước từ
 *    Latin/Hangul/dấu câu/emoji thì ký tự đầu gộp vào token sau, phần
 *    còn lại của dãy là 1 token duy nhất (`"  "` và `"    "` đều = 1
 *    token); dãy ở cuối chuỗi = 1 token (`"hello "` = 2 token).
 */
function gapTokens(
  gap: string | null,
  prevKind: ChunkKind | null,
  nextKind: ChunkKind | null,
): number {
  if (gap === null) return 0;
  const newlines = (gap.match(/\n/g) ?? []).length;
  const spaces = gap.length - newlines;
  let total = 0;
  if (newlines > 0 && prevKind !== 'other') total += Math.ceil(newlines / 2);
  if (nextKind === null) {
    if (spaces > 0) total += 1;
  } else if (nextKind === 'num' || nextKind === 'cjk') {
    total += spaces;
  } else if (spaces >= 2) {
    total += 1;
  }
  return total;
}

/**
 * Ước lượng token của một chuỗi text. Chuỗi rỗng hoặc toàn khoảng trắng
 * → 0. Không bao giờ âm; kết quả là số nguyên (`ceil` tổng phân số).
 */
export function estimateTokens(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  // Tách thành các item kèm khoảng trắng đứng trước mỗi item (để tính
  // token khoảng trắng theo ngữ cảnh và nhìn trước khi xử lý dấu câu).
  const items: { gap: string | null; part: string; kind: ChunkKind }[] = [];
  let pendingGap: string | null = null;
  for (const match of text.matchAll(CHUNK_RE)) {
    if (match[1] !== undefined) {
      pendingGap = match[1];
      continue;
    }
    items.push({ gap: pendingGap, part: match[0], kind: chunkKind(match[0]) });
    pendingGap = null;
  }
  const trailingGap = pendingGap;
  let total = 0;
  items.forEach((item, i) => {
    total += gapTokens(item.gap, i === 0 ? null : items[i - 1].kind, item.kind);
    const next = items[i + 1];
    const adjacentNext = next !== undefined && next.gap === null ? next : undefined;
    if (item.kind === 'cjk' || item.kind === 'hangul') {
      total += CJK_TOKENS_PER_CHAR;
    } else if (item.kind === 'word') {
      const letters = [...item.part].length;
      const extra = Math.max(0, letters - ASCII_WORD_FREE_CHARS) / ASCII_WORD_EXTRA_DIVISOR;
      total += /[^\x00-\x7F]/.test(item.part) ? NON_ASCII_WORD_TOKENS + extra : 1 + extra;
    } else if (item.kind === 'num') {
      total += Math.max(1, Math.ceil([...item.part].length / DIGITS_PER_TOKEN));
    } else {
      // Dãy ký tự đặc biệt / emoji.
      const chars = [...item.part];
      if (
        chars.length === 1 &&
        adjacentNext !== undefined &&
        adjacentNext.kind === 'word'
      ) {
        // Dấu câu đơn gộp với từ đứng sát sau — hoặc `'` + đuôi rút gọn.
        if (MERGE_PUNCT.has(chars[0])) return;
        if (chars[0] === "'" && CONTRACTION_TAIL_RE.test(adjacentNext.part)) return;
      }
      let emoji = 0;
      let punct = 0;
      for (const ch of chars) {
        // Variation selector / ZWJ chỉ sửa emoji đứng trước, tính 0.
        if (ch === '\uFE0F' || ch === '\u200D') continue;
        if (EMOJI_CHAR_RE.test(ch)) emoji += 1;
        else punct += 1;
      }
      total += emoji * EMOJI_TOKENS_PER_CHAR;
      if (punct > 0) total += Math.ceil(punct / PUNCT_CHARS_PER_TOKEN);
    }
  });
  total += gapTokens(
    trailingGap,
    items.length > 0 ? items[items.length - 1].kind : null,
    null,
  );
  return Math.ceil(total);
}
