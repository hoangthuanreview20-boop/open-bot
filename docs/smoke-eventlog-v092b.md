# Smoke EventLogView trong app Electron thật — v0.92b

**Kết quả: PASS 26/26 bước.** Không phát hiện bug trong EventLogView;
công việc của sóng này là bổ sung test smoke (trước đây view chỉ có test
đơn vị/harness ở `tests/harness-eventlog-v090a.test.mjs`).

## Cách chạy

```sh
npm run build                                   # bắt buộc trước
xvfb-run -a node --test tests/smoke-eventlog-v092b.test.mjs
# hoặc chạy trực tiếp script (in từng bước + ghi bằng chứng):
xvfb-run -a node scripts/smoke-eventlog-v092b.mjs
```

Yêu cầu: Ollama local ở `http://127.0.0.1:11434` với model
`qwen2.5:0.5b` (thiếu thì test SKIP, không fail — như các smoke khác).
KHÔNG gọi API ngoài, KHÔNG dùng key. App chạy với `--user-data-dir`
tạm (`/tmp/open-bot-eventlog92-smoke/`, xoá sau khi chạy) nên không
đụng dữ liệu thật; `settings.json` trong đó được seed 1 bot Ollama
(`smoke-ollama`, model `qwen2.5:0.5b`, auto-approve-safe).

## Đã kiểm chứng trong app thật

Chạy 2 lần đều PASS 26/26: lần 1 trực tiếp bằng script (run 6,
2026-11-12 ~07:04–07:07, 181s, live tail 3 → 8 entries); lần 2 qua
wrapper `node --test` (58s, live tail 3 → 6 entries, lượt live-tail
trả đúng "Xin chào!"). Bằng chứng trong thư mục là của lần chạy sau
cùng (wrapper).

1. App mount dưới xvfb; EventLogView mở qua menu `⋯ Menu` → dropdown
   `data-nav-key="eventlog"` (nav đã gộp thành 1 menu từ v0.62 UI-13).
2. View render: title "Nhật ký event", select bot, status line
   "1 instance đang chạy · 0 permission đang chờ"; IPC
   `harness:status` / `harness:thread-log` trả về (không "chưa khả
   dụng", không lỗi tải); empty state đúng khi chưa chạy bot.
3. Gửi 1 tin qua composer thật (textarea + nút Gửi); bot Ollama local
   trả lời (có footer usage + nút Nghe). Đối chiếu NDJSON trên đĩa
   `<userData>/harness-logs/smoke-ollama.ndjson`: `[lifecycle, text,
   lifecycle]`.
4. Mở lại EventLogView: **3 / 3 event**, kinds `[Vòng đời, Text, Vòng
   đời]`, summary là câu trả lời thật của model.
5. Filter theo kind: tắt "Vòng đời" → chỉ còn 1 entry Text; bật lại
   → đủ 3. (Tắt "Lỗi" không kiểm chứng được gì khi chưa có error
   event — list vẫn 3/3 là đúng.)
6. "Hiện payload" mở JSON thật, vd `{"phase": "turn-start", "step": 0}`.
7. Live tail: chạy thêm 1 lượt khi đang ở EventLogView → list tự
   append **3 → 8 entries (lần 1) / 3 → 6 (lần 2) mà không refresh**,
   auto-scroll xuống cuối. Lượt 2 lần 1 model 0.5b còn gọi nhầm tool
   `comms(operation, args)` rồi lỗi — view hiện đủ `tool_call` +
   `result · error` + `text` + `lifecycle`, đúng hành vi cần có.
8. **0 lỗi JS trong renderer console; main log sạch** (chỉ có noise
   headless dbus/GPU quen thuộc, đã lọc).

## Bằng chứng (cùng thư mục)

- `01-eventlog-empty.png` — view rỗng trước khi chạy bot.
- `02-eventlog-filled.png` — 3 entries sau lượt 1.
- `03-eventlog-livetil.png` — 6 entries sau lượt live-tail (lần 1 là
  8 entries, thấy cả tool_call `comms` + result error — xem summary
  lần 1 đã ghi trong báo cáo này).
- `summary.json` — 26 bước PASS + tail main log.
- `main.log` — stdout/stderr của main process.

## Giới hạn nói thẳng

- Nội dung câu trả lời của model KHÔNG được assert theo từng chữ:
  `qwen2.5:0.5b` diễn đạt lại / trả lời lạc đề (vd lượt 1 trả câu lẫn
  tiếng Trung, lượt 2 gọi nhầm tool `comms` rồi từ chối). Test chỉ
  assert có trả lời + có event — đó là giới hạn của model test, không
  phải của app.
- Chỉ smoke 1 bot Ollama local, 2 lượt chạy, 8 entries: chưa thử
  phân trang "Tải thêm" (>100 entries), chưa thử đổi bot trong select
  (chỉ có 1 bot), chưa thử tắt live tail rồi bật lại.
- Test cần ~1–3 phút (2 lượt Ollama + khởi động Electron lạnh) và SKIP
  khi thiếu DISPLAY hoặc thiếu Ollama/`qwen2.5:0.5b`. (Lưu ý: lần chạy
  wrapper đầu tiên đã SKIP vì Ollama tắt sau một lần service restart —
  khởi động lại bằng `ollama serve` rồi chạy lại thì PASS.)

## File thay đổi (branch `v092b-eventlog-smoke`)

- `scripts/smoke-eventlog-v092b.mjs` — driver CDP (mới).
- `tests/smoke-eventlog-v092b.test.mjs` — wrapper node:test (mới).
- `docs/smoke-eventlog-v092b/` — báo cáo này + bằng chứng.
- Không sửa code app (`EventLogView.tsx`, `main.ts`, `preload.ts`
  giữ nguyên — không có bug để sửa).
