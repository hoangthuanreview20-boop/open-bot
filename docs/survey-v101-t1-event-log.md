# Survey v1.01 — Đội T1: Event-sourced run log

## Ý tưởng học được (không copy code/text/tài sản của repo nào)

- **Event sourcing (khái niệm chung):** trạng thái của một run được suy ra
  hoàn toàn từ dãy event bất biến, append-only; replay = fold lại dãy
  event từ đầu. Điều này khác với snapshot/checkpoint (chỉ giữ trạng
  thái cuối): log giữ được *lịch sử* và cho phép quay lại bất kỳ điểm
  nào, fork từ một điểm, và kiểm chứng tính toàn vẹn bằng hash chain.
- **Hash chain (chuỗi băm):** mỗi event mang `prevHash` + `hash` của chính
  nó (SHA-256 trên nội dung đã chuẩn hoá thứ tự key). Sửa/xoá/chèn một
  dòng đều làm đứt chuỗi — kiểm chứng được bằng cách tính lại. Đây là
  kỹ thuật chung của audit log, không thuộc riêng repo nào.
- **Deterministic replay:** một run chỉ tái tạo được y hệt khi mọi đầu
  vào không xác định đều được *ghi lại* thay vì chạy lại: response của
  model, kết quả tool call, lỗi biên dịch, thời gian (ghi `at` vào
  event). Replay không gọi lại provider/tool thật mà phát lại bản ghi;
  so sánh digest của trạng thái cuối để khẳng định "cùng kết quả".
- **Pause/resume/fork:** pause là một *gate* mà loop kiểm tra ở biên
  step (không giết run giữa chừng); resume mở gate; fork là tạo run mới
  sao chép prefix event tới một seq rồi ghi event `run.forked` ở cả hai
  phía — run con kế thừa lịch sử, run cha không bị ảnh hưởng.

## Cái repo đã có (điểm xuất phát — không viết lại)

- `packages/core/src/harness/ndjson.ts`: NDJSON log theo thread (bot),
  sanitize payload (redact secret, chỉ giữ tên key của tool args),
  xoay file khi quá lớn. Đây là log *hội thoại theo thread*, không phải
  log *theo run*, không có hash chain, không replay.
- `packages/core/src/agent/loop.ts` (`AgentRunner`): vòng step đã có
  pattern sink tuỳ chọn (`harnessSink`, `toolCallRecorder`, `tracer`,
  `agUiEmitter`) — sink không bao giờ được throw vào run. Đây là chỗ
  cắm run log: thêm option `runLogSink` + `runLogGate` theo đúng
  pattern đó, không phá API cũ.
- `packages/core/src/agent/checkpoints.ts`: checkpoint sau mỗi step
  (snapshot trạng thái) — bổ sung cho run log, không thay thế: checkpoint
  giúp resume nhanh, run log giữ lịch sử đầy đủ + audit.
- `packages/core/src/a2a/history.ts`: `A2aEventLog` (in-memory, theo
  task A2A) — tham khảo hình thức API (append/query), không dùng chung.
- `packages/core/src/agui/bus.ts`: bus có buffer replay theo run —
  chứng minh repo đã cần "xem lại run", nhưng buffer chỉ giữ trong RAM.
- Desktop đã có `EventLogView` đọc log theo thread qua IPC
  `harness:thread-log`. RunReplayView mới sẽ đọc log theo run qua IPC
  `runlog:*` riêng.

## Thiết kế của đội T1

```
packages/core/src/event-log/
  types.ts     — RunEvent (union theo type), RunLogMeta, RunState,
                 query/filter types, RunStatus.
  canonical.ts — stringify ổn định thứ tự key + SHA-256 hash chain.
  sanitize.ts  — sanitize payload kiểu harness (redact secret, cắt
                 chuỗi, tool args chỉ giữ tên key) — tự viết, không
                 import từ harness để tránh vòng phụ thuộc.
  store.ts     — RunLogStore: append-only JSONL theo run
                 (<runId>.jsonl, fsync sau mỗi append), verify chuỗi,
                 read/query theo type/seq/khoảng thời gian, list runs,
                 export JSONL, xoay file khi quá lớn.
  replay.ts    — ReplayEngine: fold event → RunState (messages, tool
                 calls, file changes, errors, status); deterministic
                 replay driver (phát lại model response + tool result
                 đã ghi, không gọi provider/tool thật); digest trạng
                 thái cuối để so sánh hai lần replay.
  control.ts   — RunPauseGate (promise gate kiểm tra ở biên step),
                 pause/resume/fork qua store (fork sao chép prefix).
  recorder.ts  — RunLogRecorder: API cao cấp cho loop/coordinator
                 (startRun, prompt, modelResponse, toolCall,
                 toolResult, fileChange, compileError, error,
                 complete/fail/abort, pause/resume/fork) + adapter
                 `asLoopSink()` trả về sink/gate cho AgentRunner.
  audit.ts     — truy vấn audit xuyên run (theo bot/type/thời gian),
                 báo cáo toàn vẹn (verify tất cả run), export.
  index.ts     — exports.
```

- **Event types:** `run.started`, `run.prompt`, `model.response`,
  `tool.call`, `tool.result`, `file.change`, `compile.error`,
  `run.paused`, `run.resumed`, `run.forked`, `run.completed`,
  `run.failed`, `run.aborted`, `approval.request`,
  `approval.decision`, `checkpoint.saved`.
- **Tích hợp loop (tối thiểu):** `AgentRunnerOptions` thêm
  `runLogSink?: (event) => void` và `runLogGate?: RunPauseGateLike`;
  loop emit ở: đầu run (prompt), sau mỗi `provider.chat` (model
  response + usage), trước/sau mỗi tool call, khi tool ghi file
  (`write_file`/`edit_file`/`delete_file`/`create_file`… → event
  `file.change`), khi tool build/compile trả lỗi (`compile.error`),
  khi run kết thúc/lỗi/abort. Gate được `await` ở đầu mỗi step.
  Mọi emit đều best-effort (try/catch, không throw vào run).
- **Coordinator:** `RunLogStore` lười khởi tạo dưới
  `<userDataDir>/run-logs/`; mỗi run tạo một `RunLogRecorder` và
  truyền sink/gate vào `AgentRunner`. Không có userDataDir → run log
  tắt (hành vi cũ).
- **Desktop:** IPC `runlog:list|read|export|pause|resume|fork` trong
  `main.ts` + preload + `global.d.ts` + `types.ts`; component mới
  `RunReplayView.tsx` (danh sách run, timeline, filter theo loại
  event, export JSONL, nút pause/resume/fork); thêm mục sidebar +
  view trong `App.tsx`. i18n key `runlog.*` đủ 6 locale.
- **Test:** `tests/runlog-v101-*.test.mjs` (node:test, import từ
  `packages/core/dist/...`, theo pattern test hiện có): hash chain +
  chống sửa, store append/query/verify/export, replay determinism +
  digest, pause/fork, audit, recorder + loop sink (mock provider).

## Giới hạn đã biết trước

- Deterministic replay chỉ đúng khi run không phụ thuộc vào dữ liệu
  ngoài chưa ghi (vd tool đọc file thay đổi sau run, giờ hệ thống,
  random không seed) — replay phát lại bản ghi nên vẫn cho cùng kết
  quả *theo log*, nhưng kết quả đó có thể khác lần chạy lại thật với
  môi trường mới; doc sẽ nói rõ.
- File change chỉ phát hiện được qua tên tool ghi file, không theo dõi
  được tool tự viết file lén qua shell.
- Pause gate chỉ dừng ở biên step / biên tool call, không dừng giữa
  một provider call hay một tool call đang chạy.
- Hash chain chống sửa lén, không chống xoá toàn bộ file log.
