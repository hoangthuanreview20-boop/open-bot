# Nghiên cứu sâu — OpenMausBot (milind-soni/OpenMausBot)

> **Phạm vi:** Chỉ nghiên cứu kiến trúc/ý tưởng từ mã nguồn mở (Apache 2.0) để
> thiết kế open-bot. **Không** sao chép code, text, hình ảnh hay tài sản của
> repo này. Mọi nội dung dưới đây là mô tả bằng lời của người nghiên cứu
> (tên lệnh, đường dẫn, tên module tối thiểu đủ để đối chiếu).
>
> **Ngày nghiên cứu:** 2026-11-09. **Repo:** https://github.com/milind-soni/OpenMausBot
> (tên cũ OpenGrokBot, còn gọi MausBot), **commit clone `1de1164`**
> (2026-11-09, "Make Simple the only mode…", PR #5007), clone `--depth 1`
> với `--filter=blob:none` + sparse-checkout. **Sao:** ~18.796, fork ~2.588
> (xác minh qua GitHub API ngày 2026-11-09, theo điều phối viên).
> **Giấy phép:** Apache 2.0 (thư mục `enterprise/` có giấy phép riêng).
>
> **Ghi chú về nơi clone:** `/tmp` trên máy này chỉ là tmpfs 512 MB nên clone
> đầy đủ không vừa; clone đã chuyển sang `~/workspace/.research-clones/openmausbot`
> (không nằm trong repo open-bot, không commit). Các repo phụ cùng nằm ở
> `~/workspace/.research-clones/` (xem `research-detected-cli-providers.md`).
>
> **Tài liệu đọc kèm:** trang so sánh chính thức
> https://www.openmausbot.com/blog/grok-bot-vs-openmausbot (cập nhật 2026-11-08),
> README của repo, và các file `docs/*.md` trong repo.

## 0. Phương pháp & mức tin cậy

| Mức | Ý nghĩa |
|---|---|
| **Chắc chắn** | Đọc trực tiếp trong file đã clone (tên file, hằng số, lệnh, comment đầu file) hoặc trang web chính thức của dự án. |
| **Suy đoán** | Suy ra từ tên file/module và cấu trúc thư mục, chưa đọc logic bên trong. |
| **Chưa xác minh** | Cần chạy thật trên máy có CLI đã đăng nhập mới khẳng định được. |

Quy ước nguồn: `OMB:<đường dẫn>` = file trong clone OpenMausBot;
`OMB-README` = README.md của repo; `OMB-BLOG` = trang so sánh
openmausbot.com/blog/grok-bot-vs-openmausbot. Số dòng đo bằng
`find … | xargs wc -l` trên các file đã checkout (xem §2).

## 1. Tóm tắt điều hành

OpenMausBot là bản tham chiếu **trực tiếp nhất** cho hướng "mượn model/tài
khoản có sẵn trên máy người dùng" mà open-bot sắp làm. Ý tưởng cốt lõi của
nó gói trong 3 câu:

1. **Bring your own agents** — mỗi bot chạy trên một CLI đã cài trên máy
   người dùng (`claude`, `codex`, `grok`…), dùng luôn login/subscription sẵn
   có; không tài khoản mới, không proxy ở giữa. Có mục Settings → Engines để
   trỏ tới binary CLI tuỳ chỉnh.
2. **Local-first** — một harness server nhỏ trên `127.0.0.1:8799` sở hữu mọi
   tiến trình agent; transcript, key, event lưu trong `~/.openmausbot`,
   không lên cloud.
3. **Mỗi bot có não + máy riêng** — model riêng, máy tính riêng (cloud
   desktop riêng từng bot qua Boat, Local VM tách biệt, hoặc chính máy người
   dùng khi opt-in), app riêng qua Composio (500+ app, OAuth một lần).

Về quy mô, OpenMausBot lớn hơn open-bot hiện tại khoảng **5,3 lần về dòng
code nguồn** (~450 nghìn dòng / 2.775 file, chưa tính test) và **~11,5 lần
tính cả test** (~973 nghìn dòng / 5.350 file). Khoảng cách lớn nhất nằm ở
3 mảng: **engines/drivers** (~32,5 nghìn dòng nguồn chỉ riêng drivers),
**renderer/UI** (~138 nghìn dòng nguồn) và **VM/sandbox/bot-box**
(~43 nghìn dòng cho các file boat/box/local-vm/cloud). Đây chính là 3 mảng
đáng ưu tiên nếu muốn open-bot "to lên thật" (§13).

Điểm khác biệt lớn nhất so với Grok Bot (theo chính blog của họ): Grok Bot
chọn model hộ user và chạy trên một cloud computer chung; OpenMausBot cho
chọn model theo từng bot, chạy trên máy user, dữ liệu ở disk user, miễn phí
(Apache 2.0). Grok Bot vẫn hơn ở 2 điểm mà OpenMausBot tự nhận: học workflow
bằng cách quan sát ("Teach a task") và chạy tiếp khi laptop đóng.

## 2. Đo quy mô thật của OpenMausBot

Đo ngày 2026-11-09 trên clone `1de1164`, bằng `find` + `wc -l` (file
`.ts/.tsx/.mts/.mjs`, đã checkout: `server src electron shared connector
relay companion`; chưa đo `scripts/` 316 file, `skills/`, `evals/`,
`third_party/`, `cloudflare/`, `deploy/`, `build/`, `enterprise/`, `apps/`).

### 2.1. Tổng thể

| Hạng mục | Số liệu |
|---|---|
| Tổng file trong cây repo (`git ls-tree -r`) | 7.335 file |
| File code TS/TSX/MTS/MJS đã đo | 5.350 file |
| **Tổng dòng code (kèm test)** | **~972.871 dòng** |
| **Dòng code nguồn (trừ test)** | **~449.897 dòng / 2.775 file** |
| Dòng test | ~522.974 dòng / 2.575 file (tỷ lệ test ~54% tổng dòng) |
| File Markdown trong `docs/` | 1.147 file trong cây; 251 file `.md` đã đo ≈ 52.124 dòng |
| Kích thước repo (GitHub API, theo điều phối viên) | ~473 MB |
| Kích thước clone trên đĩa (depth 1, sparse) | 392 MB |

Đối chiếu open-bot (đo cùng ngày, cùng cách đo, trừ test/dist):
**84.828 dòng / 207 file** (core 55.118 dòng / 146 file; tools 18.225 dòng /
34 file; desktop 11.446 dòng / 26 file). Tức OpenMausBot gấp open-bot
**~5,3 lần** về code nguồn và **~11,5 lần** tính cả test.

### 2.2. Chia theo module

| Module (thư mục) | File | Tổng dòng | Dòng test | Dòng nguồn | Vai trò |
|---|---|---|---|---|---|
| `server/` (toàn bộ) | 2.676 | 582.922 | 337.600 | 245.322 | Harness + drivers + routes + host |
| `server/drivers/` (engines) | 303 | 80.735 | 48.220 | **32.515** | Driver cho từng CLI/API |
| `server/harness/` | 18 | 3.770 | 2.238 | 1.532 | Registry + event bus |
| `server/host/` | 206 | 33.481 | 16.096 | 17.385 | Host/box phía server |
| `server/routes/` | 177 | 24.563 | 11.187 | 13.376 | HTTP API routes |
| `server/browser/` | 115 | 21.865 | 8.038 | 13.827 | Trình duyệt cho agent |
| `src/` (renderer UI) | 1.852 | 261.647 | 123.299 | **138.348** | React app (chat, picker, panels) |
| `electron/` (main) | 461 | 79.758 | 45.323 | 34.435 | Vỏ desktop 3 hệ điều hành |
| `shared/` | 225 | 22.352 | 6.304 | 16.048 | Kiểu/luật dùng chung |
| `connector/` | 34 | 7.017 | 1.756 | 5.261 | Connector |
| `relay/` | 24 | 3.492 | 1.485 | 2.007 | Relay |
| `companion/` | 78 | 15.683 | 7.207 | 8.476 | Companion (mobile/desktop khác) |
| File boat/box/local-vm/cloud/vm (`server/`, theo tên) | 212 | 43.245 | — | — | VM / máy tính của bot |
| File Composio (`server/`, `*composio*`) | 14 | — | — | — | Tích hợp app (xem §7) |

### 2.3. Vài file lớn tiêu biểu (để hình dung độ sâu)

| File | Dòng | Nội dung |
|---|---|---|
| `server/drivers/claude.ts` | 2.090 | Driver Claude Code (stream-JSON 2 chiều) |
| `server/drivers/acp/core.ts` | 1.731 | Driver ACP chung (mọi CLI nói ACP) |
| `server/drivers/codex.ts` | 1.718 | Driver Codex (app-server JSON-RPC) |
| `server/composio.ts` | 1.091 | Tích hợp Composio |
| `server/procs.ts` | 462 | Spawn/quản lý tiến trình CLI |
| `server/harness/registry.ts` | 575 | Registry instance → tiến trình sống |
| `server/harness/bus.ts` | 307 | Event bus → SSE |
| `server/model-catalog/catalog.ts` | 371 | Catalog model (dựa trên models.dev) |
| `server/drivers/acp/grok.ts` | ~600 | Driver Grok CLI qua ACP (đọc kỹ, xem §4.4) |
| `server/drivers/grok.ts` | 64 | Driver Grok **qua API xAI** (mỏng, xem §4.4) |

Nhận xét: repo này viết test rất nặng (hơn một nửa tổng số dòng là test,
kèm cả file `.e2e.test.ts` và golden test). Open-bot hiện tại có ~1.350
test; nếu đi theo hướng này, test cho detected-provider sẽ là phần việc
lớn ngang với code tính năng — cần tính vào ước lượng mốc (§13).

## 3. Kiến trúc tổng thể

Sơ đồ trong `OMB-README` (mô tả lại bằng lời, không copy hình):

- **App** (React + Tailwind, cổng 5199 khi chạy dev): chỉ có UI — chat,
  model picker, computer panel. App **không giữ transport nào của riêng
  mình**: gửi lệnh có kiểu qua HTTP, nhận một luồng sự kiện SSE duy nhất
  rồi gộp vào state. Store phía server, một reducer duy nhất.
- **Harness server** (`127.0.0.1:8799`): sở hữu mọi tiến trình agent; gồm
  driver registry, event bus → SSE, và permission broker (môi giới quyền).
- **Agents trên máy user**: các CLI `claude`, `codex`, `grok`; chúng gửi
  yêu cầu quyền ngược về broker.
- **Ra ngoài**: Boat API (cloud computer), Composio Session (Gmail, Slack,
  GitHub…).

Bảng tầng trong README (diễn đạt lại):

| Tầng | Ở đâu | Việc |
|---|---|---|
| Drivers | `server/drivers/` | Một driver cho mỗi provider: Claude, Codex, Grok Build qua CLI local (stream-JSON / JSON-RPC / ACP), cộng agent máy cloud. Driver lạ sẽ tụt xuống "unavailable", không bao giờ làm sập cả đội bot. |
| Harness | `server/harness/` | Registry (cấu hình → instance đang sống) + event bus mà mọi client cùng gộp. |
| API | `server/index.ts` | Bot, turn, approval, model catalog, vòng đời computer, connector, config — HTTP + SSE. |
| Voice | `server/tts/` | ElevenLabs, Fish Audio, Grok (xAI), giọng Mac có sẵn, hoặc Chatterbox local. Key cloud ở trên harness; markdown được viết lại cho hợp nghe trước khi đọc. |
| App | `src/` | Vỏ chat. Store dựa trên server, một reducer, không transport phía client. |
| Desktop | `electron/` | Vỏ macOS/Windows/Ubuntu với harness nhúng; giọng Apple chỉ macOS, Ubuntu Xorg có local control opt-in, Wayland mặc định fail-closed (từ chối thay vì cho qua). |

Hai điểm kiến trúc đáng học nhất cho open-bot:

1. **Chuẩn hoá mọi provider về một luồng event duy nhất.** Mỗi CLI nói một
   thứ tiếng khác nhau (stream-JSON, JSON-RPC, ACP), nhưng driver dịch hết
   về một "canonical runtime event stream" (ghi log theo từng thread dạng
   NDJSON), UI chỉ cần gộp một SSE stream. Open-bot hiện có provider là
   các API HTTP riêng lẻ; khi thêm CLI provider, nên có tầng dịch tương tự
   thay vì để UI hiểu từng CLI.
2. **Driver lạ thì "unavailable", không crash.** Registry có deadline
   snapshot 60 giây, tái dùng snapshot 3 giây, danh sách engine tái dùng
   60 giây (`OMB:server/harness/registry.ts`). Thiết kế này làm tính năng
   auto-detect an toàn: một CLI hỏng/chưa cài chỉ mờ đi kèm lý do, cả app
   vẫn chạy.

## 4. Engines — cách chạy CLI có sẵn trên máy user (trọng tâm)

### 4.1. Driver registry & hợp đồng chung

- Mỗi provider là một **driver** với `driverKind`, tên hiển thị, danh sách
  model, hàm giải mã cấu hình, hàm tạo runtime. Có 2 họ driver:
  **driver CLI** (Claude, Codex, Grok qua ACP — xem §4.2–4.4) và
  **driver API** (Grok qua API xAI, OpenAI-compatible, OpenRouter…).
- Cấu hình instance nằm trong `~/.openmausbot/config.json` mục
  `"instances"`; mỗi instance có `driver`, `displayName`, `config.cli`
  (đường dẫn/lệnh CLI tuỳ chỉnh) — tức **Settings → Engines cho phép trỏ
  tới binary CLI tuỳ chỉnh** (build có version riêng hoặc wrapper).
  (`OMB:docs/custom-engines.md` — chắc chắn.)
- Spawn/quản lý tiến trình tập trung ở `OMB:server/procs.ts` (462 dòng):
  các hàm resolve/spawn/exec/kill cây tiến trình CLI, đọc version CLI
  (timeout 30 giây), mô tả lỗi spawn, `killCliTree` (timeout 5 giây),
  chờ thoát, đường dẫn socket broker. Có kiểm tra độ dài dòng lệnh an toàn
  trên Windows (giới hạn 30.000 ký tự) và kiểm tra argv an toàn trước khi
  spawn. Đây là tầng mà open-bot cần tương đương: hiện open-bot có
  local-exec-daemon chạy shell, nhưng chưa có tầng spawn CLI có kiểm soát
  riêng cho agent CLI.
- **Fail-closed ở mọi chỗ:** driver không rõ → "unavailable"; tool scope
  không khớp → từ chối cả turn ("No prompt was sent" — không gửi prompt
  khi chưa chắc chắn MCP catalog/model khớp).

### 4.2. Claude Code — stream-JSON hai chiều, một process sống mỗi thread

Nguồn: `OMB:server/drivers/claude.ts` (2.090 dòng), comment đầu file:
"Claude Code over stream-json both ways: prompt on stdin, one retained CLI
process per thread" (chắc chắn).

- **Lệnh spawn:** binary `claude` (mặc định, cấu hình được) với các cờ
  `--output-format stream-json --input-format stream-json --verbose`
  (verbose là bắt buộc khi dùng stream-json output). Prompt **không đặt
  trên argv** mà đưa qua stdin — vì giới hạn dòng lệnh Windows
  (CreateProcess) và vì prompt có thể chứa nội dung nhạy cảm.
- **Mô hình process:** một CLI process được giữ sống cho mỗi thread
  (retained process); stdin mở suốt turn, turn kết thúc khi CLI trả event
  `result` trong khi stdin vẫn mở. Có cơ chế `closeSession` khi reset
  context hoặc "spawn contract" thay đổi.
- **Ảnh:** stream-json nhận image block trong bất kỳ user message nào,
  kể cả giữa turn.
- **Background call:** có đường gọi nền riêng (`claude-background.ts`,
  timeout riêng) — tách khỏi turn chính.
- **Keep-warm (prompt-cache):** `OMB:server/drivers/claude-keepwarm.ts`
  — ý tưởng mượn từ dự án Cache Tax (MIT): sau một khoảng idle, gửi MỘT
  request fork từ session đang sống với prompt cố định một dòng, để
  provider đọc lại prefix đã cache (và gia hạn thời gian sống của cache)
  thay vì message thật sau đó phải viết lại toàn bộ. Fork dùng
  `--resume <session> --fork-session` và `--no-session-persistence`
  (bản copy không bao giờ được ghi); tool vẫn khai báo nhưng không chạy
  được: hook PreToolUse từ chối mọi call, permission proxy trỏ tới socket
  chết. Đây là tối ưu chi phí/latency đáng học, nhưng là mốc sau (§13).
- **Kiểm tra đăng nhập:** dùng chính lệnh của CLI —
  `claude auth status --json` — để biết tài khoản mà instance đang chạy
  (`OMB:server/drivers/claude-auth-status.ts`, comment đầu file: "What
  `claude auth status --json` says about the account…"). Lưu ý trong file:
  nơi lưu credential khác nhau theo hệ điều hành (Keychain, file JSON) và
  kiểm tra "có file" chấp nhận cả credential đã cũ (stale) — chỉ có lệnh
  status của CLI mới nói đúng trạng thái. Đây là nguyên tắc vàng cho
  detector của open-bot: **hỏi chính CLI, đừng tự đọc file credential**.
- **Model:** driver Claude có các file riêng cho billing, giới hạn dùng,
  lịch sử chi phí, model catalog, MCP của project, tìm kiếm tool.

### 4.3. Codex — app-server JSON-RPC trên stdio

Nguồn: `OMB:server/drivers/codex.ts` (1.718 dòng), comment đầu file:
"The `codex` CLI headless over its app-server JSON-RPC (NDJSON on stdio):
completion is `turn/completed`, approvals arrive as server→client requests,
resumeCursor is the codex thread id" (chắc chắn).

- **Lệnh spawn:** `codex app-server` (+ các cờ `-c` ghi đè cấu hình).
  Đây là **long-lived JSON-RPC** (NDJSON trên stdio), khác với
  `codex exec --json` (một lần rồi thoát — xem
  `research-detected-cli-providers.md` §2.1). OpenMausBot chọn app-server
  vì cần multi-turn, approval giữa chừng, và resume bằng thread id.
- **Cấu hình theo turn:** approval policy, sandbox, MCP mount được truyền
  qua `-c mcp_servers.<tên>...`, `-c` cho approval mode của tool,
  timeout tool; các MCP server đã khai trong config của Codex nhưng không
  được chọn sẽ bị tắt (`enabled=false`) để turn không lọt tool ngoài ý.
- **Slot:** có cơ chế "Codex slot" — giới hạn số Codex run khởi động cùng
  lúc trên một máy; turn phải chờ slot trống thì mới spawn (thông báo
  "Waiting for a free Codex slot…"). Đáng học: CLI nặng không nên spawn vô
  hạn.
- **Resume/recovery:** có module `resume-recovery.ts` riêng (phân loại lỗi
  resume, có cho replay không, prompt khôi phục).
- **Kiểm tra đăng nhập:** `OMB:server/drivers/codex-identity.ts` —
  comment đầu file: "Codex resolves its own effective account (keyring
  included): reading auth.json directly can label an [account wrong…]"
  (đọc tới đây là hết câu trong file đã xem — ý rõ: **đừng đọc
  `auth.json` trực tiếp** vì Codex có thể lưu ở keyring; hãy để Codex tự
  cho biết tài khoản hiệu lực của nó). Ngoài ra có `codex-login.ts`,
  `codex-device-auth.ts` (device-code login), `codex-shared-home.ts`.
- **Token usage:** Codex báo usage dạng tổng chạy (running total) theo
  process app-server — cần trừ dồn để tính theo turn, không lấy số thô.

### 4.4. Grok — HAI driver: API xAI và CLI qua ACP

Đây là điểm dễ nhầm nhất, ghi rõ:

**a) Driver API (`OMB:server/drivers/grok.ts`, chỉ 64 dòng) — chắc chắn:**
Grok qua API xAI, theo hợp đồng OpenAI chat-completions:
`https://api.x.ai/v1`, key lấy từ biến môi trường `XAI_API_KEY`
(mặc định), model mặc định `grok-4.7` (context 500.000), các lựa chọn
`grok-4.7 / grok-4 / grok-4-fast / grok-3-mini`. Thiếu key thì báo
"Save an xAI API key in Settings → API keys, or set XAI_API_KEY".
Đây là driver mỏng vì phần nặng nằm ở runtime OpenAI-chat dùng chung
(`openai-chat.ts`).

**b) Driver CLI (`OMB:server/drivers/acp/grok.ts`, ~600 dòng) — chắc chắn:**
"Grok Build: the official `grok` CLI over ACP stdio (`grok … agent stdio`)
on the grok.com subscription login (`~/.grok/auth.json`), not the xAI API
key. Verified against grok 1.0.0."

- **Lệnh spawn:** `grok --permission-mode <mode> agent [-m <model>]
  [--reasoning-effort <level>] stdio`. Lưu ý: `--permission-mode` là
  global (đặt trước `agent`); `-m` và `--reasoning-effort` chỉ có tác
  dụng khi đặt giữa `agent` và `stdio` (đặt `-m` trước sẽ bị CLI hiểu là
  tuỳ chọn TUI và bỏ qua). Permission mode map từ approval mode của bot:
  `bypassPermissions` / `auto` / `acceptEdits` / `default`.
- **Đăng nhập:** home là `$GROK_HOME`, nếu không có thì `~/.grok`;
  **kiểm tra đăng nhập = file `auth.json` có tồn tại không**
  (`grokSignedIn`, `grokSignInState`). Lý do ghi trong file: **"Grok has
  no status command, so the stored auth.json is the sign-in check."**
  Đăng nhập bằng `grok login --device-auth`, đăng xuất `grok logout`
  (đã kiểm chứng với grok 1.0.25 và 1.0.41). Có phân loại lỗi login chi
  tiết (CLI quá cũ không có device-auth, tài khoản không hỗ trợ device
  code, code hết hạn, bị từ chối…).
- **Model catalog:** đọc từ `~/.grok/config.toml` — mục `[models]` /
  `[model.<slug>]` (slug local + tên), `grok -m <slug>` chấp nhận;
  mặc định cloud là grok-4.7/4.6/4.5. Có thể ghi thêm block
  `[model.<slug>]` vào config để trỏ tới host tự chèn (local inject).
- **Bảo mật đáng chú ý:** `transformEnv` **xoá `XAI_API_KEY` khỏi môi
  trường** của turn Grok CLI, với comment: "A leaked API key silently
  flips the grok.com subscription to pay-as-you-go" — tức rò rỉ key sẽ
  âm thầm chuyển subscription sang trả theo dùng. Đây là bài học trực
  tiếp cho open-bot: khi spawn CLI của user, phải dọn sạch biến môi
  trường key lạ khỏi môi trường con.
- **Tool scope:** Grok có profile tool riêng (`agentProfile` trong
  `_meta` của ACP `session/new`); tool gốc gồm read_file, search_replace,
  write, run_terminal_command, list_dir, grep, task/subagent, scheduler,
  monitor, plan mode, ask_user_question, image_gen/edit, image_to_video…
  (danh sách đầy đủ trong file, lấy từ registry mặc định của Grok 1.0.41).
  Chỉ hỗ trợ tool selection đã kiểm chứng trên grok 1.0.41; version khác
  thì từ chối.
- **Đổi model giữa chừng:** qua ACP `session/set_model`; nếu model
  không khớp profile thì từ chối cả turn thay vì đổi lặng lẽ.

### 4.5. Driver ACP chung — "một CLI nói ACP là chạy được"

Nguồn: `OMB:server/drivers/acp/core.ts` (1.731 dòng) + các driver con:
`cursor.ts` (560), `copilot.ts` (265), `cline.ts` (146), `gemini.ts` (91),
`droid.ts`, `deepseek.ts`, `custom.ts` (47).

- **Hợp đồng ACP:** mỗi driver ACP khai `defaultCli` (tên binary mặc
  định), `spawnArgs` (argv SAU tên binary để vào chế độ ACP stdio),
  `displayName`, model, `deviceSignIn` (login/logout bằng device code),
  `loginNote`, cách cài đặt, `pickAuthMethod`, `isAuthenticated`.
- **Custom ACP (zero-code):** `OMB:docs/custom-engines.md` — trỏ một
  instance `customAcp` tới bất kỳ CLI nào nói ACP trên stdio
  (`fx acp`, agent kiểu Zed, wrapper tự viết…): `config.cli` là **toàn bộ
  lệnh, kèm args** (kể cả `"npx -y some-agent acp"`). Quy tắc: "Sign in
  first. The driver has no auth flow of its own — run the CLI once in a
  terminal and log in there; OpenMausBot spawns it with your login
  intact." Instance chưa có lệnh sẽ hiện đúng gợi ý đó thay vì lỗi ở
  message đầu tiên. Model thì dùng **Re-detect** trong model picker để
  nạp model mà agent quảng cáo.
- **Version probe:** `OMB:server/drivers/acp/version-probe.ts` — đọc
  `--version` của CLI và so sánh version dạng bộ ba số; có chống lừa:
  nếu đường dẫn CLI thực ra là lệnh khác (ví dụ lệnh cài đặt dán nhầm
  thành đường dẫn), `--version` sẽ trả về version của chương trình kia
  và bị báo "không phải CLI của X".
- **Các ACP engine có sẵn:** Grok, Cursor (`cursor-agent`), Gemini,
  Cline, Copilot, Droid, DeepSeek, custom. Lưu ý: OpenCode cũng nói ACP
  (`opencode acp`) nhưng trong cây này OpenCode xuất hiện ở bot-box và
  catalog chứ không có driver ACP riêng — xem §4.6.
- Đây là mẫu thiết kế **quan trọng nhất** cho detected-provider của
  open-bot: một driver ACP chung + bảng khai báo theo từng CLI sẽ rẻ hơn
  nhiều so với viết driver riêng cho từng CLI.

### 4.6. Phát hiện đăng nhập — bảng tổng hợp theo engine

| Engine | Cách biết đã đăng nhập (theo code OMB) | Nguồn |
|---|---|---|
| Claude Code | Chạy `claude auth status --json` (lệnh của chính CLI) | `server/drivers/claude-auth-status.ts` |
| Codex | Hỏi Codex tự cho biết tài khoản hiệu lực (keyring cũng tính); không đọc `auth.json` trực tiếp | `server/drivers/codex-identity.ts` |
| Grok CLI | File `~/.grok/auth.json` (hoặc `$GROK_HOME/auth.json`) có tồn tại không; Grok không có lệnh status | `server/drivers/acp/grok.ts` (`grokSignedIn`, `grokSignInState`) |
| Gemini (ACP) | Qua driver ACP `gemini.ts` (đăng nhập theo cơ chế của Gemini CLI — xem doc CLI) | `server/drivers/acp/gemini.ts` |
| Cursor | Qua driver ACP `cursor.ts` + `cursor-sign-in` | `server/drivers/acp/cursor.ts` |
| OpenCode | Không có driver riêng trong cây này; OpenCode chạy qua bot-box/catalog và ACP chung (suy đoán) | `server/bot-box/`, `server/model-catalog/` |
| Bất kỳ CLI ACP nào | `isAuthenticated` của driver đó; chưa đăng nhập thì hiện `loginNote` + nút Sign in | `server/drivers/acp/core.ts` |

Nguyên tắc chung rút ra: **mức tin cậy giảm dần: lệnh status của CLI >
hỏi CLI qua protocol > kiểm tra file tồn tại.** Chỉ kiểm tra *sự tồn tại*
của file, không bao giờ đọc nội dung credential.

### 4.7. Đồng bộ sign-in giữa các "home" (engine-homes)

Nguồn: `OMB:server/engine-homes/sign-ins.ts` (85 dòng) +
`engine-homes.ts`, `layout.ts` — chắc chắn (đã đọc toàn bộ file).

- Vấn đề: mỗi "audience" (người dùng/bot) giữ một bản copy file sign-in
  ở nơi engine của nó tìm; trong bot box, file của team được bind đè lên
  bản copy đó, nên token được refresh sẽ rơi vào file của team. Ngoài
  box, engine tự ghi bản copy của nó, và lần spawn sau ở audience nào
  cũng lấy bản mới nhất đã "lắng" (settled) về lại file team.
- Cơ chế: bản copy mới hơn file team **và** đã lắng ít nhất 2 giây
  (`SETTLED_MS = 2_000`, tránh đọc file đang ghi dở) **và** đọc được
  trọn vẹn (file `.json` phải parse được JSON) thì mới được "lấy về"
  (taken back) bằng cách ghi đè tại chỗ (`writeInPlace`, giữ nguyên
  inode để box đang bind vẫn thấy). Ngược lại, file team được copy ra
  bản copy bằng cách ghi file tạm (mode `0600`) rồi đổi tên nguyên tử
  (`renameSync`), thư mục tạo với mode `0700`.
- Đây là chi tiết tinh vi mà open-bot sẽ cần khi cho bot chạy trong
  sandbox/VM nhưng vẫn dùng login của user: **đừng copy token lung tung;
  đồng bộ có kiểm tra "đã lắng + đọc trọn vẹn", ghi nguyên tử, quyền
  file chặt.**

### 4.8. Model catalog

Nguồn: `OMB:server/model-catalog/catalog.ts` (371 dòng) + `presets.ts`,
`trim.ts`, `models-dev.snapshot.json` — chắc chắn phần đầu file.

- Catalog lấy từ **models.dev** (`https://models.dev/api.json`, cache
  24 giờ, timeout 10 giây, tối đa 20 MB, tắt được bằng biến môi trường
  `OMB_DISABLE_MODEL_CATALOG_FETCH`), có snapshot dự phòng trong repo.
- Phần code xử lý catalog **ghi rõ nguồn gốc: "Adapted from
  anomalyco/opencode … MIT; modified"** kèm toàn bộ text giấy phép MIT —
  tức họ tái dùng code OpenCode có ghi công, không âm thầm lấy. Open-bot
  nếu học theo cũng phải ghi nguồn tương tự khi tái dùng code MIT.
- Mỗi driver còn có catalog riêng (static + đọc từ config local của CLI,
  ví dụ `~/.grok/config.toml`); model picker hợp nhất cả hai.

### 4.9. Cái đã có sẵn cho "engines" mà open-bot chưa có

- Phát hiện CLI bằng `--version` + kiểm tra version tối thiểu.
- Trỏ tới binary tuỳ chỉnh (Settings → Engines).
- Một process sống mỗi thread (Claude) / app-server sống (Codex) — không
  spawn mới mỗi message.
- Permission broker: yêu cầu quyền của CLI chạy ngược về harness để user
  duyệt (xem §9).
- Đồng bộ sign-in an toàn (§4.7), dọn biến môi trường key lạ (§4.4).
- Keep-warm cache, slot giới hạn Codex, resume/recovery.

## 5. Harness local — một server nhỏ sở hữu mọi tiến trình

Nguồn: `OMB:server/harness/` (registry.ts 575 dòng, bus.ts 307 dòng,
http.ts 81 dòng, engine-status-file.ts, live-steps.ts, progress-gate.ts,
tunnel-gzip.ts, unasked-stop.ts, wsl-launch.ts) + `OMB:server/index.ts`
(API) — chắc chắn ở mức cấu trúc, suy đoán ở chi tiết logic.

- **Registry** (`registry.ts`): ánh xạ cấu hình instance → instance đang
  sống; snapshot trạng thái engine có deadline 60 giây, tái dùng trong
  3 giây; danh sách engine tái dùng trong 60 giây; bước đọc khi khởi động
  5 giây. Có khái niệm "shadow instance" (instance bóng — suy đoán: bản
  sao dự phòng/đang khởi động).
- **Event bus** (`bus.ts`): "fan-in" — mọi driver đổ event về một bus,
  bus phát ra **một luồng SSE duy nhất** cho client gộp vào state.
  Event được ghi log theo từng thread dạng NDJSON (để xem lại/replay).
- **Engine status file** (`engine-status-file.ts`): ghi snapshot trạng
  thái từng engine ra file (dạng `EngineStatusRow`: instanceId,
  driverKind, cli, snapshot) — snapshot chứa `state`
  (available/unavailable), `account` (email, organization, method
  login/api-key — chỉ nhãn, không token), `update`/`warning` (tiêu đề,
  message, command). UI đọc file/snapshot này để vẽ provider rail
  (§8). Ghi file dùng **atomic write nếu có thay đổi**
  (`writeFileAtomicIfChanged`) — tránh ghi đè liên tục.
- **HTTP** (`http.ts` chỉ 81 dòng — suy đoán: tầng HTTP mỏng, logic nặng
  ở `server/index.ts` và `server/routes/`).
- **Tiến trình:** `server/procs.ts` quản lý spawn/kill/cây process
  (§4.1); có `wsl-launch.ts` (chạy trên WSL), `tunnel-gzip.ts` (nén
  tunnel), `progress-gate.ts`, `unasked-stop.ts` (dừng khi không được
  hỏi — suy đoán: tự dừng turn/process thừa).
- **Đối chiếu open-bot:** open-bot đã có `local-exec-daemon` +
  `node-agent-coordinator` (tách tiến trình, theo phân tích Grok Bot) và
  Local API + WebSocket streaming. Cái thiếu là **tầng registry +
  event-bus chuẩn hoá theo provider** và **engine status snapshot**
  (trạng thái từng nguồn model, có lý do khi unavailable). Đây là phần
  lõi của detected-provider (§13, mốc M1).

## 6. Bot box / VM / sandbox — máy tính của bot

Nguồn chính: `OMB:docs/bot-box.md` (đã đọc đầu file), `server/bot-box/`
(38 file), `server/boat.ts` + `boat-*.ts`, `server/local-vm-*.ts`,
`server/box-*.ts`, `OMB-README` — chắc chắn ở mức mô tả docs, suy đoán
ở chi tiết code chưa đọc.

### 6.1. Bot box — sandbox bubblewrap cho từng turn (cloud)

Theo `docs/bot-box.md`: trên MausBot Cloud home, **mọi turn của bot chạy
trong một box**: engine (Claude Code, Codex, Grok, OpenCode, các agent
ACP), mọi lệnh shell nó chạy, các MCP server nó khởi động, và các helper
proxy của OpenMausBot đều sống trong **một sandbox bubblewrap
không đặc quyền, riêng cho vòng đời của process đó**. Server, database,
settings, thư mục của bot khác và process của turn khác **không nằm
trong box**.

Bên trong box thấy gì:

| Trong box | Là gì |
|---|---|
| `/usr`, `/etc`, `/opt`, thư mục code của server — chỉ đọc | Image: CLI engine, node, python, git, trình duyệt của bot |
| `HOME` — đọc/ghi | Login và settings của chính engine (`~/.claude`, `~/.codex`, `~/.grok`); trên Team Cloud thì đây là engine home của audience của turn, với file sign-in của team được bind vào |
| Thư mục dữ liệu (`~/.openmausbot`) — **thư mục riêng trống** | `messages.db`, `config.json`, login, socket server, thư mục bot khác đều không có trong box |
| Được đưa lại vào box: thư mục làm việc của turn + thư mục của bot (`workspaces/<bot>`) — đọc/ghi | Thứ turn làm việc, memory và skill của bot |
| Được đưa lại: socket quyền của turn này, thư mục hook token (chỉ đọc, bearer làm mới mỗi turn), file mà dòng lệnh nêu tên (config MCP, system prompt) | Thứ driver tạo riêng cho process này |
| `/tmp`, `/var/tmp`, `/run`, `/dev`, `/proc` riêng | PID namespace riêng: process của turn khác không tồn tại với nó |
| `/sys/devices/system/cpu/possible` và `online` (chỉ đọc) | Số CPU của máy (cần cho runtime dùng TCMalloc, ví dụ Antigravity) |
| Network namespace chỉ có loopback | Hai cổng loopback được bridge sang unix socket bên ngoài; không còn gì khác trên loopback chạm được, không có đường ra |

Môi trường trong box là **allow-list** (`server/bot-box/env.ts`): chỉ
settings/key của chính engine, token capability của harness và vài tên
mà shell cần. Mọi biến `OMB_CLOUD_*`, vị trí đặt server (`OMB_DATA_DIR`,
`OMB_PORT`) và credential của workspace đều bị từ chối dù driver có
truyền vào.

**Hai cổng kiểm soát:**

- **Egress gate** (`server/bot-box/egress-gate.ts`): proxy HTTP
  (`CONNECT`, URL tuyệt đối cho http thường) ở `127.0.0.1:3128` trong
  box, bridge tới gate của server. `HTTPS_PROXY`/`HTTP_PROXY` trỏ vào
  đó. Gate tự resolve tên và chỉ nối tới **địa chỉ public**: địa chỉ
  máy này, mạng local, link-local, metadata service của cloud và mạng
  riêng của Fly đều bị từ chối theo địa chỉ — tên miền hay redirect đều
  không vòng qua được. Đây là "anh em sinh đôi" của gate SOCKS cho
  trình duyệt (`server/browser/egress/`), cùng chính sách địa chỉ.
- **Harness gate** (`server/bot-box/harness-gate.ts`): cổng của server
  trong box chỉ tới được các route `/api/internal/`, mỗi helper gọi kèm
  bearer capability theo từng turn. Route khác bị gate trả `403` ngay,
  server không bao giờ bị hỏi tới.

**Sign-in relay:** file sign-in của team được bind vào engine home
trong box (xem §4.7) — token refresh trong box rơi về file team.

Đối chiếu: open-bot đã có sandbox workspace allowlist + SSRF check cho
`web_fetch` + egress module (`packages/core/src/egress/` — theo cây
thư mục hiện tại), nhưng **chưa có sandbox process kiểu bubblewrap
theo từng turn, chưa có egress proxy, chưa có allow-list env**. Đây là
mảng lớn nhất còn thiếu về mặt kiến trúc an toàn (§13, mốc M4).

### 6.2. Boat — cloud desktop riêng từng bot

Nguồn: `OMB:server/boat.ts` + các file `boat-*.ts`, comment đầu file —
chắc chắn ở mức API, suy đoán ở vận hành.

- Boat (boat.dev) là nhà tài trợ, cung cấp **cloud computer cho từng
  bot** (không phải một máy chung cho cả tài khoản như Grok Bot).
  API public v1, đã đo (probed) 2026-07-24 / v1 2026-10-13:
  tạo máy trả 202, sẵn sàng sau ~2 giây; dừng → archived ~5 giây;
  resume → idle ~8 giây; disk giữ nguyên, tmux không giữ.
  Lệnh shell chạy đồng bộ qua `POST /sandboxes/{id}/commands` (~0,2 giây).
- **Stream token xoay mỗi lần đổi trạng thái** và IP riêng cũng xoay khi
  archive/resume — **không bao giờ lưu hai thứ này bền**.
- Có journal/idempotency cho tạo máy (`boat-create-idempotency.ts`),
  lifecycle, trial, relay, screenshot, auto-sleep, inventory, xoá an
  toàn (`boat-deletion.ts` — suy đoán: xoá có kiểm tra còn snapshot mới
  không).
- Đối chiếu: open-bot có session box (local) nhưng **chưa có cloud
  desktop thuê ngoài theo từng bot** — đây là tính năng cần đối tác hạ
  tầng (Boat hoặc tương đương), không tự viết được trong một mốc ngắn;
  nên để ở mốc muộn, sau khi local VM chạy tốt.

### 6.3. Local VM & máy của chính user

- `server/local-vm-*.ts`: inventory, lease (thuê), seat pool, profiles,
  settings, lý do dừng — tức **Local VM tách biệt** cho bot (máy ảo
  local riêng, không phải máy user). Có `group-local-vm.e2e.test.ts`
  (VM cho nhóm).
- Chế độ thứ ba: **chính máy người dùng** khi được opt-in (bot chạy
  thẳng trên máy user qua CLI local — đây chính là chế độ mặc định của
  detected-provider: không cần VM gì cả, CLI chạy ngay trên máy).
- `server/box-*.ts`: box attachments, box memory — quản lý file/bộ nhớ
  của box.
- Ba chế độ máy (cloud desktop / Local VM / máy user) + model riêng +
  app riêng = "mỗi bot có não + máy riêng" trong README.

## 7. App integrations — Composio (500+ app)

Nguồn: `OMB:server/composio.ts` (1.091 dòng) + `composio-*.ts`,
`OMB-README`, `OMB-BLOG` — chắc chắn ở mức cấu trúc, suy đoán ở chi
tiết.

- **Composio** là lớp tích hợp app: Gmail, Slack, GitHub, Notion, Linear
  và hàng trăm app khác. User **OAuth một lần**, mọi bot đều dùng được
  các app đó dưới dạng tool.
- Cấu trúc code: `composio.ts` (chính), `composio-project.ts`
  (project/session, API key của project), `composio-session.ts`
  (session theo toolkit, multi-account), `composio-broker-access.ts`,
  `composio-share.ts`, `composio-auth-configs.ts`, cộng các file
  `shared/connector-*.ts` (availability, curated connector, account
  link, auth config hint). Có khái niệm **curated connector**
  (connector được chọn lọc sẵn) và **auth config** (cấu hình auth được
  quản lý — từ chối có lý do khi không dùng được).
- Có `CONNECTOR_ALLOWED_TOOLS_ENV` + giới hạn byte
  (`CONNECTOR_ALLOWED_TOOLS_MAX_BYTES`) — tức tool của connector cũng bị
  giới hạn số lượng/kích thước, giống bài toán tool-filter của open-bot.
- Ngoài Composio, repo còn có `server/phones/`, `server/email/`,
  `server/meetings/`, `server/pages/`, `server/tts/`, `server/postiz/`
  — các tích hợp tự làm (suy đoán theo tên thư mục).
- Đối chiếu: open-bot đã có MCP client/marketplace + tool Slack/Teams/
  email/iMessage/meeting rời rạc. Cái thiếu là **một lớp "connected
  apps" thống nhất kiểu Composio**: OAuth một lần, chia sẻ cho mọi bot,
  có catalog app + trạng thái auth rõ ràng. Đây là mảng to thứ hai sau
  engines (§13, mốc M5). Lưu ý: Composio là dịch vụ bên thứ ba (có
  phí/khóa API) — open-bot cần đánh giá: tự làm lớp tương đương trên MCP
  hay dùng Composio; không quyết ở wave nghiên cứu này.

## 8. Model picker + provider rail

Nguồn: `OMB:src/components/ModelPicker.tsx`, `ModelPickerFull.tsx`,
`ModelPickerBusyMenu.tsx`, `src/lib/engine-rail.ts`,
`src/lib/model-picker-pane.ts`, `src/state/engine-install.ts`,
`src/components/EnginesSettings.tsx`, `EngineAccounts.tsx`,
`EngineSetup.tsx`, `EngineLiveCheck.tsx`, `NoEngines.tsx`,
`OMB-BLOG` (ảnh chụp model picker) — chắc chắn ở mức cấu trúc file và
logic trong `engine-rail.ts` (đã đọc), suy đoán ở chi tiết render.

- **Provider rail:** các provider xếp cạnh nhau thành rail (Claude,
  Codex, Grok…). Hàm `splitEngineRail` chia instance thành 3 nhóm:
  **subscription** (đăng nhập bằng subscription sẵn có),
  **api** (dùng API key), **custom** (engine tự thêm). Rail hiển thị
  theo đúng 3 nhóm này.
- **Provider không dùng được thì mờ đi kèm lý do** (theo blog: "One bot,
  any model. Unavailable providers are dimmed with the reason."). Logic
  trong `engine-rail.ts`: chỉ hiện instance nào `snapshot.state ===
  "available"` và có model (hoặc là ChatGPT plan); instance đã đăng
  nhập nhưng chưa từng trả danh sách model thì "đáng hỏi lại"
  (`modelsAwaitEngine` — một engine đã đăng nhập mà chưa đưa danh sách
  thì nên hỏi, còn engine chưa đăng nhập thì hỏi cũng chỉ bị từ chối).
- **Đổi model giữa chừng:** được, không mất thread (theo blog:
  "You can switch a bot's model mid-conversation without losing the
  thread"). Đổi model gọi `session/set_model` của ACP (Grok) hoặc
  tương đương; nếu model mới không khớp profile/tool thì từ chối.
- **Re-detect:** trong model picker có nút Re-detect để nạp lại model
  mà agent quảng cáo (đặc biệt cho custom ACP).
- **Cài đặt engine:** `EnginesSettings.tsx` (Settings → Engines),
  `EngineSetup.tsx` (hướng dẫn đăng nhập), `EngineLiveCheck.tsx`
  (kiểm tra sống), `EngineAccounts.tsx` (tài khoản từng engine),
  `CloudEngineSignIn.tsx`, `NoEngines.tsx` (trạng thái chưa có engine
  nào), `EngineUsage.tsx` (mức dùng). Tức có cả một **luồng onboarding
  cho engines**, không chỉ một màn hình setting.
- **Sign-in family:** `engine-rail.ts` phân biệt họ đăng nhập
  `claude` (driverKind `claudeAgent`) và `openai` (driverKind `codex`)
  để hiển thị đúng nhãn tài khoản.
- Đối chiếu: open-bot có model registry + provider API key, nhưng
  **chưa có provider rail, chưa có trạng thái available/unavailable kèm
  lý do, chưa đổi model giữa chừng, chưa có luồng Engines onboarding**.
  Đây là phần UI quan trọng nhất của detected-provider (§13, mốc M2–M3).

## 9. Hình dáng sản phẩm (Telegram-style)

Nguồn: `OMB-README`, `OMB-BLOG`, cây `src/components/` — chắc chắn ở
mức mô tả blog + tên file, suy đoán ở chi tiết tương tác.

- **App chat kiểu Telegram:** sidebar là danh sách bot (mỗi chat là một
  agent thật), mỗi bot có personality, model, máy tính, app riêng.
  Một bot viết lách chạy Claude trong khi bot refactor chạy Codex, cùng
  lúc, cùng workspace.
- **Approval cards:** mọi hành động rủi ro (lệnh shell, sửa file, câu
  hỏi) hiện thành **thẻ Allow / Deny trong chat** (`src/components/
  ApprovalCard.tsx`, `PendingApproval.tsx`, `CallSheet.tsx`,
  `CallView.tsx`, `OptionsCardRow.tsx` — thẻ câu hỏi có lựa chọn dạng
  chữ cái + ô trả lời tự do, theo ảnh trên blog). Hành vi giống nhau dù
  bot ở cloud desktop hay trên máy user. Triết lý trong blog: "Every
  risky action is a decision you make, not one you audit afterwards."
  Mức approval là **của riêng từng bot**, áp dụng cho turn provider tiếp
  theo, đổi được cả khi bot đang làm việc (`docs/approval-levels.md`).
  Mức này thực chất là **permission mode của chính provider được truyền
  qua** (Claude/Codex/Grok), không phải lớp riêng của app. Có ngoại lệ:
  **bot đọc file của chính nó không bao giờ hỏi** (SOUL.md, skill,
  memory, thư mục hội thoại của nó — kể cả lệnh `cat/head/tail/grep/
  rg/sed -n/ls/wc/nl/stat` bằng từ đơn giản và các tool Read/Grep/Glob/
  LS của Claude, khi mọi đường dẫn nằm trong thư mục của bot).
  Mặc định mọi bot/conversation mới là **Full access** (giống mặc định
  của T3 Code); workspace công ty host thì mặc định là Ask.
- **Group chat giữa các bot:** có, với @mentions, delegation (giao
  việc), group call.
- **Scheduled routines:** có, theo lịch hoặc từ webhook (tối đa 50
  routine/bot theo blog so sánh — con số này là của Grok Bot; phía
  MausBot không nêu giới hạn).
- **Voice:** bot đọc trả lời thành tiếng, hoặc gọi điện cho user
  (ElevenLabs, Fish Audio, Grok xAI, giọng Mac, Chatterbox local).
- **Headless CLI:** lệnh `openmausbot` chạy workspace không cần màn
  hình (`openmausbot team apply team.yaml`, `openmausbot run "Room
  Lead" "…" --export ./out`), một tài liệu JSON với `--json`, exit code
  để script rẽ nhánh (`docs/headless-cli.md`).
- **MCP server:** stdio MCP server cho client ngoài (Claude Desktop,
  Cursor): xem bot/channel, đọc/tìm trang transcript rút gọn, tạo/cấu
  hình bot/channel/task, gửi việc, chờ hoàn thành, đổi model, ngắt turn.
  **Không** expose approval grant, xoá, setting tuỳ ý, credential, vòng
  đời computer — "bounded team control plane" có chủ ý.
- **Teams/portable format:** bot team có định dạng file portable
  (repo riêng `openmausbot-teams`, FORMAT.md), import bằng "Add to
  OpenMausBot" từ BotMRR.
- Đối chiếu: open-bot đã có approval (3 lớp, denylist thắng), handoff,
  subagent 5 vai, automations/dream, voice realtime, A2A, Local API +
  webhooks, MCP server. Cái thiếu là **hình dáng "mỗi bot là một chat"**
  (hiện open-bot là một agent/chat đơn?), **approval card trong chat**,
  **group chat bot-bot với @mentions**, và **headless CLI** kiểu
  `openmausbot run`. Đây là mảng UI/sản phẩm, nên làm sau engines +
  sandbox.

## 10. Stack

- **Electron + React 19 + TypeScript strict**, Vite, Tailwind CSS,
  Node 24+, pnpm. Chạy macOS / Windows / Ubuntu 24.04 x64.
- Desktop build nhúng harness server (không cần setup server riêng).
  Có thể pair client với host khác qua Tailscale (desktop-to-desktop
  companion mode, `docs/desktop-companion.md`).
- Release: macOS Apple silicon + Intel (.dmg, signed & notarized),
  Windows x64 (installer, chưa code-sign — SmartScreen báo unknown
  publisher), Ubuntu 24.04 (.deb hoặc AppImage beta).
- CI 3 hệ điều hành (theo `docs/ci.md` — suy đoán từ tên file).
- Đối chiếu: open-bot cũng Electron + React + TypeScript — stack tương
  đồng, nên việc học kiến trúc không bị lệch stack. Điểm khác: open-bot
  chưa có build/packaging đa nền tảng hoàn chỉnh và chưa có companion
  mode.

## 11. Đối chiếu từng điểm với open-bot

Ký hiệu: ✅ đã có (tương đương) · ◐ có một phần · ❌ chưa có.
Căn cứ open-bot: commit `c9298cd` (v0.37) + MEMORY.md (v0.38) + đo §2.

| # | Điểm của OpenMausBot | Open-bot hiện tại | Trạng thái |
|---|---|---|---|
| 1 | Driver registry: một driver / provider, hợp đồng chung | Provider API-key (6 provider: OpenAI, Anthropic, Gemini, xAI, Ollama, OpenAI-compatible) trong `packages/core/src/providers/` | ◐ (có provider, chưa có driver CLI/hợp đồng driver) |
| 2 | Driver Claude (stream-JSON 2 chiều, process sống/thread) | Chưa có | ❌ |
| 3 | Driver Codex (app-server JSON-RPC, thread/resume) | Chưa có | ❌ |
| 4 | Driver Grok CLI qua ACP (`grok agent stdio`) | Chưa có (chỉ có Grok API qua key) | ❌ |
| 5 | Driver ACP chung + customAcp (bất kỳ CLI nào nói ACP) | Chưa có | ❌ |
| 6 | Phát hiện CLI: `--version` + version tối thiểu + binary tuỳ chỉnh | Chưa có | ❌ |
| 7 | Kiểm tra đăng nhập bằng lệnh của chính CLI (`claude auth status --json`, Codex tự báo, Grok xem `auth.json`) | Chưa có | ❌ |
| 8 | Đồng bộ sign-in an toàn (settled 2s, ghi nguyên tử, 0600/0700) | Vault có NO_STORAGE + rotateKey; chưa có đồng bộ sign-in kiểu này | ◐ |
| 9 | Harness local 127.0.0.1 + registry + event bus SSE + NDJSON log/thread | Local API + WebSocket streaming + local-exec-daemon + node-agent-coordinator; chưa có registry/bus chuẩn hoá theo provider | ◐ |
| 10 | Engine status snapshot (available/unavailable + lý do + tài khoản) | Chưa có | ❌ |
| 11 | Spawn CLI có kiểm soát (`procs.ts`: kill cây process, giới hạn dòng lệnh Win, timeout) | local-exec-daemon chạy shell + kill process-group (đã fix bug); chưa có tầng spawn CLI riêng | ◐ |
| 12 | Bot box bubblewrap theo turn + egress gate proxy + harness gate + env allow-list | Sandbox workspace allowlist + SSRF check + module egress; chưa có sandbox process/egress proxy | ◐ |
| 13 | Cloud desktop riêng từng bot (Boat) | Session box local; chưa có cloud desktop thuê ngoài | ❌ |
| 14 | Local VM tách biệt cho bot | Chưa có | ❌ |
| 15 | Composio: 500+ app, OAuth một lần, chia sẻ mọi bot | MCP client/marketplace + tool Slack/Teams/email/iMessage rời rạc; chưa có lớp "connected apps" thống nhất | ◐ |
| 16 | Model picker + provider rail (subscription/api/custom, mờ + lý do, Re-detect, đổi model giữa chừng) | Model registry + chọn model; chưa có rail/trạng thái/đổi giữa chừng | ◐ |
| 17 | Approval card trong chat (Allow/Deny + question card) + mức approval theo bot (pass-through permission mode của provider) | Approval 3 lớp + auto-approve cấu hình được (denylist thắng); chưa có card trong chat | ◐ |
| 18 | Bot đọc file của chính nó không bao giờ hỏi | Chưa có quy tắc này dạng tường minh | ❌ |
| 19 | Group chat bot-bot (@mentions, delegation, group call) | A2A client (6 tool) + message_agent + subagent; chưa có group chat UI | ◐ |
| 20 | Routines theo lịch/webhook | Automations (cron/interval/event/manual) + dream + webhooks HMAC; chưa có trigger webhook kèm credential riêng như Grok Bot | ◐ |
| 21 | Voice TTS đọc trả lời (ElevenLabs/Fish/Grok/Mac/Chatterbox) | Voice realtime (OpenAI Realtime) + voice memo; TTS đọc trả lời chưa rõ | ◐ |
| 22 | Headless CLI (`openmausbot team apply/run --export`) | Chưa có CLI headless riêng (có Local API + webhooks) | ❌ |
| 23 | MCP server "bounded" (không expose approval/xoá/credential/computer) | Đã có MCP server (stdio + Streamable HTTP, spec 2025-11-25, allowlist chỉ-đọc) | ✅ (hơn ở allowlist, xem lại scope) |
| 24 | Keep-warm prompt-cache (fork `--resume --fork-session`) | Chưa có | ❌ |
| 25 | Slot giới hạn số Codex run đồng thời | Chưa có giới hạn spawn theo provider | ❌ |
| 26 | Model catalog từ models.dev (snapshot + cache 24h) | Model registry nội bộ + GEMINI_KNOWN_MODELS (đã mở 3→15); chưa có catalog ngoài | ◐ |
| 27 | Dọn `XAI_API_KEY` khỏi env của turn Grok CLI | Chưa có quy tắc dọn env theo provider | ❌ |
| 28 | Desktop đa nền tảng + companion qua Tailscale | Electron desktop (chưa rõ packaging 3 OS) | ◐ |
| 29 | Test nặng (~54% tổng dòng là test, kèm e2e + golden) | 1.350 test (1.345 pass, 5 skip); tỷ lệ test thấp hơn nhiều | ◐ |

**Kết luận đối chiếu:** open-bot đã có "thân" (agent core, tool, MCP,
vault, automations, voice, A2A, team) nhưng **thiếu hẳn "lớp engines"**
(dòng 2–8, 10, 16, 24–25, 27) và **thiếu "lớp máy"** (dòng 12–14).
Đây là hai lớp làm nên quy mô của OpenMausBot — và là hai lớp Huy muốn
mở rộng trước.

## 12. Đối chiếu quy mô từng mảng (open-bot vs OpenMausBot)

Số liệu open-bot đo cùng ngày (trừ test/dist); OpenMausBot lấy từ §2.2.
"Tỉ lệ" = dòng nguồn OMB / dòng nguồn open-bot cùng mảng (gần đúng,
vì cách chia module hai bên không giống hệt nhau).

| Mảng | Open-bot (dòng nguồn / file) | OpenMausBot (dòng nguồn / file) | Tỉ lệ | Nhận xét |
|---|---|---|---|---|
| Agent core + providers | core 55.118 / 146 (gồm agent, providers, MCP, vault, automations, voice, team, session, guardrails…) | server (trừ drivers) ~212.807 / ~2.373 | ~3,9× | OMB chia nhỏ hơn nhiều (routes, host, browser, decider, runtime, sentinel, tts, phones, email, meetings…) |
| Engines / drivers (CLI + API) | 0 (chưa có; providers API-key ~8 file trong core) | drivers 32.515 / 167 file nguồn | ∞ | **Mảng thiếu hoàn toàn, ưu tiên số 1** |
| Harness / registry / bus | coordinator + session + api (một phần core) | harness 1.532 / 9 file nguồn (+ `procs.ts` 462 dòng) | — | OMB tách riêng, mỏng nhưng rõ; open-bot đã có daemon/coordinator, cần thêm registry/bus |
| Tools | tools 18.225 / 34 | Nằm rải trong drivers + `agents-*-tools.ts` (không tách package riêng) | — | Hai bên tổ chức khác nhau; open-bot đã có 131 tool, hơn về số lượng |
| VM / sandbox / máy của bot | session box + sandbox (một phần core; chưa đo riêng) | boat/box/local-vm/cloud ~43.245 dòng / 212 file (kèm test) | lớn | **Mảng thiếu lớn thứ hai** |
| App integrations (Composio-style) | connectors + MCP marketplace (một phần core) | `composio.ts` 1.091 dòng + ~14 file + `shared/connector-*` | — | OMB có lớp thống nhất; open-bot còn rời rạc |
| Model picker / catalog | models (một phần core) | `model-catalog/` + `ModelPicker*` + `engine-rail.ts` | — | OMB có catalog ngoài (models.dev) + UI rail |
| UI (renderer) | desktop 11.446 / 26 | src 138.348 / 985 file nguồn | **~12×** | **Khoảng cách lớn nhất** — OMB có hàng trăm component/panel; open-bot UI còn mỏng |
| Electron main / vỏ desktop | (trong desktop 11.446) | electron 34.435 / 255 file nguồn | ~3× | OMB có vỏ 3 OS + companion |
| Test | ~1.350 test (số dòng test chưa đo riêng) | ~522.974 dòng test / 2.575 file | — | OMB viết test gấp nhiều lần; cần nâng test khi làm engines |
| **Tổng** | **84.828 / 207** | **~449.897 / 2.775** | **~5,3×** | Chưa tính test (OMB ~973k dòng kèm test) |

## 13. Đề xuất mốc mở rộng quy mô (để điều phối viên đưa vào BEYOND-ROADMAP)

Thứ tự ưu tiên theo chỉ đạo của Huy: **mảng làm open-bot to lên thật
(engines, VM/sandbox, app integrations) trước tính năng nhỏ.** Mỗi mốc
ghi: làm gì, chạm module nào của open-bot, ước lượng quy mô, cách xác
minh. Ước lượng là ước lượng (dựa trên quy mô tương ứng ở OMB, đã trừ
đi phần open-bot có sẵn); không phải cam kết.

### M1 — Detector registry + driver CLI đầu tiên (Claude Code) [ƯU TIÊN 1]

- **Làm gì:** Registry phát hiện CLI trên máy: quét `PATH` tìm binary
  (`claude`, `codex`, `grok`, `opencode`, `gemini`, `cursor-agent`),
  probe `--version` + version tối thiểu, kiểm tra đăng nhập bằng lệnh
  của chính CLI (`claude auth status --json`…), lưu snapshot trạng thái
  (available/unavailable + lý do + nhãn tài khoản, không token).
  Driver Claude đầu tiên: spawn `claude` với stream-JSON hai chiều,
  prompt qua stdin, một process sống mỗi thread, parse NDJSON event về
  event stream chuẩn của open-bot. Opt-in rõ ràng, tắt được từng nguồn.
- **Chạm:** mới `packages/core/src/detected/` (registry, detector,
  snapshot) + `packages/core/src/providers/cli/` (driver Claude);
  nối vào model registry + `packages/core/src/session/`; UI Settings →
  Engines (mới, trong `apps/desktop/src`).
- **Ước lượng:** ~4.000–6.000 dòng nguồn / 25–35 file (kèm ~3.000 dòng
  test). Tham chiếu OMB: `claude.ts` 2.090 dòng + `procs.ts` 462 dòng +
  `engine-status-file.ts` + `acp/version-probe.ts`.
- **Xác minh:** test giả lập CLI (fake binary trả stream-JSON mẫu);
  trên máy thật có Claude Code đăng nhập: detector nhận ra, status hiện
  đúng tài khoản, một turn chạy qua CLI và trả về event chuẩn; tắt
  nguồn thì provider biến mất khỏi picker; build + typecheck xanh.

### M2 — Driver Codex (app-server JSON-RPC) + driver Grok CLI (ACP)

- **Làm gì:** Driver Codex qua `codex app-server` (NDJSON JSON-RPC
  trên stdio, `thread/start`/`thread/resume`, `turn/completed`,
  approval dạng server→client request, resumeCursor = thread id;
  `-c` để mount MCP + đặt approval/sandbox; slot giới hạn số run đồng
  thời). Driver Grok CLI qua ACP (`grok --permission-mode … agent
  [-m model] stdio`, đăng nhập kiểm tra bằng `~/.grok/auth.json`,
  `grok login --device-auth`; dọn `XAI_API_KEY` khỏi env của turn).
- **Chạm:** `packages/core/src/providers/cli/` (+2 driver); registry
  M1 mở rộng thêm 2 detector; model registry thêm model Grok CLI.
- **Ước lượng:** ~5.000–7.000 dòng nguồn / 30–40 file (kèm ~4.000 dòng
  test). Tham chiếu OMB: `codex.ts` 1.718 + `acp/grok.ts` ~600 +
  `acp/core.ts` 1.731 (nếu làm ACP chung ngay thì cộng thêm).
- **Xác minh:** như M1, trên máy thật có Codex/Grok CLI đăng nhập;
  resume thread Codex sau khi ngắt; approval Codex hiện về UI và user
  duyệt/từ chối được; Grok CLI chạy mà không cần key xAI.

### M3 — Driver ACP chung + custom CLI (OpenCode, Gemini CLI, Cursor CLI…)

- **Làm gì:** Tách tầng ACP chung từ M2 (như `acp/core.ts` của OMB):
  khai báo theo CLI (binary mặc định, argv vào ACP stdio, login note,
  device sign-in, `isAuthenticated`, `pickAuthMethod`), rồi thêm
  OpenCode (`opencode acp` hoặc `opencode run`/`serve` — xem doc CLI),
  Gemini CLI, Cursor CLI (`cursor-agent` ACP), Cline/Copilot nếu có.
  Cho phép **custom ACP**: user trỏ tới bất kỳ CLI nào nói ACP
  (`config.cli` là toàn bộ lệnh), "sign in first" rồi spawn giữ nguyên
  login; Re-detect model trong picker.
- **Chạm:** `packages/core/src/providers/cli/acp/` (core + khai báo
  từng CLI); UI Engines thêm "Set CLI…" + Re-detect.
- **Ước lượng:** ~4.000–6.000 dòng nguồn / 25–35 file (kèm ~3.000 dòng
  test). Tham chiếu OMB: `acp/core.ts` 1.731 + các driver con 47–560
  dòng mỗi cái.
- **Xác minh:** thêm một CLI ACP giả (fake binary nói ACP tối thiểu)
  qua custom ACP và chạy được turn; mỗi CLI thật có ít nhất detector +
  turn mẫu chạy được; CLI lạ/chưa cài chỉ hiện "unavailable" kèm lý do,
  không crash app.

### M4 — Model picker + provider rail + engine status UI

- **Làm gì:** Rail provider 3 nhóm (subscription / api / custom);
  instance unavailable thì mờ + lý do; đổi model giữa chừng không mất
  thread; Re-detect; màn hình Settings → Engines (cài đặt, tài khoản,
  kiểm tra sống, mức dùng, trạng thái chưa có engine nào); hiển thị rõ
  **model đang chạy qua tài khoản nào** (nhãn email/tổ chức/phương thức,
  không token) trong chat và picker.
- **Chạm:** `apps/desktop/src` (ModelPicker, EngineSettings, rail);
  `packages/core/src/models/` (catalog + snapshot trạng thái).
- **Ước lượng:** ~3.000–5.000 dòng nguồn / 20–30 file (kèm ~1.500 dòng
  test UI). Tham chiếu OMB: `src/lib/engine-rail.ts` + `ModelPicker*.tsx`
  + `EnginesSettings.tsx` + `EngineAccounts.tsx` (trong tổng 138k dòng
  UI của OMB — mốc này chỉ lấy phần rail/picker, không cả UI).
- **Xác minh:** test UI với snapshot giả (available/unavailable/đang
  chờ model); trên máy thật: tắt một CLI thì rail mờ đúng dòng + đúng
  lý do; đổi model giữa chừng giữ nguyên thread.

### M5 — Harness local chuẩn hoá (registry + event bus + NDJSON log)

- **Làm gì:** Tách tầng harness riêng khỏi daemon/coordinator hiện có:
  registry instance → process sống, event bus fan-in (mọi driver dịch
  về một event chuẩn, UI chỉ gộp một SSE stream), log NDJSON theo
  thread, snapshot trạng thái engine ghi atomic ra file, permission
  broker (yêu cầu quyền của CLI chạy ngược về harness để user duyệt).
- **Chạm:** mới `packages/core/src/harness/`; nối `local-exec-daemon`,
  `node-agent-coordinator`, Local API/WS hiện có.
- **Ước lượng:** ~3.000–4.500 dòng nguồn / 20–30 file (kèm ~2.500 dòng
  test). Tham chiếu OMB: `server/harness/` 1.532 dòng nguồn +
  `server/procs.ts` 462 dòng + `server/index.ts`/routes.
- **Xác minh:** 2 driver khác nhau cùng chạy, UI nhận đúng một stream
  event chuẩn; kill harness không mất log thread (đọc lại NDJSON);
  permission request từ CLI hiện thành approval và dừng turn khi chưa
  duyệt.

### M6 — Bot box / sandbox theo turn + egress gate (local)

- **Làm gì:** Sandbox cho từng turn của bot chạy qua CLI local: chạy
  CLI trong môi trường giới hạn (Linux: bubblewrap kiểu OMB hoặc
  namespace tối thiểu; macOS/Windows: cơ chế tương đương ở mức có thể),
  env allow-list (chặn biến nhạy cảm của open-bot), thư mục làm việc
  riêng, đồng bộ sign-in an toàn (§4.7: settled 2s, ghi nguyên tử,
  0600/0700), egress gate (proxy HTTP local, chỉ cho địa chỉ public).
  Bắt đầu với **local VM/sandbox nhẹ** trước, cloud desktop để sau.
- **Chạm:** mới `packages/core/src/sandbox/` (box, egress gate, env
  allow-list, sign-in sync); nối `packages/core/src/egress/` hiện có,
  `local-exec-daemon`, Vault.
- **Ước lượng:** ~6.000–9.000 dòng nguồn / 35–50 file (kèm ~4.000 dòng
  test). Tham chiếu OMB: file boat/box/local-vm/cloud 212 file /
  43.245 dòng (kèm test) — mốc này chỉ lấy phần local, không lấy Boat.
- **Xác minh:** test xâm nhập nhẹ (bot trong box không đọc được file
  ngoài workspace, không gọi được địa chỉ local/metadata, không thấy
  biến env của open-bot); sign-in refresh trong box về đúng file team;
  test trên Linux + macOS.

### M7 — Lớp "connected apps" thống nhất (kiểu Composio)

- **Làm gì:** Một lớp app integrations duy nhất thay cho các tool rời
  rạc hiện tại: catalog app, OAuth một lần rồi chia sẻ cho mọi bot,
  trạng thái auth rõ ràng (available/unavailable + lý do), giới hạn số
  tool của connector. Đánh giá 2 phương án: (a) tự làm trên MCP
  (khuyến nghị trước — không phụ thuộc bên thứ ba), (b) tích hợp
  Composio (cần key/dịch vụ ngoài). Mốc này chỉ làm (a) + thiết kế để
  cắm (b) sau.
- **Chạm:** mới `packages/core/src/apps/` (catalog, auth, broker);
  gom tool Slack/Teams/email/iMessage/meeting hiện có vào lớp này;
  UI màn hình Connected apps.
- **Ước lượng:** ~4.000–6.000 dòng nguồn / 25–35 file (kèm ~2.500 dòng
  test). Tham chiếu OMB: `server/composio.ts` 1.091 dòng + các file
  `composio-*` + `shared/connector-*`.
- **Xác minh:** OAuth một app rồi 2 bot cùng dùng được; thu hồi auth
  thì cả hai bot cùng báo unavailable kèm lý do; tool của app bị giới
  hạn đúng số lượng đã đặt.

### M8 — Approval card trong chat + group chat bot-bot + headless CLI

- **Làm gì (sau M1–M7):** Thẻ Allow/Deny + question card trong chat
  (thay cho dialog approval hiện tại); mức approval theo từng bot,
  pass-through permission mode của provider; quy tắc "bot đọc file của
  chính nó không bao giờ hỏi"; group chat giữa các bot (@mentions,
  delegation); headless CLI (`open-bot team apply/run --export --json`).
- **Chạm:** `apps/desktop/src` (ApprovalCard, GroupView…),
  `packages/core/src/approval/` + `packages/core/src/subagents/`,
  mới `apps/cli/` (headless).
- **Ước lượng:** ~5.000–8.000 dòng nguồn / 30–45 file (kèm ~3.000 dòng
  test). Tham chiếu OMB: `src/components/ApprovalCard.tsx`,
  `CallSheet.tsx`, `GroupView.tsx`, `docs/approval-levels.md`,
  `docs/headless-cli.md`.
- **Xác minh:** approval từ card và từ dialog cho cùng kết quả; bot
  đọc file của mình không hỏi, đọc file ngoài thì hỏi; group chat 2 bot
  giao việc cho nhau; headless CLI chạy xong trả exit code đúng.

**Tổng ước lượng M1–M8:** ~34.000–52.000 dòng nguồn mới (+ ~24.000 dòng
test), tức đưa open-bot từ ~85k lên ~120–137k dòng nguồn. Vẫn còn cách
OMB (~450k) một quãng — đúng như Huy nói, đây là đường dài; các mốc
tiếp theo (UI toàn diện, cloud desktop, TTS, teams/portable format)
sẽ nối sau khi M1–M8 xanh.

## 14. Giới hạn & chưa xác minh

- **Chưa chạy OpenMausBot thật:** mọi kết luận về hành vi chạy (spawn,
  streaming, approval, resume) đều từ đọc code/docs, chưa kiểm chứng
  bằng máy có CLI thật đăng nhập. Đặc biệt: chi tiết spawn của Claude
  (`--input-format stream-json` + stdin mở suốt turn) và Codex
  (app-server) cần kiểm chứng trên máy thật trước khi viết driver.
- **Chưa đọc hết code:** chỉ đọc kỹ các file nêu tên; phần lớn
  `server/routes/`, `server/host/`, `src/` (138k dòng UI) chỉ suy ra từ
  tên file/cấu trúc. Số dòng "theo tên file" cho VM (§2.2) gồm cả test.
- **Số dòng là gần đúng:** đo trên bản sparse-checkout (thiếu
  `scripts/` 316 file và vài thư mục phụ); `docs/` đo 251 file `.md`
  trong tổng 1.147 file của cây (phần còn lại là ảnh/tài sản).
- **Version trôi nhanh:** OpenMausBot release gần như hằng ngày (bản
  0.1.x), CLI `grok`/`claude`/`codex` đổi cờ thường xuyên; mọi tên cờ
  trong doc này cần kiểm tra lại bằng `--help` trên máy thật khi làm
  mốc.
- **Không áp dụng nguyên si phần cloud:** Boat (cloud desktop) và
  Composio là dịch vụ bên thứ ba có tài trợ/quan hệ riêng; open-bot
  không tự có được bằng cách đọc code — cần quyết định đối tác hoặc
  phương án thay thế ở mốc tương ứng.
- **Grok CLI:** trong cây OMB có cả driver API (`grok.ts`) và driver
  CLI ACP (`acp/grok.ts`); README/blog nói "grok CLI" nhưng không nêu
  rõ lúc nào dùng cái nào — suy đoán: CLI khi user có subscription
  grok.com, API khi user có key xAI. Cần xác minh khi làm M2.

## Nguồn

- Repo: https://github.com/milind-soni/OpenMausBot (commit `1de1164`,
  2026-11-09; Apache 2.0) — clone đọc tại
  `~/workspace/.research-clones/openmausbot` (không commit vào open-bot).
- Blog so sánh: https://www.openmausbot.com/blog/grok-bot-vs-openmausbot
  (cập nhật 2026-11-08).
- Các file OMB dẫn trong doc: `README.md`, `server/drivers/claude.ts`,
  `server/drivers/codex.ts`, `server/drivers/grok.ts`,
  `server/drivers/acp/core.ts`, `server/drivers/acp/grok.ts`,
  `server/drivers/acp/version-probe.ts`,
  `server/drivers/claude-auth-status.ts`,
  `server/drivers/codex-identity.ts`,
  `server/drivers/claude-keepwarm.ts`, `server/procs.ts`,
  `server/harness/registry.ts`, `server/harness/bus.ts`,
  `server/harness/engine-status-file.ts`,
  `server/engine-homes/sign-ins.ts`, `server/engine-homes/engine-homes.ts`,
  `server/model-catalog/catalog.ts`, `server/composio.ts`,
  `server/boat.ts`, `docs/bot-box.md`, `docs/approval-levels.md`,
  `docs/custom-engines.md`, `docs/headless-cli.md`, `docs/mcp-server.md`,
  `src/lib/engine-rail.ts`, `src/components/ModelPicker.tsx`,
  `src/components/ApprovalCard.tsx`.
- Đối chiếu open-bot: `docs/GROK-BOT-ANALYSIS.md`,
  `docs/rea-grokbot-deep-dive.md`, `MEMORY.md` (v0.37–v0.38), đo trực
  tiếp trên `~/workspace/open-bot` ngày 2026-11-09.
