/**
 * Live test (v0.89a): vision THẬT qua Gemini + fail-closed Ollama.
 *
 * GATED — suite thường (`npm test`) KHÔNG BAO GIỜ gọi API live hay tốn
 * quota: test Gemini dưới đây tự skip khi proxy không chạy HOẶC biến
 * môi trường OPENBOT_LIVE_GEMINI chưa bật. Chạy live như sau:
 *
 *   # Terminal 1: proxy (key thật nằm trong vault custom.gemini, proxy
 *   # gắn surrogate — key KHÔNG chạm file, log hay biến môi trường)
 *   python3 ~/workspace/custom-connectors/custom.gemini/bin/gemini_proxy.py --port 8765
 *
 *   # Terminal 2:
 *   OPENBOT_LIVE_GEMINI=1 node --test tests/gemini-live-vision-v089a.test.mjs
 *
 * Test live chứng minh lần đầu ảnh đi tới được model qua chính
 * `GeminiProvider` của open-bot (đường vision v0.63: user message +
 * `attachments` → Gemini `inlineData`): gửi 1 ảnh vuông đỏ 64x64 thật
 * (build byte-exact trong test, không fixture ngoài) kèm câu "màu chủ
 * đạo của hình này là gì?" và assert câu trả lời nhắc tới màu đỏ.
 * Provider dùng apiKey dummy 'via-proxy' (proxy bỏ đi và gắn surrogate)
 * và baseUrl 'http://127.0.0.1:8765/v1beta' — KHÔNG hardcode key thật.
 * Chi tiết proxy: ~/workspace/custom-connectors/custom.gemini/CONNECTOR.md.
 *
 * Test Ollama thì KHÔNG gated (không cần mạng): `OllamaProvider.chat`
 * với model text-only `qwen2.5:0.5b` + ảnh phải từ chối rõ ràng TRƯỚC
 * khi gọi provider — test trỏ baseUrl tới cổng đóng (127.0.0.1:9) nên
 * nếu code gọi fetch trước thì lỗi sẽ là connection refused chứ không
 * phải câu từ chối vision.
 *
 * Kết quả đo lần đầu (2026-11-11, gemini-2.5-flash, proxy 8765):
 * ảnh đỏ 64x64 + "Màu chủ đạo của hình này là gì?" → trả lời "Đỏ"
 * trong 2001 ms, usage 278 in / 2 out; upstream HTTP 200. Ollama
 * qwen2.5:0.5b thật (127.0.0.1:11434) từ chối rõ trước khi gọi model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';

import { GeminiProvider } from '../packages/core/dist/providers/gemini.js';
import { OllamaProvider } from '../packages/core/dist/providers/ollama.js';

const PROXY_BASE_URL = 'http://127.0.0.1:8765/v1beta';
const LIVE_MODEL = 'gemini-2.5-flash';

/** True khi proxy local đang chạy (GET / trả {"ok": true}). */
async function proxyUp() {
  try {
    const res = await fetch('http://127.0.0.1:8765/', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.ok === true;
  } catch {
    return false;
  }
}

/** Gate chung: chỉ chạy live khi được bật tường minh VÀ proxy đang chạy. */
async function liveEnabled(t) {
  if (process.env.OPENBOT_LIVE_GEMINI !== '1') {
    t.skip('OPENBOT_LIVE_GEMINI != 1 — bỏ qua test live Gemini vision (không tốn quota)');
    return false;
  }
  if (!(await proxyUp())) {
    t.skip('Proxy Gemini local (127.0.0.1:8765) không chạy — bỏ qua test live Gemini vision');
    return false;
  }
  return true;
}

// --- Ảnh vuông đỏ 64x64, build byte-exact trong test (xem api-vision-v089a) ---

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/** PNG RGB đỏ đặc (255,0,0), base64. */
function makeRedPngBase64(w = 64, h = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      raw[o] = 255; // R
      raw[o + 1] = 0;
      raw[o + 2] = 0;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

test('live: Gemini nhìn thấy ảnh đỏ qua GeminiProvider (inlineData)', async (t) => {
  if (!(await liveEnabled(t))) return;
  const provider = new GeminiProvider({
    id: 'gemini',
    label: 'Gemini',
    apiKey: 'via-proxy',
    baseUrl: PROXY_BASE_URL,
    defaultModel: LIVE_MODEL,
  });
  assert.equal(provider.supportsVision(LIVE_MODEL), true);
  const started = Date.now();
  const res = await provider.chat({
    model: LIVE_MODEL,
    messages: [
      {
        role: 'user',
        content: 'Màu chủ đạo của hình này là gì? Trả lời ngắn gọn bằng tiếng Việt.',
        attachments: [{ mimeType: 'image/png', data: makeRedPngBase64(), name: 'red.png' }],
      },
    ],
    tools: [],
  });
  const elapsedMs = Date.now() - started;
  // Ghi câu trả lời thật ra log để lần chạy live nào cũng có bằng chứng.
  console.log(`[live-vision] ${LIVE_MODEL} ${elapsedMs}ms usage=${JSON.stringify(res.usage ?? null)} answer=${JSON.stringify(res.text)}`);
  assert.match(res.text, /đỏ/i, `model phải nhắc tới màu đỏ, thực tế trả: ${JSON.stringify(res.text)}`);
});

test('Ollama qwen2.5:0.5b (text-only) + ảnh: từ chối rõ TRƯỚC khi gọi provider', async () => {
  // baseUrl cổng đóng: nếu code fetch trước thì lỗi là connection
  // refused; câu từ chối vision chứng tỏ guard chặn trước mọi gọi mạng.
  const provider = new OllamaProvider({
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:9',
    defaultModel: 'qwen2.5:0.5b',
  });
  assert.equal(provider.supportsVision('qwen2.5:0.5b'), false);
  await assert.rejects(
    provider.chat({
      model: 'qwen2.5:0.5b',
      messages: [
        {
          role: 'user',
          content: 'Màu gì đây?',
          attachments: [{ mimeType: 'image/png', data: makeRedPngBase64(8, 8), name: 'red.png' }],
        },
      ],
      tools: [],
    }),
    /không xem được ảnh/,
  );
});
