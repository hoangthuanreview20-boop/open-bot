# Bot box / sandbox theo turn + egress gate (M6)

Box **theo bot, local-first** — Grok Bot dùng session box/pod riêng cho mỗi
bot, OpenMausBot dùng boat/box (VM/sandbox riêng). open-bot bắt đầu local
trước, cloud desktop để sau.

## Mô hình box

- **Một box cho mỗi bot** (`<root>/boxes/<botId>/`): `box.json`
  (metadata, không secret), `workspace/` (thư mục làm việc riêng — không
  chạm workspace bot khác), `tmp/` (TMPDIR của box), `auth/` (trạng thái
  đăng nhập đã đồng bộ, 0700).
- **Reset theo turn là tuỳ chọn**: `resetPerTurn: true` thì đầu mỗi turn
  xoá nội dung `workspace/` (`beginTurn()`); mặc định `false` — file làm
  việc giữ qua các turn như một working dir bền vững. `auth/` không bao
  giờ bị reset theo.
- Box tạo idempotent theo bot (`createBox` trả về box đã có nếu còn active).

## Ma trận cách ly theo OS

| OS | Backend | Cách ly thật? | Ghi chú |
|----|---------|---------------|---------|
| Linux + `bwrap` | bubblewrap | ✅ mount + pid namespace, workspace bind riêng | Cần cài `bubblewrap` (`apt-get install bubblewrap`). **Đã kiểm chứng trên VM này (Ubuntu 24.04)**: chạy được cả dạng thường và `--unshare-user`. |
| Linux + `unshare` | user + pid namespace | ⚠️ yếu hơn bwrap | Không giam mount; `/proc` vẫn của host (mount proc bị chặn trong VM này). Fallback khi không có bwrap. |
| Linux không có cả hai | chạy thường | ❌ | Chỉ có thư mục riêng + env allow-list + timeout/cap ghi. |
| macOS + `sandbox-exec` | Seatbelt profile | ⚠️ theo profile | Profile cơ bản: cấm ghi file ngoài workspace/tmp của box. **Chưa kiểm chứng trên macOS thật.** |
| macOS không có `sandbox-exec` | chạy thường | ❌ | Như trên. |
| Windows | chạy thường | ❌ | Chưa có backend cách ly tương đương. |

**Quy tắc vàng**: `BoxRunResult.isolation.isolated === false` + cảnh báo rõ
trong log khi chạy thường. Không bao giờ báo "đã cách ly" khi chưa có công cụ.
Khi backend spawn lỗi giữa chừng, `runInBox` fallback chạy thường **một lần**
và ghi rõ trong result (không throw âm thầm, không giả vờ).

**Backend lỗi setup (sóng B):** spawn thành công nhưng backend tự thoát
lỗi trước khi exec tool — vd bwrap lúc máy tải nặng: `bwrap: Creating new
namespace failed: Resource temporarily unavailable` (exit 1, stdout
rỗng). `runInBox` nhận ra qua stderr (chỉ khớp dòng đặc trưng của chính
backend, nên tool lỗi thật không bị chạy lại), thử lại cùng backend
**một lần** sau 300ms (lỗi nhất thời hay hết khi tải giảm), rồi mới
fallback chạy thường + ghi rõ. `limitsApplied.enforced` thành `false`
sau fallback (prlimit không còn áp dụng), stderr vẫn giữ dòng lỗi setup
để chẩn đoán.

Lưu ý bwrap: **không** `--unshare-net` — box vẫn cần gọi egress gate trên
loopback; mạng ra ngoài chỉ qua gate.

## Giới hạn tài nguyên (enforce thật)

- `timeoutMs` (mặc định 120s): hết giờ kill cả process group.
- `maxWriteBytes` (mặc định 100 MB): poll kích thước workspace mỗi 200ms,
  vượt thì kill cả process group, `writeCapExceeded: true`.
- `maxOutputChars` (mặc định 200.000): cắt stdout/stderr giữ lại.
- `maxFiles` (mặc định 10.000): metadata — kiểm tra sau khi chạy qua
  `dirFileCount()` (chưa enforce kill giữa chừng).
- `cpuSeconds` / `maxMemoryBytes` / `maxProcesses` (mặc định không giới
  hạn — sóng B, máy-tính-bot): enforce bằng `prlimit` trên Linux
  (`wrapWithPrlimit` trong `box.ts`). `BoxRunResult.limitsApplied`
  ghi rõ đã enforce thật hay chưa + lý do (vd thiếu prlimit, không
  phải Linux, spawn backend lỗi rồi fallback). Lưu ý `--as` giới hạn
  không gian địa chỉ ẢO (không phải RAM vật lý — RLIMIT_RSS không được
  kernel enforce), floor 4GB vì Node cần ≥4GB ảo; giới hạn RAM vật lý
  thật cần cgroup (follow-up).

## Env allow-list

- KHÔNG BAO GIỜ copy toàn bộ `process.env` của host vào box.
- Biến mặc định an toàn: `PATH`, `HOME` (= workspace của box), `TMPDIR`
  (= `<box>/tmp`), `LANG`, `LC_ALL`, `TERM`, `USER`, `SHELL`,
  `OPENBOT_BOX_ID`, `OPENBOT_BOT_ID`.
- Biến thêm phải nằm trong allow-list của box; giá trị chỉ lấy từ
  `envValues` do caller đưa rõ ràng — biến lạ trong env host **không lọt**.
- Tên biến trông giống secret (`KEY|TOKEN|SECRET|PASSWORD|...`) bị từ chối
  khỏi allow-list và khỏi `envValues`. Secret chỉ đi qua `vaultSecrets`
  (caller lấy từ Vault rồi đưa vào) — đường này cho phép cả tên giống secret.
- Biến auth riêng của CLI (vd `CLAUDE_CODE_*`) cũng chỉ đi đường này,
  như M1/M2 đã làm với `sanitizeEnvForCli`.

## Đồng bộ sign-in an toàn (`signin.ts`)

Khi CLI trong box cần đăng nhập, chỉ **trạng thái + nhãn** được đồng bộ về
host (file `<authDir>/<provider>.state.json`): `provider`, `accountLabel`
(nhãn hiển thị), `status` (`signed-in` | `signed-out` | `unknown`),
`observedAt`, `source`.

**KHÔNG đồng bộ**: access token, refresh token, API key, cookie, file
credential thô của CLI. CLI tự giữ credential trong HOME của nó (HOME trong
box trỏ vào workspace của box); host chỉ biết trạng thái. Muốn CLI ngoài box
dùng lại login thì chạy lại CLI đó trên host (nó đọc credential store của
chính nó), không copy file auth.

An toàn ghi file:

- **Settled 2s**: `waitSettled()` chỉ coi xong khi file nguồn không đổi
  (mtime + size) trong 2s liên tục — tránh đọc file đang ghi dở.
- **Ghi nguyên tử**: file tạm trong cùng thư mục + rename.
- **Quyền**: file state `0600`, thư mục auth `0700` (kể cả khi thư mục đã
  tồn tại — `chmod` lại). Ghi state có key trông giống secret thì throw
  (chặn caller vô tình đưa cả object credential).

## Egress gate (local, `gate.ts`)

Proxy HTTP chạy trên **127.0.0.1** (port cấu hình được, mặc định 0 = port
trống). Box đặt `http_proxy`/`https_proxy` trỏ vào gate (`gate.proxyEnv()`).

- Quyết định tái dùng `checkEgress` của `egress/` (không viết policy thứ
  hai): loopback/LAN/link-local/metadata → chặn; fail-closed khi policy
  thiếu/tắt, DNS lỗi, đích không xác minh được. Client trong box luôn là
  context `'agent'` nên **127.0.0.1 từ trong box cũng bị chặn** (chỉ
  local-service của host mới được phép theo egress, không áp cho box).
- Request bị chặn → **403** với mã egress, không echo URL đích.
- Hỗ trợ request absolute-form (GET/POST/...) và `CONNECT` (tunnel TCP sau
  khi checkEgress qua; gate không terminate TLS).
- Log quyết định (`GateDecisionLog`): chỉ **host + kind + reason** — không
  URL đầy đủ (path/query có thể chứa secret), không header/body.
- Body proxy giới hạn 10 MB; forward upstream timeout 30s.

## Nối vào module khác (`wiring.ts` — chỉ dùng API public, không sửa code cũ)

- **Harness M5**: box không đăng ký instance riêng trong registry (registry
  đã có 1 instance/bot cho provider CLI — đăng ký thêm cùng botId sẽ throw
  chống trùng). Box chỉ publish event lifecycle (`box_created`,
  `box_reset`, `box_run`, `box_destroyed`, kind `lifecycle`) lên bus +
  NDJSON log của harness, dùng instanceId của bot nếu đã có, nếu chưa thì
  `box:<botId>`.
- **Session box**: `attachBoxToSession()` đặt box dưới workspace của session
  (`<sessionWorkspace>/boxes/<botId>/`).
- **Local-exec-daemon**: core không import tools (tránh cycle core→tools).
  `boxDaemonExecRequest()` trả object đúng shape `ExecRequest` của daemon
  (`command/args/cwd/env/timeoutMs/workspaceDir/egressPolicy`) — caller đưa
  vào `DaemonClient.exec()`; daemon giam cwd theo `workspaceDir` của box.
- **Vault**: secret chỉ qua `vaultSecrets` (caller lấy từ Vault); module này
  không đọc Vault trực tiếp, không đọc key Gemini, không gọi API ngoài.

## Chưa kiểm chứng / giới hạn

- **bwrap/namespace trên máy thật**: bwrap đã kiểm chứng trên VM này
  (Ubuntu 24.04, bubblewrap 0.9.0); `unshare --mount-proc` bị chặn trong
  VM này nên backend unshare không dùng `--mount-proc`. Chưa chạy trên máy
  Linux khác, chưa chạy trên macOS/Windows thật (profile sandbox-exec và
  đường fallback Windows chỉ là code + test đường `none`).
- **Egress gate dưới tải**: gate chạy đồng bộ theo từng request, chưa đo
  nhiều box/request dày; body giới hạn 10 MB, upstream timeout 30s.
- **Sign-in sync với CLI thật**: chỉ kiểm chứng bằng file marker giả;
  chưa chạy `claude login`/`codex login` thật trong box (chưa có CLI nào
  đăng nhập trên máy này).
- **Write cap**: poll mỗi 200ms nên một tiến trình ghi rất nhanh có thể
  vượt cap một chút trước khi bị kill; cap là "kill khi phát hiện vượt",
  không phải giới hạn cứng ở tầng filesystem (chưa dùng cgroup/quota).
- **Cloud desktop**: chưa làm (theo hướng Huy: local trước, cloud sau).
