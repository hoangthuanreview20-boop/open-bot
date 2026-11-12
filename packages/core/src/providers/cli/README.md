# CLI providers — M1 (driver Claude Code đầu tiên) + M2 (Codex, Grok CLI) + M3 (tầng ACP chung, OpenCode, Gemini CLI, Cursor CLI, Custom ACP) + sóng B (driver Aider / Continue / Amazon Q / Copilot CLI / Windsurf)

Driver cho các CLI agent trên máy user. M1 chỉ có **Claude Code**;
M2 thêm **Codex** (app-server JSON-RPC) và **Grok CLI** (ACP).
M3 tách tầng ACP chung từ M2 và thêm **OpenCode**, **Gemini CLI**,
**Cursor CLI** (cùng nói ACP) + **Custom ACP CLI** (user tự trỏ tới
bất kỳ CLI nào nói ACP). Transport JSON-RPC NDJSON dùng chung nằm ở
`jsonRpc.ts`; ACP client chung nằm ở `acp.ts`; vòng đời ACP chung
(spawn → initialize → session → prompt → kill process group) nằm ở
`acpProvider.ts` (`BaseAcpCliProvider`) — driver riêng chỉ còn khai
báo lệnh spawn + env (+ `authenticate` nếu có).

## Cơ chế driver Claude Code

```
chat() → spawn `claude --output-format stream-json
              --input-format stream-json --verbose
              --permission-mode default
              [--append-system-prompt <system>]`
       → gửi user message mới qua stdin (NDJSON, một dòng một message)
       → đọc stdout NDJSON → event chuẩn (text/tool_call/result/error)
       → giữ process sống cho turn sau (một process mỗi provider
         instance = mỗi bot); dispose() kill cả process group.
```

- **CLI sở hữu vòng tool của nó**: Claude Code tự chạy tool của nó;
  `chat()` trả `toolCalls: []` — open-bot không thực thi lại call của
  CLI. Tool call của CLI chỉ surface qua callback `onCliEvent`.
- **Chỉ gửi message mới** (delta): process giữ context thread; history
  bị viết lại (compaction) hoặc system prompt đổi → restart process và
  gửi lại toàn bộ.
- **Env tối thiểu** (`env.ts`): allowlist tên biến + biến auth riêng của
  CLI (`CLAUDE_CODE_OAUTH_TOKEN`); mọi biến secret khác (kể cả
  `XAI_API_KEY`, `OPENAI_API_KEY`…) đều bị chặn khỏi env của turn.
- **Kill cả process group** khi abort/timeout/dispose (POSIX: kill
  `-pid`; Windows: `taskkill /PID /T /F`).

## Giới hạn CHƯA KIỂM CHỨNG (bắt buộc đọc trước khi coi M1 là xong)

Trên máy phát triển M1 **không có Claude Code đăng nhập thật**, nên
driver mới chỉ được kiểm chứng bằng **fake CLI** (xem
`tests/fixtures/fake-claude.mjs` + `tests/detected-cli-m1.test.mjs`).
Chưa kiểm chứng trên máy thật:

1. **Shape stream-json thật**: các event `system`/`assistant`/`result`
   (kèm `usage`, `session_id`) theo docs Anthropic + code OpenMausBot —
   parser đã viết phòng thủ, nhưng CLI thật có thể trả thêm field hoặc
   event lạ.
2. **Hành vi `--permission-mode default` khi tool cần duyệt** trong chế
   độ headless: M1 chưa có kênh trả lời permission request của CLI —
   turn có tool cần duyệt sẽ treo tới timeout rồi bị kill. Đây là
   follow-up (permission broker, mốc M5). **Không dùng
   `--dangerously-skip-permissions`/`bypassPermissions` làm mặc định.**
3. **`--append-system-prompt`** và việc giữ process sống nhiều turn
   (stdin mở suốt) — cần chạy thật nhiều turn liên tiếp để khẳng định.
4. **Windows/macOS** chưa chạy thật (chỉ Linux).

Follow-up bắt buộc: chạy một bot `claude-code` trên máy thật có Claude
Code đăng nhập — một turn chỉ trả lời text, một turn dùng tool của CLI
(đọc file), rồi kiểm tra: text về đúng, process sống qua 2 turn, abort
giữa turn kill sạch process, tắt nguồn trong Settings → Engines thì
provider biến mất khỏi picker.

## M2 — Driver Codex (app-server JSON-RPC) + driver Grok CLI (ACP)

### Codex (`codex.ts` + `codexAppServer.ts`)

```
chat() → spawn `codex app-server` (1 process sống/bot)
       → initialize {clientInfo:{name:'open-bot',version}}
       → thread/start {cwd, approvalPolicy:'on-request',
                       baseInstructions:<system>}
         (hoặc thread/resume {threadId} khi process cũ chết)
       → turn/start {threadId, input:[{type:'text',text}]}
       → notification item/agentMessage/delta (text),
         thread/tokenUsage/updated (usage.last),
         turn/completed {turn:{error?, items}} → kết thúc turn
```

- **Approval = từ chối fail-closed.** Server xin duyệt
  (`execCommandApproval` / `applyPatchApproval` /
  `item/commandExecution/requestApproval` /
  `item/fileChange/requestApproval` / `item/permissions/requestApproval`)
  thì client trả đúng shape deny theo schema thật của CLI
  (`{decision:{denied:{rejection}}}` hoặc `{decision:'decline'}`),
  request khác thì trả JSON-RPC error. KHÔNG approve, KHÔNG bypass.
  Chưa có permission broker (mốc M5).
- **Resume = thread id.** System prompt đổi / history viết lại → mở
  thread MỚI trên cùng process (không restart process — app-server
  chứa nhiều thread). Process chết → giữ thread id, lần sau thử
  `thread/resume`; resume lỗi thì mở thread mới + gửi lại history.
- **Model:** không truyền model vào `thread/start` (model id `codex`
  chỉ là placeholder; Codex dùng model mặc định của nó).
- **Env:** chỉ allowlist + `CODEX_HOME` (đường dẫn, không phải secret).

#### Đã KIỂM CHỨNG (Codex — khác Grok, đọc kỹ)

Bằng chính CLI thật trên máy phát triển (**codex 0.164.0-alpha.9,
chưa đăng nhập**, 2026-11-09):

1. `codex app-server generate-json-schema --out <dir>` sinh schema
   JSON của toàn bộ protocol (105 client request, 10 server request,
   85 server notification) — mọi tên method/param/shape deny trong
   `codexAppServer.ts` lấy từ schema này.
2. Probe live `initialize` → trả `{userAgent, codexHome,
   platformFamily, platformOs}`; `thread/start`
   `{cwd, approvalPolicy:'on-request'}` → trả `result.thread.id`
   (UUIDv7) + notification `thread/started`, KHÔNG cần đăng nhập.
3. Probe live `thread/resume` cho thread vừa tạo bởi process khác →
   lỗi JSON-RPC `-32600 "no rollout found for thread id …"` (rollout
   chưa kịp ghi đĩa khi process cũ thoát) — driver fallback sang
   `thread/start` + gửi lại history chính vì hành vi này.

#### Chưa KIỂM CHỨNG (Codex)

- `turn/start` + streaming delta + `turn/completed` + approval khi
  turn thật cần duyệt trên máy có Codex đăng nhập (tên method/param
  đã khớp schema sinh từ CLI thật, nhưng chưa thấy server thật gửi).
- `thread/resume` thành công sau khi process chết (probe live trên
  chỉ thấy resume LỖI; đường resume-thành-công mới chỉ kiểm chứng
  bằng fake).

### Grok CLI (`grok.ts` + `acp.ts`)

```
chat() → spawn `grok --permission-mode default agent stdio`
         (--permission-mode là cờ global, đặt TRƯỚC `agent`;
          `-m` không truyền — model id `grok-cli` chỉ là placeholder)
       → ACP initialize {protocolVersion:1, clientCapabilities,
                         clientInfo}
       → session/new {cwd} (hoặc session/load {sessionId} để resume)
       → session/prompt {sessionId, prompt:[{type:'text',text}]}
       → notification session/update (agent_message_chunk,
         tool_call, usage_update) rồi response {stopReason}
         → kết thúc turn
```

- **Mượn login grok.com, không dùng API key.** Đăng nhập kiểm tra
  bằng sự TỒN TẠI của `~/.grok/auth.json` (detector M1 — chỉ kiểm
  tra tồn tại, không đọc nội dung). **Env của turn KHÔNG bao giờ
  chứa `XAI_API_KEY`** (rò rỉ key sẽ âm thầm chuyển subscription
  grok.com sang pay-as-you-go); chỉ allowlist + `GROK_HOME`.
- **Approval = từ chối fail-closed:** `session/request_permission`
  → chọn option `reject_once` (không có thì `reject_always`, không
  nữa thì `{outcome:{outcome:'cancelled'}}`). Các request khác từ
  server (`fs/read_text_file`, `fs/write_text_file`, terminal…) →
  JSON-RPC error -32601.
- **System prompt:** ACP `session/new` không có slot cho system
  prompt nên system prompt được GỘP vào user message đầu tiên của
  session mới (`"<system>\n\n<message>"`).
- **Resume = session id** (`session/load`; lỗi thì mở session mới +
  gửi lại history). ACP client chung (`acp.ts`) để M3 tái dùng.

#### Chưa KIỂM CHỨNG (Grok — toàn bộ)

Máy này **KHÔNG có `grok`** nên driver Grok CHƯA chạy lần nào trên
Grok CLI thật: lệnh spawn, handshake ACP, `session/new`/`load`/
`prompt`, `session/update`, `session/request_permission` đều mới chỉ
khớp ACP chuẩn + docs/code công khai (OpenMausBot đã kiểm chứng với
grok 1.0.0/1.0.25/1.0.41). Cần chạy thật trên máy có Grok đăng nhập
trước khi coi M2 là xong: một turn text, một turn dùng tool của CLI,
resume sau khi process chết, approval khi tool cần duyệt (phải thấy
`approval_denied`, turn tiếp tục), `XAI_API_KEY` không lọt vào env.

### Detector Codex cho app-server (M2)

Detector M1 (binary + `codex --version` + `codex login status`) là
ĐỦ cho app-server, không cần detector mới: app-server là subcommand
của cùng binary (đã kiểm chứng live `codex app-server --help` exit 0
trên 0.164.0-alpha.9; fake-codex cũng trả exit 0 cho lệnh này và test
M2 assert điều đó). Nếu một bản Codex quá cũ không có app-server thì
`initialize` sẽ lỗi và driver báo rõ + kill process (không để process
mồ côi). Tương tự, detector Grok M1 (binary + `~/.grok/auth.json` tồn
tại) là đủ — Grok không có lệnh status.

## M3 — Tầng ACP chung + driver OpenCode / Gemini CLI / Cursor CLI / Custom ACP

### Tầng chung (`acp.ts` + `acpProvider.ts`)

`AcpClient` (M2) giữ nguyên vai trò protocol: `initialize`,
`authenticate` (mới ở M3, tuỳ chọn), `session/new`/`load`,
`session/prompt` (kết thúc bằng response `{stopReason}`),
`session/request_permission` → chọn `reject_once` fail-closed,
mọi request khác từ server → lỗi -32601.

`BaseAcpCliProvider` (mới, `acpProvider.ts`) là toàn bộ vòng đời
từng nằm trong `grok.ts` M2, nay dùng chung: spawn thử từng bộ
`acpArgs` theo thứ tự cho tới khi `initialize` thành công (mỗi lần
thử lỗi đều kill sạch process), session delta/system gộp/resume
bằng session id, timeout/abort/dispose kill cả process group, env
dọn sạch secret lạ. `grok.ts` trở thành driver mỏng (chỉ khai báo
lệnh spawn + `GROK_HOME`) — hành vi M2 không đổi, test M2 vẫn xanh.

### OpenCode (`opencode.ts`, ACP `opencode acp`)

Lệnh spawn theo docs OpenCode công khai (opencode.ai/docs/cli/acp):
`opencode acp` chạy OpenCode thành ACP agent trên stdio (JSON-RPC
NDJSON, protocol version 1). Detector M1 đã đủ: binary +
`--version` + `opencode auth list` (liệt kê provider đã lưu, không
in secret; OpenCode 2 giữ credential trong store riêng nên detector
KHÔNG dựa vào file `auth.json`). Không truyền model (model id
`opencode` chỉ là placeholder); env chỉ allowlist chung, không thêm
biến riêng. OpenCode là multi-provider — nhãn tài khoản trong
snapshot là tên các provider bên trong nó.

### Gemini CLI (`geminiCli.ts`, ACP `gemini --acp`)

Lệnh spawn theo docs Gemini CLI công khai
(geminicli.com/docs/cli/acp-mode): `gemini --acp` (Gemini CLI là
implementation tham chiếu đầu tiên của ACP, cùng Zed xây dựng).
**Cờ ACP có 2 đời:** bản hiện tại `--acp`, bản cũ
`--experimental-acp` — driver thử `--acp` trước, `initialize` lỗi
thì thử `--experimental-acp` rồi mới báo lỗi. Detector M1 đã đủ:
nhãn từ `google_accounts.json` (chỉ email), `oauth_creds.json`
(chứa token) chỉ kiểm tra TỒN TẠI, không bao giờ đọc nội dung.
Env: allowlist + `GEMINI_CLI_HOME` (đường dẫn, không phải secret);
`GEMINI_API_KEY` KHÔNG bao giờ được truyền.

### Cursor CLI (`cursorCli.ts`, ACP `cursor-agent acp`)

Lệnh spawn theo docs Cursor công khai (cursor.com/docs/cli/acp):
`agent acp` / `cursor-agent acp` chạy Cursor CLI thành ACP server
trên stdio. **Cursor nói ACP chuẩn — đã xác nhận từ docs chính thức
của Cursor** (không phải suy đoán): transport stdio, JSON-RPC 2.0,
newline-delimited, flow gồm `authenticate` với methodId
`cursor_login`. Driver gọi `authenticate('cursor_login')` sau
`initialize`; lỗi ở bước này chỉ cảnh báo rồi tiếp tục —
`session/new` sẽ lỗi rõ nếu thật sự chưa đăng nhập. Detector M1 đã
đủ: binary + `cursor-agent status --format json`. Không truyền model
(docs ghi `cursor-agent acp --model <model>` có thể pin model, M3
chưa dùng — để M4 lo model picker sâu hơn). Env chỉ allowlist chung
(login Cursor nằm ở keychain hệ điều hành).

### Custom ACP CLI (`customAcp.ts` + `detected/custom.ts`)

User trỏ tới bất kỳ CLI nào nói ACP trong Settings → Engines
("Set CLI…"): tên hiển thị + đường dẫn tuyệt đối tới binary + lệnh
spawn ACP (argv, vd `acp` hay `--acp`) + (tuỳ chọn) lệnh kiểm tra
đăng nhập. Cấu hình lưu bền vững trong `detected-engines.json`
(cùng file opt-in, ghi atomic, chỉ đường dẫn + argv — không secret:
argv chứa cờ `--api-key`/`--token`/`--auth-token` bị từ chối lúc
thêm). Registry đăng ký một detector cho mỗi CLI tuỳ chỉnh với kind
`custom-acp:<slug>` (slug chỉ chữ thường/số/gạch nối, tối đa 32 ký
tự): binary lấy thẳng theo đường dẫn tuyệt đối (không tìm trên
PATH), probe version bằng `--version`.

- Không có lệnh kiểm tra đăng nhập → trạng thái detect là
  **'unknown'** (không rõ đăng nhập — không bịa là đã đăng nhập);
  provider vẫn dùng được khi user bật nguồn (user tự chịu trách
  nhiệm về login của CLI tuỳ chỉnh), lỗi auth (nếu có) hiện rõ khi
  chạy bot. Có lệnh status → exit 0 = available, khác 0 =
  not-signed-in.
- Provider id duy nhất là `custom-acp`; bot nào dùng CLI nào phân
  biệt bằng **model = slug** (vd model `my-agent`). BotForm cho
  chọn CLI tuỳ chỉnh từ danh sách engine đã detect thay vì gõ tay.
- Custom CLI không có `authenticate` mặc định: CLI nào bắt buộc
  bước ACP `authenticate` riêng thì `session/new` sẽ lỗi rõ (M3
  chưa hỗ trợ khai báo methodId cho CLI tuỳ chỉnh).

### Re-detect → picker (M3)

Main process đẩy snapshot mới về renderer qua event IPC
`engines:changed` sau mỗi lần Re-detect, bật/tắt nguồn, hoặc
thêm/sửa/xoá CLI tuỳ chỉnh. BotForm subscribe event này (cộng với
lần tải đầu khi mở form) nên provider vừa available thì hiện, vừa
unavailable thì biến mất mà không cần mở lại form; provider đang
chọn khi sửa bot vẫn được giữ (hành vi M1). SettingsView cũng
subscribe event này để danh sách Engines tự cập nhật.

#### Đã KIỂM CHỨNG (M3, bằng fake — xem tests/detected-cli-m3.test.mjs)

36 test mới (`tests/detected-cli-m3.test.mjs` +
`tests/fixtures/fake-acp-generic.mjs` — một fake đóng vai mọi CLI
ACP theo tên binary): handshake ACP chung (protocolVersion,
agentInfo), prompt streaming + usage, permission reject chọn đúng
`opt-reject`, fs request → -32601, `authenticate` gửi đúng
methodId, `loadSession` lỗi → throw cho caller fallback; từng
driver (spawn đúng argv + turn text + usage, delta 2 turn, system
gộp vào message đầu session, system đổi → session mới, resume sau
khi process chết, load lỗi → session mới + gửi lại history, abort
kill sạch process group theo pid thật, env không chứa key lạ,
refusal không text → lỗi rõ); Gemini fallback `--acp` →
`--experimental-acp` (fake từ chối `--acp` ở `initialize`); Cursor
`authenticate:cursor_login` sau initialize; Grok mỏng hoá hồi quy
(turn + `grokSessionId` như M2); custom CLI (validate slug/binary/
argv/cờ key, thêm → 'unknown', có lệnh status → available,
sửa/xoá/bền vững qua registry mới, provider chat với model = slug,
`createProvider` thiếu `cliBinary`/`cliArgs` thì throw); nối
registry (PROVIDERS meta + ModelRegistry 4 provider mới); Re-detect
→ picker ở tầng core (bật/tắt/xoá binary/thêm-xoá custom đổi
`isEngineUsable` đúng). Test M2 Grok vẫn xanh không đổi sau khi
mỏng hoá (test M1+M2+M3+i18n+models: 126/126 pass).

#### Chưa KIỂM CHỨNG (M3 — toàn bộ, đọc kỹ)

Máy này **KHÔNG có `opencode` / `gemini` / `cursor-agent` /
`grok` thật**, nên chưa driver nào trong M3 chạy lần nào trên CLI
thật:

1. **OpenCode:** lệnh spawn `opencode acp`, handshake ACP,
   `session/new`/`load`/`prompt`, `session/update`,
   `session/request_permission` mới chỉ khớp ACP chuẩn + docs
   OpenCode công khai. Cần chạy thật trên máy có OpenCode đăng nhập
   (1 turn text, 1 turn dùng tool của CLI, resume sau khi process
   chết, approval phải thấy `approval_denied` rồi turn tiếp tục).
2. **Gemini CLI:** như OpenCode, cộng thêm fallback
   `--experimental-acp` (chưa biết bản Gemini CLI nào còn cần cờ
   cũ — có thể không bản nào còn cần, hoặc ngược lại bản mới đã bỏ
   cờ cũ; chỉ chạy thật mới biết). Lưu ý: Gemini CLI từng là
   implementation tham chiếu của ACP nên khớp chuẩn là kỳ vọng tốt,
   nhưng shape `usage_update` và hành vi tool-approval của bản thật
   vẫn chưa thấy.
3. **Cursor CLI:** `cursor-agent acp` + `authenticate`
   (`cursor_login`) đã xác nhận từ docs chính thức của Cursor, nhưng
   chưa chạy thật: chưa biết `authenticate` có bắt buộc không (driver
   đang cảnh báo rồi tiếp tục khi lỗi), chưa biết `session/new` có
   cần thêm param riêng của Cursor không, và **chưa biết turn
   headless có chạy được bằng login không hay bắt buộc API key thật**
   (tài liệu tích hợp độc lập cảnh báo `cursor-agent login` có thể
   không xác thực được turn headless — nếu đúng thì driver sẽ lỗi
   auth rõ ràng, user phải tự quyết định có dùng key hay không; M3
   KHÔNG tự truyền `CURSOR_API_KEY`).
4. **Custom ACP CLI:** chỉ kiểm chứng bằng fake ACP chuẩn — CLI
   thật nào lệch chuẩn (cờ spawn khác, cần `authenticate` riêng,
   shape `usage_update` lạ) sẽ lỗi rõ ở `initialize`/`session/new`
   chứ không được đoán.
5. **Re-detect → picker ở UI thật:** đường core (registry +
   helper visibility + event `engines:changed`) đã có test, nhưng
   chưa chạy Electron thật để bấm Re-detect trong Settings rồi xem
   BotForm cập nhật (BotForm subscribe event + tải lúc mở form).
   Chưa chạy trên Windows/macOS (chỉ Linux).

## Sóng B (M4) — Driver Aider / Continue / Amazon Q / Copilot CLI / Windsurf

5 CLI Team B mới chỉ làm detector nay có driver
(`tests/detected-cli-b-drivers.test.mjs`, 14 test bằng fake CLI).
Hai họ driver khác nhau — đọc kỹ trước khi dùng:

### One-shot text (`oneShot.ts` + `aider.ts` / `continueCli.ts` / `amazonQ.ts`)

```text
chat() → spawn MỚI mỗi turn: <binary> <cờ non-interactive> "<prompt>"
       → đọc stdout text (strip ANSI) tới khi process thoát
       → exit 0 + có text = kết quả; exit != 0 / rỗng / timeout = lỗi rõ
```

- **Stateless:** mỗi turn gửi TOÀN BỘ hội thoại (system + tất cả
  user/assistant message, `renderOneShotPrompt`) vì CLI one-shot
  không giữ session. Đắt token hơn session sống nhưng luôn đúng
  context.
- **Aider** — `aider --message "<prompt>" --yes-always
  --no-auto-commits --no-pretty`. `--yes-always` là cờ unattended
  của Aider (và theo AgenticBench AID-1, nó CỐ TÌNH từ chối shell
  command); `--no-auto-commits` tắt commit tự động mỗi lần sửa
  file; stdin giữ mở suốt turn để EOF không bị hiểu là "yes" cho
  prompt chạy shell (cùng AgenticBench AID-1). Auth = API key của
  user: đúng 7 tên biến key (cùng danh sách detector) được phép chui
  qua env. Usage best-effort từ dòng `Tokens: … sent, … received`.
- **Continue CLI** — `cn -p "<prompt>"` (**EXPERIMENTAL**: cờ `-p`
  không có trong docs chính thức còn lại của Continue mà chỉ được
  wrapper bên thứ ba xác nhận; bản cuối 1.5.47, repo chỉ còn đọc sau
  khi Cursor mua lại 6/2026). Không truyền `--allow` cho tool nào.
  Auth = key trong `~/.continue/config.yaml`; `ANTHROPIC_API_KEY`
  được phép chui qua env (khi không có terminal `cn` đọc biến này).
- **Amazon Q CLI** — `q chat --no-interactive --input "<prompt>"`
  (theo source mở `ChatArgs`). KHÔNG truyền `--trust-all-tools`:
  ở chế độ non-interactive, tool cần duyệt thì CLI lỗi thay vì hỏi
  — đúng fail-closed. Chỉ `AWS_PROFILE` được phép chui qua env;
  key AWS tĩnh CLI tự đọc `~/.aws/credentials`. Lưu ý Q CLI đã
  thành Kiro CLI (`kiro-cli`) — driver này vẫn nhắm `q` (đúng binary
  detector tìm); Kiro có detector + driver riêng ở v0.76
  (`kiroCli.ts`, xem dưới).
- **Kiro CLI (v0.76)** — `kiro-cli chat --no-interactive "<prompt>"`
  (prompt là đối số VỊ TRÍ, không có `--input` như Q — theo docs
  chính thức kiro.dev, tra cứu 2026-11-11). KHÔNG truyền
  `--trust-all-tools` / `--trust-tools` (fail-closed như Q); không
  ghim harness `--v2`/`--v3` (headless local mặc định chạy V2 theo
  docs). Chỉ `KIRO_HOME` (đường dẫn, không phải secret) được phép
  chui qua env; `KIRO_API_KEY` KHÔNG bao giờ được truyền (user chỉ
  có API key headless mà chưa `kiro-cli login` thì detector báo chưa
  đăng nhập). Test: `tests/kiro-cli-v076.test.mjs` (11 test bằng
  fake `kiro-cli`). `kiro-cli acp` tồn tại nhưng chưa làm — follow-up
  khi cần session sống.

### ACP (`copilotCli.ts` / `windsurf.ts`, dùng `BaseAcpCliProvider`)

- **GitHub Copilot CLI** — `copilot --acp --stdio` (ACP public
  preview, docs GitHub; bản < 1.0 từ chối `--acp`). KHÔNG truyền
  `--allow-all-tools` / `--yolo` (sẽ vòng qua permission broker).
  Chỉ `COPILOT_PROVIDERS_CONFIG` (đường dẫn file BYOK) được phép
  chui qua env; `COPILOT_PROVIDER_*` chứa key nên không bao giờ
  được truyền. Approval = từ chối fail-closed ở AcpClient.
- **Windsurf** — `devin acp` (**EXPERIMENTAL**). Windsurf đổi tên
  thành Devin Desktop 6/2026; CLI agent nay là Devin CLI (`devin`,
  docs.devin.ai). Detector dò `devin` trước `windsurf` /
  `devin-desktop`; driver TỪ CHỐI binary launcher của editor (không
  có chế độ agent headless đã kiểm chứng) kèm hướng dẫn cài Devin
  CLI. Trạng thái detector là 'unknown' nên main process
  (`providerConfigFor`) chấp nhận cả 'unknown' cho riêng kind này
  khi user đã bật nguồn — như Custom ACP CLI. Không truyền
  `WINDSURF_API_KEY`.

### Đã KIỂM CHỨNG (sóng B, bằng fake — xem tests/detected-cli-b-drivers.test.mjs)

- Turn đơn giản cả 5 driver (text về đúng, usage khi có, `toolCalls:
  []`, session ACP tái dùng qua 2 turn); Copilot approval thấy
  `approval_denied` rồi turn tiếp tục.
- Lỗi exit != 0 (kèm stderr), output rỗng, timeout (kill sạch
  process), abort (AbortError), 2 turn cùng lúc, dispose, không có
  user message — đều lỗi rõ, không treo.
- Env: key riêng của từng CLI chui qua đúng tên đã xét
  (Aider 7 biến, Continue `ANTHROPIC_API_KEY`, Q `AWS_PROFILE`,
  Copilot `COPILOT_PROVIDERS_CONFIG`); biến secret khác
  (`HIDDEN_TOKEN`) bị chặn khỏi env của turn.
- Windsurf: detector dò `devin` trước `windsurf`; constructor từ
  chối binary `windsurf` / `devin-desktop`.

### Chưa KIỂM CHỨNG (sóng B — toàn bộ, đọc kỹ)

Máy này **KHÔNG có `aider` / `cn` / `q` / `copilot` / `devin`
thật**, nên chưa driver nào chạy lần nào trên CLI thật:

1. **Aider:** cờ spawn + dòng `Tokens:` mới chỉ khớp docs công
   khai + cheat sheet đã kiểm chứng trên 0.86.2. Cần chạy thật trên
   máy có Aider + key (1 turn hỏi đáp, 1 turn sửa file để xem
   `--yes-always` + `--no-auto-commits` có đúng như kỳ vọng, 1 turn
   model đề xuất shell command để xem có bị từ chối không).
2. **Continue:** cờ `-p` là điểm yếu nhất — cần chạy thật `cn -p`
   trên máy có Continue CLI 1.5.47 + key để xác nhận cờ tồn tại và
   hành vi khi tool cần duyệt (treo? lỗi? hỏi?). Chưa xác nhận thì
   không bỏ nhãn experimental.
3. **Amazon Q:** cờ `--input` lấy từ source mở (một số bản cũ dùng
   `--prompt`); cần chạy thật `q chat --no-interactive --input` trên
   máy có Q đăng nhập để xác nhận cờ + hành vi fail khi tool cần
   duyệt.
4. **Copilot CLI:** `--acp --stdio` + handshake ACP mới chỉ khớp
   docs GitHub (public preview, có thể đổi). Cần chạy thật trên máy
   có Copilot đăng nhập (1 turn text, 1 turn tool, approval phải
   thấy `approval_denied`).
5. **Windsurf:** `devin acp` mới chỉ khớp docs Devin. Cần chạy thật
   trên máy có Devin CLI đăng nhập. Ngoài ra cần xác nhận trên máy
   chỉ có editor Windsurf (không có `devin`): detector trả
   binaryPath `windsurf` và driver từ chối rõ ràng thay vì chạy sai.
6. **UI thật:** 5 provider đã vào picker/rail (nhóm subscription)
   nhưng chưa chạy Electron thật để bấm chọn bot dùng từng provider
   mới.

## M4 — Model picker + provider rail + engine status UI + đổi model giữa chừng

### Provider rail (`packages/core/src/models/rail.ts`)

`buildProviderRail()` là hàm thuần (không đọc Vault/file/mạng; key chỉ
đi qua callback `hasApiKey` trả boolean) xếp 13 provider thành 3 nhóm:

- **Subscription** — provider CLI đã đăng nhập (`kind: 'cli'`):
  claude-code, codex, grok-cli, opencode, gemini-cli, cursor-cli.
- **API key** — grok, openai, anthropic, gemini, ollama (local, không
  cần key), openai-compatible.
- **Custom** — custom-acp (gộp mọi `custom-acp:<slug>` thành một mục,
  models = các slug còn dùng được) + openai-compatible chưa cấu hình.

Trạng thái mỗi mục: `usable` / `unknown` / `disabled` / `unavailable`,
kèm `reason` rõ ràng (`not-signed-in`, `disabled`, `not-installed`,
`version-too-old`, `version-probe-failed`, `auth-check-failed`,
`no-api-key`, `not-configured`, `unknown-status`). Provider
`unknown` (custom ACP không có lệnh status) **vẫn chọn được** và hiện
"Chưa rõ", không bịa trạng thái. Sắp xếp trong nhóm: usable trước,
rồi unknown, disabled, unavailable; cùng trạng thái thì theo tên.
`sourceLabelText()` chỉ ghép nhãn (tài khoản / "API key (Vault)" /
"Local" / "Custom") — không bao giờ chứa token/secret.

### Đổi model giữa chừng (`coordinator.switchModel`, IPC `bots:switch-model`)

- **Thread/history giữ nguyên.** Loop của open-bot mỗi run chỉ gửi
  system prompt + tin nhắn hiện tại; continuity nằm ở `BotMemory`
  (transcript SQLite trong workspace bot: tin nhắn, task, plan,
  checkpoint) + session riêng của từng driver. `switchModel` chỉ thay
  `entry.provider`/`entry.bot` (providerId + model), **không đụng**
  tools, memory, plan-approved stamps, handoff chains.
- **Đang chạy thì pending.** Nếu `entry.running`, switch được ghi vào
  `pendingModelSwitches` và trả `{applied: false, pending: true,
  running: true}` — run hiện tại chạy hết bằng provider cũ, run kế
  tiếp (đầu `executeRun`) mới swap rồi chạy bằng provider mới. Tool
  call / plan / handoff đang chạy không bị cắt. Một bot chỉ giữ một
  pending switch (switch sau ghi đè switch trước); `destroyBot` huỷ
  pending switch.
- **Provider mới nhận history theo từng loại:**
  - **API (grok/openai/anthropic/gemini/ollama/openai-compatible):**
    stateless theo turn — provider mới không cần resume; history đầy
    đủ vẫn nằm trong `BotMemory` (transcript hiển thị + handoff +
    checkpoint) và được gửi lại theo cơ chế từng driver nếu cần.
  - **Claude Code:** driver giữ 1 process/thread, gửi delta-only
    (`sentUserMessages`). Đổi sang Claude từ provider khác = process
    mới, session mới — transcript cũ KHÔNG tự chảy vào session CLI,
    chỉ nằm trong `BotMemory`; turn mới gửi system prompt + tin nhắn
    hiện tại. Đổi *khỏi* Claude thì process CLI cũ bị dispose (xem
    dưới).
  - **Codex (app-server):** giữ thread id; đổi provider = thread mới
    (resume chỉ dùng trong cùng một driver khi process chết; xem M2).
  - **ACP (Grok CLI / OpenCode / Gemini CLI / Cursor CLI / Custom
    ACP):** giữ session id qua `ensureSession` + `loadSession`; đổi
    provider = session mới trên process mới — transcript cũ chỉ nằm
    trong `BotMemory`, không tự migrate sang session CLI mới.
  - Nói gọn: **đổi provider không làm mất lịch sử trong app, nhưng
    session sống của CLI cũ không chuyển sang provider mới** — provider
    mới bắt đầu phiên CLI mới với turn hiện tại.
- **Fail-closed.** `switchModel` validate trước khi swap: bot phải
  tồn tại, provider id phải biết (`PROVIDERS` hoặc `mock`), model
  không rỗng, CLI phải có `cliBinary`. Swap dựng provider MỚI trước,
  thành công mới dispose provider cũ rồi mới cập nhật entry + lưu
  `BotMemory` — swap lỗi thì bot vẫn chạy bằng provider cũ.
- **Sửa rò rỉ process (bug có sẵn, M4 phát hiện):** `MeteredProvider`
  (bọc mọi provider desktop khi có usage store) trước đây KHÔNG
  forward `dispose()` — `destroyBot`/`shutdown` gọi
  `entry.provider.dispose?.()` là no-op, process CLI bị giữ lại.
  M4 thêm `disposeProvider()` unwrap `MeteredProvider.wrapped`
  trước khi dispose; dùng chung cho `switchModel`, `destroyBot`,
  `shutdown`.
- **Main (desktop):** IPC `bots:switch-model` validate policy + quyền
  team, dựng config qua `providerConfigFor` (fail-closed: engine
  phải bật + available/unknown-cho-custom, key trong Vault), gọi
  `switchModel` TRƯỚC khi lưu settings — swap lỗi thì settings không
  đổi. Bot chưa từng chạy thì chỉ lưu settings, áp dụng khi tạo bot.
- **UI:** `ModelPicker` (3 nhóm rail, mờ + lý do, chọn model khác
  trong provider, tắt/bật từng nguồn, link Settings → Engines),
  header chat hiện nhãn nguồn (`Claude Code · tài khoản …` /
  `OpenAI · API key (Vault)`, không token) + nút "Đổi model",
  `EngineStatusView` trong Settings → Engines (binary, version,
  trạng thái, nhãn tài khoản, lý do, Re-detect từng engine
  `engines:redetect-one` + Re-detect tất cả, opt-in bật/tắt rõ).

#### Đã KIỂM CHỨNG (M4, bằng fake/mock — xem tests/model-picker-m4.test.mjs)

16/16 test: rail (nhóm, mờ + lý do, unknown, sắp xếp, không secret
trong rail — secret giả chỉ sống trong closure boolean của
`hasApiKey`), switchModel (rảnh áp dụng ngay + history giữ nguyên
qua `saveMessage`/`getHistory`, qua RPC `handle('switchModel')`,
validate fail-closed, đang chạy → pending rồi run sau dùng model
mới, pending bị huỷ khi `destroyBot`, đổi claude-code → mock thì
process fake CLI cũ chết kể cả khi bọc `MeteredProvider`),
`redetectOne` (chỉ quét một engine, engine khác giữ nguyên
`detectedAt`; kind lạ throw; detector lỗi → unavailable không throw).

#### Chưa KIỂM CHỨNG (M4 — toàn bộ, đọc kỹ)

1. **Đổi model giữa chừng trên Electron thật:** chưa bấm nút "Đổi
   model" trong chat thật, chưa xem header cập nhật nhãn nguồn, chưa
   xem notice "đã áp dụng / sẽ áp dụng từ turn sau" hiện đúng; chưa
   bấm Re-detect từng engine rồi xem picker cập nhật (chỉ có test
   core + IPC wiring + typecheck). Chưa chạy trên Windows/macOS.
2. **Resume/delta thật của CLI sau switch:** chỉ kiểm chứng bằng
   fake Claude (1 process, delta-only). Chưa có CLI thật nào đăng
   nhập trên máy này, nên chưa biết session CLI mới sau switch có
   hành vi gì khác (vd Claude Code có tự `resume` session cũ nếu
   user quay lại provider cũ trong cùng phiên app không — driver
   hiện tại KHÔNG resume qua switch, mỗi lần tạo provider là
   process/session mới).
3. **Engine status UI thật:** `EngineStatusView` + `ModelPicker`
   mới chỉ qua `tsc` + `vite build` (renderer build xanh); chưa mở
   app thật để xem layout có thoáng/không dày đặc như yêu cầu, chưa
   kiểm tra i18n vi/en hiển thị đúng trên UI (chỉ có test key
   `tests/i18n.test.mjs`).

## M5 — Harness local chuẩn hoá (registry + event bus + permission broker)

Driver nay có thêm 2 móc nối vào harness (`packages/core/src/harness/`):

- `harnessSink` (option) / `attachHarnessSink(sink)` + getter `cliPid`:
  Claude, Codex, `BaseAcpCliProvider` (5 driver ACP con kế thừa qua
  options `harnessSink`) — mỗi `CliEvent` chảy song song về callback
  `onCliEvent` cũ và sink của harness (bus + NDJSON log). Sink lỗi
  không làm hỏng turn.
- `permissionHandler` (option) / `attachPermissionHandler(handler)`:
  Codex + ACP. Không có handler thì driver tự từ chối fail-closed như
  M2/M3. Có handler (broker) thì ACP hỏi broker rồi chọn
  `allow_once` khi user cho phép, `reject_once` khi từ chối; Codex
  vẫn LUÔN deny (`decision: 'decline'` / `{denied: …}`) vì shape trả
  lời "cho phép" chưa xác minh được từ schema thật — broker gọi
  handler với `allowable: false` và ghi log `allow-not-supported`.
  Driver emit thêm event `approval_request` trước khi quyết để bus/log
  thấy request.

Chưa kiểm chứng: broker với CLI thật có đăng nhập (chỉ fake ACP /
fake Codex); Claude Code không có kênh permission (stream-JSON qua
stdin) nên broker không chạm tới driver này.
