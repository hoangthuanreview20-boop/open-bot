# Harness local chuẩn hoá (M5)

Tầng mỏng nằm giữa driver CLI (M1–M4) và phần còn lại của open-bot
(coordinator, Local API/WS, desktop): **registry instance → process
sống, event bus fan-in về một event chuẩn, NDJSON log theo thread,
snapshot engine ghi atomic, permission broker fail-closed.**

Harness KHÔNG spawn process (driver tự spawn như M1–M4), KHÔNG chạy
model, KHÔNG giữ credential. Nó chỉ ghi nhận instance nào đang sống,
gom event, ghi log, và làm trọng tài cho permission request.

## Thành phần

| File | Vai trò |
| --- | --- |
| `types.ts` | Envelope `HarnessEvent`, kind chuẩn, snapshot instance, request/quyết định permission. |
| `bus.ts` | `HarnessEventBus` — subscribe theo `botId`/`engine`/`kinds`, publish đồng bộ best-effort (handler throw thì nuốt + đếm). |
| `registry.ts` | `HarnessRegistry` — 1 entry / bot: botId, engine, providerId, pid (đọc lười qua `pidProvider`), trạng thái, startedAt/lastEventAt. Đăng ký trùng bot sống thì throw (chống spawn trùng). `shutdownAll()` kill toàn bộ còn sống, best-effort. |
| `ndjson.ts` | `ThreadLog` + `sanitizeHarnessPayload` — 1 dòng = 1 event JSON theo thread, xoay file theo kích thước, cắt file xoay cũ khi vượt cap tổng, đọc lại có phân trang + lọc kind. |
| `snapshot.ts` | Ghi snapshot atomic (file tạm + rename), đọc lại có fallback rỗng + warning khi file hỏng. |
| `broker.ts` | `PermissionBroker` — xem dưới. |
| `harness.ts` | `LocalHarness` — facade gom 5 thành phần trên; coordinator giữ một instance. |

## Envelope event chuẩn

```ts
{ instanceId, botId, threadId, engine, kind, payload, at }
```

Map từ `CliEvent` của driver: `text` → `text`, `tool_call` →
`tool_call`, `result` → `result`, `error` → `error`, `aborted` →
`abort`, `approval_denied` → `approval_denied`, `approval_request` →
`approval_request`. Thêm `approval_decision` (broker đã quyết) và
`lifecycle` (register/unregister/spawn/exit).

Callback `onCliEvent` cũ của driver **vẫn chạy song song** — driver
gọi cả callback cũ lẫn harness sink (`attachHarnessSink`), nên API
hiện có không đổi. Coordinator/UI subscribe bus thay vì callback rời
rạc từng driver.

## NDJSON log — không ghi secret

- File `<dataDir>/harness-logs/<threadId>.ndjson`, 1 dòng 1 event:
  `{at, botId, threadId, kind, payload}`.
- `sanitizeHarnessPayload`: key trông giống secret (token, secret,
  password, api-key, auth, credential, Bearer <redacted>, session, private…)
  → `'<redacted>'`; dạng key đã biết `sk-…`/`xai-…`/`sk-ant-…` và
  dạng `apiKey: <value>` trong text → redact; chuỗi cắt ở 2.000 ký tự;
  `tool_call` CHỈ ghi tên tool + tên key của args (không ghi value —
  value có thể chứa đường dẫn/nội dung nhạy cảm); bộ đếm
  `inputTokens`/`outputTokens` giữ nguyên (như tracing).
- Xoay file khi vượt 5 MB (mặc định): file cũ đổi tên thành
  `<file>.<ms>-<pid>-<n>.ndjson`; cắt file xoay cũ nhất khi tổng vượt
  50 MB. Đọc lại: `read(threadId, {limit, offset, kinds})`, dòng hỏng
  thì bỏ qua.

## Snapshot engine

`saveSnapshot(engines)` ghi `<dataDir>/harness-snapshot.json` bằng
ghi file tạm + rename (atomic — crash giữa chừng không để lại file
nửa vời). `loadSnapshot()` đọc lại khi khởi động để **khôi phục trạng
thái HIỂN THỊ** (Settings → Engines hiện trạng thái lần cuối trước khi
tắt). **KHÔNG tự spawn lại process** — process CLI chỉ sống khi bot
được tạo / turn chạy. File hỏng → snapshot null + warning, app không
crash.

## Permission broker

Request từ CLI (Codex approval server→client, ACP
`session/request_permission`) chảy về broker thay vì mỗi driver tự từ
chối trong im lặng:

- **Mặc định: TỪ CHỐI fail-closed.** Không có UI handler → từ chối
  ngay, không chờ. Không có `bypassPermissions`, không auto-approve.
- **Có UI:** request thành "thẻ duyệt đang chờ" (pending). UI quyết
  bằng EITHER `uiHandler` (promise) HOẶC `decide(requestId, allowed)`
  (Local API `POST /v1/harness/permissions/:requestId` / RPC
  `harnessDecidePermission`).
- **Timeout:** hết `timeoutMs` (mặc định 120s) mà chưa có quyết định
  → TỪ CHỐI, không treo turn vĩnh viễn.
- **Mọi quyết định đều ghi log** (`listDecisions()` + event
  `approval_decision` lên bus): cho phép/từ chối + lý do + nguồn
  (`default-deny` | `allow-not-supported` | `ui` | `timeout` |
  `shutdown`).
- **Codex không cho phép được:** shape trả lời "cho phép" của Codex
  chưa xác minh được từ schema thật của CLI (chỉ có shape deny, xem
  `providers/cli/codexAppServer.ts` → `denyCodexApproval`) nên broker
  gọi handler với `allowable: false` và client LUÔN đi đường deny
  (`{decision: 'decline'}` / `{decision: {denied: …}}`), ghi rõ lý do
  `allow-not-supported`. ACP thì cho phép được: broker cho phép →
  client chọn option `allow_once` (không có thì `allow_always`).
- **Claude Code không có kênh permission:** driver Claude nói
  stream-JSON qua stdin, server không gửi request xin duyệt về
  client — broker không chạm tới driver này (ghi rõ để không ai tưởng
  broker đã bao hết mọi CLI).

## Nối vào đâu

- **Coordinator** (`CoordinatorOptions.harness`): `createBot` /
  `createAgentBot` đăng ký instance (kill = `provider.dispose()`,
  pid đọc lười qua `provider.cliPid`); `destroyBot` gỡ + từ chối
  permission chờ; `switchModel` đăng ký lại provider mới;
  `shutdown` kill toàn bộ theo registry. RPC mới: `harnessStatus`,
  `harnessThreadLog`, `harnessDecidePermission` (cả
  `CoordinatorClient`).
- **Local API** (`ApiHandlers` — optional): `GET /v1/harness/status`,
  `GET /v1/harness/threads/:threadId/log?limit=&offset=&kind=`,
  `POST /v1/harness/permissions/:requestId {allowed}`. Chưa mount
  handler thì route trả 404. Desktop main mount bằng coordinator RPC.
- **Driver CLI** (`providers/cli/`): thêm `harnessSink` +
  `attachHarnessSink()` + getter `cliPid` (Claude, Codex,
  `BaseAcpCliProvider` + 5 driver ACP con kế thừa); thêm
  `permissionHandler` + `attachPermissionHandler()` (Codex, ACP).
  `AcpClient`/`CodexAppServerClient` hỏi broker khi có handler, không
  có thì từ chối như M2/M3.
- **local-exec-daemon: KHÔNG nối code.** Daemon spawn lệnh shell, không
  spawn process CLI — không có "trùng process cho cùng bot" để chống ở
  đó. Chống trùng được thực thi ở registry (đăng ký trùng bot sống
  thì throw) + coordinator (bot đã tồn tại thì `createBot` throw
  trước khi tới harness).

## Chưa nối / chưa kiểm chứng

- **Desktop main chưa dựng `LocalHarness`** (`apps/desktop/src` ngoài
  phạm vi M5): coordinator trong app thật hiện chạy không harness
  (hành vi như cũ), provider CLI chưa được gắn sink/broker ở main.
  Follow-up: main dựng `LocalHarness({dataDir: userData,
  permissionUiHandler: mở thẻ duyệt})`, truyền vào coordinator qua
  `CoordinatorOptions.harness`; thẻ duyệt permission trong chat (M8
  sẽ làm UI).
- **Permission broker với CLI thật chưa kiểm chứng:** ACP allow đã
  kiểm chứng bằng fake ACP (`opt-allow` được chọn, turn xong); Codex
  deny đã kiểm chứng bằng fake Codex (`decision: 'decline'`). Chưa
  chạy trên máy có Codex/Grok/OpenCode… đăng nhập thật: shape
  `session/request_permission` thật, hành vi turn sau khi allow, và
  Codex allow-shape thật đều chưa thấy.
- **Event bus dưới tải chưa kiểm chứng:** bus đồng bộ, handler chạy
  trong `publish()` — subscriber chậm sẽ làm chậm driver. Chưa đo với
  nhiều bot / event dày; nếu cần, tách handler sang queue bất đồng bộ
  ở sóng sau.
- **NDJSON xoay file** đã kiểm chứng bằng test (xoay + đọc lại đủ
  entry) nhưng chưa chạy dài ngày thật: cap 5 MB/file + 50 MB tổng là
  giá trị mặc định, chưa đo dung lượng log thực tế của turn dài.
- **Windows/macOS chưa chạy thật** (chỉ Linux; kill process group qua
  helper đã có từ M1).

## Test

`tests/harness-m5.test.mjs` — 21 test: registry (đăng ký/trùng/
shutdown kill `sleep` thật), bus (fan-in/lọc/unsubscribe/handler lỗi),
NDJSON (ghi/đọc/phân trang/redact/xoay), snapshot (ghi/đọc/hỏng),
broker (mặc định từ chối/UI cho phép/từ chối/timeout/decide/denyAll/
allowable=false), harness facade, ACP allow + Codex deny bằng fake
CLI, coordinator wiring, Local API routes. Chỉ fake/mock + thư mục
tạm, không tài khoản/key thật.
