# REA Deep Dive — Grok Bot 0.79.3 (đào sâu lần 2)

> **Phạm vi:** Chỉ phân tích tĩnh phục vụ học kiến trúc để thiết kế open-bot.
> **Không** cài đặt, **không** chạy file exe hay bất kỳ binary nào trích ra,
> **không** sao chép code, text, hình ảnh hay tài sản của xAI/Cursor. Mọi nội
> dung dưới đây là mô tả kiến trúc/hành vi bằng lời của người phân tích (tên
> endpoint, tên tính năng, luồng hoạt động ở mức khái niệm, trích tên
> hàm/API tối thiểu đủ để đối chiếu).
>
> Ngày phân tích: 2026-11-09. Người phân tích: subagent REA (wave deep-dive).
> Tài liệu gốc đã có: `docs/GROK-BOT-ANALYSIS.md` (phân tích tĩnh lần 1,
> 2026-11-08, 460 dòng). Tài liệu này **chỉ ghi phần mới / phần lần 1 chưa
> đào tới** và đối chiếu trực tiếp với code open-bot hiện tại (commit
> `23329a7`, v0.35+v0.36). Đọc kèm tài liệu gốc — không lặp lại §1–§9 của nó
> trừ khi cần đính chính (xem §14).

## 0. Mức tin cậy & quy ước nguồn

| Mức | Ý nghĩa |
|---|---|
| **Chắc chắn** | Đọc được literal trong file đã giải nén (tên message, chuỗi, hằng số, field descriptor protobuf). |
| **Suy đoán từ tên** | Tên hàm/message minify gợi ý vai trò, chưa thấy logic bên trong. |
| **Chưa xác minh** | Cần chạy thật / traffic thật mới khẳng định được (ngoài phạm vi tĩnh). |

Mọi phát hiện ghi rõ nguồn dạng `asar-src/<đường dẫn>` (thư mục
`~/tools/grokbot/asar-src/`) hoặc URL docs công khai. Tên file nguồn chính:

- `dist/electron-main/proto.cjs` — định nghĩa service/message/tool dạng
  protobuf-es (field descriptor kiểu `"Msg|1 field #type|2 …"`, xem §2).
- `dist/electron-main/main-app.cjs` (~3,5 MB) — logic main process (đã minify).
- `dist/electron-main/main-core.cjs` (~1,2 MB) — boot, update, experiment.
- `dist/electron-preload/preload.cjs` + 5 preload chuyên biệt.
- `dist/local-exec-daemon/main.cjs` + `messages-worker.cjs`.
- `dist/node-agent-coordinator/main.cjs`.
- `dist/renderer/assets/*.js` — React app (chunk `index.eager-app-*`,
  `chunk-chat-*`, `chunk-core-*`, …).

## 1. Xác minh công cụ (tool health)

- `rea doctor` (sau `source ~/.bashrc`): **healthy: true**,
  `environment_healthy: true` — ghidra 12.1.4, jadx 0.7.1, kuna 1.990 đều
  OK; hopper/IDA thiếu (trả phí, theo yêu cầu chỉ dùng tool miễn phí).
  Lần chạy đầu trong shell non-login báo `healthy: false` vì `~/.bashrc`
  chưa được source (biến `GHIDRA_INSTALL_DIR`, `REA_JADX_MCP_JAR`,
  `REA_KUNA_COMMAND` nằm trong `~/.bashrc`/`~/.profile`).
- **VM bị thay mới giữa chừng (lần 3):** trong lúc làm task này,
  `/usr/bin/rea` và toàn bộ symlink `/usr/local/bin/` (rizin, frida,
  apktool, adb, java…) biến mất, `npm ls -g` rỗng, apt mirror quay về
  `azure.archive.ubuntu.com` — đúng pattern đã ghi trong `~/tools/REA-SETUP.md`.
  Đã chạy `bash ~/tools/reinstall-system-tools.sh` (~5,5 phút, exit 0);
  `rea doctor` báo healthy trở lại. `~/tools/` (ghidra, jadx, kuna,
  rizin, asar-src, installer) còn nguyên. `/tmp` bị wipe theo
  (file tạm `/tmp/grok_tools.txt` phải tạo lại).
- `rea analyze-javascript-application ~/tools/grokbot/asar-src --json`
  (theo đúng CLI fallback trong skill `reverse-engineer-anything`):
  **kết thúc với lỗi `provider_timeout`** (exit 1, sau ~10 phút) — chạm
  trần 300.000 ms/server cho một file nguồn: file `main-app.cjs`
  (~3,5 MB minify) kẹt ở phase semantic (file 78/737) nên toàn bộ phân
  tích bị huỷ. Chỉ còn **Evidence từng phần** (xem §1.1). Mọi phát hiện
  dưới đây đến từ grep/ripgrep trực tiếp trên source đã giải nén + Rizin
  trên file `.node` (xem §11), không phụ thuộc vào lệnh `rea` này.
- `rizin 0.9.1` đã chạy trên 4 file `.node` (xem §11). `ghidra` không dùng
  cho lần này: logic app nằm trong JS bundle, binary Electron chính quá
  lớn và ít giá trị (đồng ý với kết luận lần 1).

### 1.1. Evidence từng phần của `rea analyze-javascript-application`

Lệnh REA timeout (§1) nhưng để lại Evidence từng phần đã lưu bền:

- File: `~/workspace/rea-evidence/rea-js-app-partial-20261109.json`
  (65 MB) + log tiến độ `rea-js-app-partial-20261109.err.log`.
  (Bản gốc ở `/tmp/rea-js-app.json` — `/tmp` bị wipe khi VM thay mới.)
- `evidence_id`: `ev_6b8e5a2db7ef1be1bc00bad0f8d4b25a460c35590bbe09c16a5bc039f3be1ebd`;
  subject SHA-256 `b8e93e7932523e7276b1133b2ec092b0c1e9d3add2f35f777c00f60d159a5a74`;
  graph `jag_802b89263b79f22c981fdc6d68087a8f2818c7756b66333f1c08e16bf147ea71`.
- Số liệu từng phần: 737 file liên quan, 53,6 MB đã đọc, **55 file JS
  parse xong, 655 file skip**, 881.555 AST node, **1.223 finding**,
  2.220 graph node, 2.716 edge, 0 parse failure. `native_addon_bindings`:
  6/6 resolved. `sender_validation_observations`: 1 (khớp với
  `assertTrustedRequester` thấy bằng grep, §2.1).
- **IPC summary = 0 trên mọi chỉ số — không phải "không có IPC" mà là
  chưa phân tích tới**: file chứa IPC (`main-app.cjs`, `proto.cjs`,
  renderer) nằm sau file 78 nên chưa được xử lý; limitation của Evidence
  ghi rõ "Graph coverage is incomplete; unavailable facts remain explicit
  and must not be read as absence."
- Cách chạy lại (theo remediation trong error JSON): tăng budget bằng
  `rea analyze-javascript-application <path> --analysis-timeout-ms <ms>`
  (mặc định 300.000 ms), hoặc **chọn file cụ thể bằng `--source-path`**
  (ví dụ chỉ `proto.cjs` + preload + daemon/coordinator, bỏ qua
  `main-app.cjs` 3,5 MB; hoặc phân tích renderer riêng). Có thể tái dùng
  Evidence từng phần qua `evidence_id` trên để khỏi tính lại.

## 2. Inventory IPC / RPC (bổ sung lần 1)

Lần 1 liệt kê endpoint + service. Lần này đào **kênh giao tiếp nội bộ**.

### 2.1. IPC main ↔ renderer — kênh literal `sand:*`

Hầu hết channel IPC đã bị minify thành biến (chỉ thấy `ipcMain.on(...)` /
`ipcMain.handle(...)` với tên biến), nên **không liệt kê đủ bằng tĩnh**.
Các channel còn giữ tên literal (chắc chắn):

| Channel | Vai trò (suy đoán từ tên + ngữ cảnh) | Nguồn |
|---|---|---|
| `sand:boot-snapshot-sync` | Đồng bộ "boot snapshot" (experiments/config) khi renderer boot; `returnValue` đồng bộ | `main-core.cjs` |
| `sand:renderer-boot-gate-opened` / `sand:renderer-boot-gate-landed` | Cổng boot: main mở gate, renderer báo đã land (đồng bộ 2 giai đoạn với §2.4 lần 1) | `main-app.cjs`, `preload.cjs` |
| `sand:renderer-alive` | Heartbeat renderer còn sống | `main-app.cjs` |
| `sand:render-trace-port` | Trao `MessagePort` để render tracing | `main-app.cjs`, `preload.cjs` (`sandRenderTrace`) |
| `sand:coordinator-port` / `sand:coordinator-port-request` | Trao `MessagePort` tới `node-agent-coordinator` (xem §2.2) | `main-app.cjs`, `preload.cjs` (`coordinatorPort`) |
| `sand:main-edge-served` | Báo main-edge đã phục vụ xong (edge = tầng RPC local, xem §6.3) | `main-app.cjs` |
| `sand:encode-png` | Nhờ main encode PNG (tránh làm nặng renderer) | `main-app.cjs` |
| `sand:network-online` | Báo trạng thái mạng online/offline | `main-app.cjs` |
| `sand:mouse-history-navigation` | Điều hướng history bằng chuột (nút back/forward) | `main-app.cjs` |
| `sand:browser-origin-return` / `sand:browser-popup-closed` / `sand:browser-passkey-stalled` | OAuth qua popup trình duyệt: trả origin, đóng popup, passkey kẹt | `main-app.cjs` |
| `sand:avatar-source` | Nguồn avatar (custom scheme `sand-*`, xem lần 1 §2.4) | `main-app.cjs` |
| `sand:vnc-session` / `sand:vnc-host-key` / `sand:vnc-interactive` / `sand:vnc-accepts-input` / `sand:vnc-liveness` / `sand:vnc-viewer-visible` | VNC viewer nhúng (điều khiển máy từ xa qua VNC; có preload riêng `preload-vnc.cjs`) | `main-app.cjs` |

**Chưa xác minh:** danh sách đầy đủ các channel minify (cần giải minify hoặc
quan sát runtime). Đây là giới hạn tĩnh lớn nhất của phần IPC.

### 2.2. Preload — các API expose ra renderer

`dist/electron-preload/preload.cjs` expose qua `contextBridge`:

| Tên expose | Nội dung |
|---|---|
| `"desktop"` | API desktop chính (minify, tên biến `Zf`) |
| `"sandPopout"` | `{agentId}` — cửa sổ popout chat |
| `"coordinatorPort"` | `MessagePort` bridge tới node-agent-coordinator (`ac.bridge`) |
| `"sandRenderTrace"` | Render tracing qua ipcRenderer |
| `"desktopMount"` | Desktop mount (capture overlay/panel — mount màn hình desktop vào app) |
| 2 tên minify (`Gt`, `tr`) | Chưa đọc được tên (một trong hai khả năng là object `sand` chính) |

Preload chuyên biệt: `preload-avatar-source.cjs`, `preload-vnc.cjs`,
`preload-webview.cjs`, `preload-desktop-mount-capture-overlay.cjs`,
`preload-desktop-mount-panel.cjs`. **Mới so với lần 1:** VNC viewer +
desktop-mount là 2 surface chưa được nhắc tới.

### 2.3. RPC services — danh sách đầy đủ hơn lần 1

Lần 1 nêu 7 service. Đếm trong `proto.cjs` + `main-app.cjs` thấy thêm:

| Service | Vai trò |
|---|---|
| `GrokBotService` | Service chính (xem §2.4 — ~392 RPC) |
| `AiService`, `DashboardService`, `AgentStoreService`, `BackgroundComposerService`, `AnalyticsService`, `SandBoxService` | Đã nêu lần 1 |
| `ExportTraceService` | Export trace (OpenTelemetry) — liên quan tracing §9 |
| `AdminReadGrokBotService` / `AdminListGrokBotService` / `AdminEnqueueGrokBotService` / `ReadGrokBotService` / `ListGrokBotService` / `EnqueueGrokBotService` | Các biến thể read/list/enqueue (admin + thường) của GrokBotService |
| `GrokBotSessionService` | Quản lý session Grok Bot |
| `AuthService` / `CursorAuthService` / `SandCursorAuthService` / `SandXaiIdentityAuthService` | 4 tầng auth (Cursor + xAI identity, xem lần 1 §4) |
| `InferenceService` | Inference (gọi model) tách riêng khỏi AiService |
| `LiveUpdateService` | Update (xem §7) |
| `ExperimentService` / `SandExperimentService` | Statsig/experiment (xem §10) |
| `ScmService` | Source-control (git host) |
| `DefaultOnePasswordConnectionService` | 1Password broker (xem §8) |

### 2.4. Quy mô GrokBotService: ~392 RPC

Đếm tên `*Request` duy nhất chứa `GrokBot` trong `proto.cjs`: **392**
(trong đó **67** bắt đầu bằng `Admin`). Mỗi `*Request` ≈ 1 RPC method
(kèm `*Response` tương ứng). Tổng cộng toàn bộ `proto.cjs` có **648**
`*Request` duy nhất (mọi service gộp lại). Nghĩa là bề mặt admin/server
của Grok Bot lớn hơn nhiều so với 76 tool call — tool là "ngôn ngữ" của
agent, còn RPC là "API quản trị" của nền tảng (agent/team/skill/billing/
email/Slack/meeting/migration…).

**Hàm ý cho open-bot:** đừng chỉ đếm tool; cần một "admin API" có version
(proto/schema) riêng cho quản trị bot/team nếu muốn đi xa. Hiện open-bot
chưa có tầng này (Local API + webhooks v0.5 là bước đầu).

### 2.5. Daemon thực thi local — executor taxonomy

`dist/local-exec-daemon/main.cjs` (không minify tên executor):

| Executor | Vai trò (suy đoán từ tên) |
|---|---|
| `shell-executor` | Chạy lệnh shell |
| `shell-stream-executor` | Chạy lệnh shell + stream output |
| `shell-allowlist-precheck-executor` | **Precheck allowlist trước khi chạy shell** — kiểm tra lệnh có được phép không rồi mới thực thi |
| `request-context-executor` | Executor theo request context |
| `smart-mode-classifier-executor` | **Classifier chọn mode/executor** ("smart mode") trước khi chạy |

Chuỗi method literal: `"run-command"`, `"send-input"`, `"shell"`, `"spawn"`,
`"exec"`, `"session"`/`"sessions"`, `"run-phone-tool"`.

**Phone tools (mới):** daemon có allowlist các tool phía điện thoại:

```
["run-command","send-input","read-file","list-directory","write-file",
 "read-ai-tool-setup","read-messages","send-imessage","run-phone-tool",
 "use-app","send-mail"]
```

mỗi tool gắn một scope (`"global"`…). Tức Grok Bot có một "phone surface":
đọc/gửi iMessage, gửi mail, mở app trên điện thoại qua daemon. Open-bot
đã có `imessage_draft` + `email_send` nhưng chưa có mô hình "phone tool
bridge" tổng quát (xem đề xuất P2-11).

### 2.6. Node-agent-coordinator — lifecycle protocol

`dist/node-agent-coordinator/main.cjs` có lifecycle message
`hello` → `ready` → `shutdown`, kèm `protocolVersion` (số, validate
`lifecycle.<phase>.protocolVersion must be …`), và một hằng ngày
`Date.parse("2025-11-20T08:00:00Z")` (1440 phút — chưa rõ vai trò, có thể
là mốc cutoff/grace period; **chưa xác minh**). WebSocket nội bộ có cấu
hình `protocolVersion`, `maxBufferedChunks: 262144`, `maxFragments: 16384`,
`autoPong: true`, `closeTimeout`. Đây là "giao thức điều phối" riêng,
không phải MCP/A2A.

## 3. Schema 76 tool call — phát hiện mới quan trọng

### 3.1. Cách đọc schema từ `proto.cjs` (chắc chắn)

`proto.cjs` là code protobuf-es đã sinh: mỗi message có descriptor dạng
chuỗi, ví dụ:

```
"ReplaceEnvToolCall|1 args #0|2 result #1|3 associated_pod_key 9"
```

Đọc: message `ReplaceEnvToolCall` có field 1 `args` (kiểu message `#0`),
field 2 `result` (`#1`), field 3 `associated_pod_key` kiểu string (`9`).
Message `ToolCall` là **oneof** gồm 75 nhánh (đánh số field 1–1000, ví dụ
`1 shell_tool_call #0 tool`, `51 replace_env_tool_call #42 tool`,
`1000 execute_tool_call #73 tool`), kèm các field chung:
`54 hook_additional_contexts #74*` (repeated),
`57 tool_call_id 9?`, `59 started_at_ms 4?`, `60 completed_at_ms 4?`.

### 3.2. Đính chính lần 1: vẫn 76 kiểu, nhưng khác 1 kiểu

Đếm descriptor `*ToolCall|` duy nhất trong `proto.cjs`: **76 kiểu**
(không tính bản thân message `ToolCall`). Lần 1 cũng đếm 76, nhưng thành
phần lệch 1:

- **Lần 1 thiếu:** `ReplaceEnvToolCall` — đổi biến môi trường của pod/
  session box đang chạy (`associated_pod_key`), tức tool đổi env của môi
  trường thực thi mà không cần tạo lại box.
- **Lần 1 thừa:** `ExecuteSandMcpTool` — tên này có trong code nhưng
  **không phải** một `*ToolCall` trong proto; nó là executor (chạy MCP tool
  trong sandbox), tương đương `mcp_system_exec` của open-bot.
- **Đổi tên nhỏ:** oneof field của PR code tour là
  `get_origin_pr_code_tour_tool_call` / `update_origin_pr_code_tour_tool_call`
  (có từ `origin` — tour lấy từ origin/git host), trong khi message vẫn là
  `GetPrCodeTourToolCall` / `UpdatePrCodeTourToolCall`.

### 3.3. Các field đặc biệt trong schema (chắc chắn)

| Message | Field đặc biệt | Ý nghĩa thiết kế |
|---|---|---|
| `ToolCall` (oneof) | `hook_additional_contexts` (repeated, #54) | **Hook có thể inject thêm context vào tool call** — hook không chỉ chặn/cho phép mà còn bổ sung ngữ cảnh |
| `ToolCall` (oneof) | `started_at_ms` / `completed_at_ms` (#59/#60) | Đo thời gian từng tool call (phục vụ tracing/billing) |
| `ToolCall` (oneof) | `tool_call_id` (#57) | ID để replay/đối chiếu (xem `ConversationHistoryToolCall`) |
| `TruncatedToolCall` | `original_step_blob_id` (bytes #1), `original_step_size_bytes` (#4), `preview` (#5) | Khi output quá dài: **giữ blob ID trỏ tới nội dung đầy đủ + preview**, thay vì cắt đứt |
| `GrokBotUserComputerLocalToolCall` | `tool_id`, `input_json`, `approval_id?`, `conversation_id`, `image_uploads` | Tool local tổng quát: có **approval flow riêng** (`approval_id`) + đính kèm ảnh |
| `ConversationHistoryToolCall` | `tool_call_id`, `tool_name`, `args_json` | **Replay một tool call cũ** bằng ID + tên + args JSON |
| `McpToolCall` / `ShellToolCall` | `description` (optional #3) | Mô tả hiển thị cho user khi tool chạy |
| `TaskToolCall` | `cloud_agent_bc_id?` (#3) | Subagent có thể là **cloud agent** (background composer id) |
| `ReplaceEnvToolCall` | `associated_pod_key` (#3) | Gắn với pod/session-box cụ thể |

**Lưu ý:** phần lớn `*ToolCall` chỉ có `args` + `result` (nội dung Args
nằm trong message `*Args` riêng, không trích được field chi tiết bằng
grep vì tên message con đã minify thành `#0/#1`). Muốn schema Args đầy đủ
cần parse `proto.cjs` bằng protobuf-es hoặc chạy `rea
analyze-javascript-application` xong đối chiếu graph (lệnh này đã timeout,
xem §1.1 — chạy lại với `--source-path proto.cjs`).

### 3.4. Bảng đối chiếu 76 tool Grok Bot vs 131 tool open-bot

Cách đếm open-bot: liệt kê mọi `definition.name` duy nhất trong
`packages/tools/dist/index.js` (mọi array `*_TOOLS` export + 10 tool
`createDefaultTools`) = **131 tên** (kiểm chứng bằng `node -e`, 2026-11-09).
`docs/BEYOND-ROADMAP.md` ghi **129 tool/bot** — lệch 2 tên, nhiều khả năng
do cách đếm (array alias `ALL_TOOLS` + tool chỉ đăng ký theo ngữ cảnh như
`create_handoff` / tool hệ thống có guard); điều phối viên nên đếm lại từ
một instance `defaultToolFactory` thật. Dưới đây dùng 131 làm mốc đối chiếu.

Ký hiệu: ✅ có tương đương · ◐ có một phần · ❌ chưa có.

| # | Grok Bot (`*ToolCall`) | Open-bot tương đương | Trạng thái |
|---|---|---|---|
| 1 | `AiAttributionToolCall` | `ai_attribution` | ✅ |
| 2 | `ApplyAgentDiffToolCall` | `apply_diff` | ✅ |
| 3 | `AskQuestionToolCall` | `ask_user` | ✅ |
| 4 | `AwaitToolCall` | `await_condition` | ✅ |
| 5 | `BlameByFilePathToolCall` | `git_blame` | ✅ |
| 6 | `CommunicateUpdateToolCall` | `send_progress_update` | ✅ |
| 7 | `ComputerUseToolCall` | `computer_click/key/mouse_move/type/screenshot` (7 tool rời) | ✅ (mịn hơn) |
| 8 | `ConnectScmToolCall` | `git_host_connect` | ✅ |
| 9 | `ConversationHistoryToolCall` | `read_agent_transcript`, `search_conversations`, `transcript_archive` | ◐ (đọc/search có; **replay theo tool_call_id thì không**) |
| 10 | `CreateAgentToolCall` | `create_agent` | ✅ |
| 11 | `CreateGoalToolCall` | `goal_create` | ✅ |
| 12 | `CreatePlanToolCall` | `plan_create` | ✅ |
| 13 | `CreateProjectToolCall` | `project_create` | ✅ |
| 14 | `CreateTrackedTasksToolCall` | `task_create` | ✅ |
| 15 | `DeleteToolCall` | `delete_file` | ✅ |
| 16 | `DeleteTrackedTasksToolCall` | `task_delete` | ✅ |
| 17 | `EditPrLabelsToolCall` | `pr_label_set` | ✅ |
| 18 | `EditToolCall` | `write_file` (+ `apply_diff`) | ✅ |
| 19 | `ExecuteToolCall` | `exec_task` | ◐ (Grok: thực thi tác vụ chung; open-bot `exec_task` gắn với session box/task — ngữ nghĩa hẹp hơn) |
| 20 | `FetchCloudAgentDataToolCall` | — | ❌ (open-bot có `session_box_*`, `agent_status` nhưng **không có tool lấy dữ liệu của cloud agent**) |
| 21 | `FetchToolCall` | `http_get` | ✅ |
| 22 | `GenerateImageToolCall` | `image_generate` | ✅ |
| 23 | `GenerateVideoToolCall` | `video_generate` | ✅ |
| 24 | `GetAgentStatusToolCall` | `agent_status` | ✅ |
| 25 | `GetMcpToolsToolCall` | `mcp_list_tools` | ✅ |
| 26 | `GetPrCodeTourToolCall` | `pr_code_tour_view` | ✅ |
| 27 | `GlobToolCall` | `glob_files` | ✅ |
| 28 | `GrepToolCall` | `grep_search` | ✅ |
| 29 | `GrokBotUserComputerLocalToolCall` | `computer_*`, `shell_exec` | ◐ (tool rời có; **bridge tổng quát tool-local kèm approval_id + image_uploads thì không**) |
| 30 | `ListMcpResourcesToolCall` | `mcp_list_resources` | ✅ |
| 31 | `ListTrackedTasksToolCall` | `task_list` | ✅ |
| 32 | `LsToolCall` | `list_files` | ✅ |
| 33 | `ManageAccessToolCall` | — | ❌ (quản lý quyền truy cập agent dưới dạng **tool**; open-bot chỉ có UI/service quản trị, không có tool) |
| 34 | `McpAuthToolCall` | `mcp_auth` (+ `mcp_auth_status`, `mcp_revoke`) | ✅ (hơn) |
| 35 | `McpToolCall` | `mcp_call_tool` | ✅ |
| 36 | `PrManagementToolCall` | `pr_create/pr_update/pr_list` | ✅ (mịn hơn) |
| 37 | `ReadAgentTranscriptToolCall` | `read_agent_transcript` | ✅ |
| 38 | `ReadCanvasToolCall` | `canvas_read` | ✅ |
| 39 | `ReadLintsToolCall` | `code_diagnostics` | ✅ |
| 40 | `ReadMcpResourceToolCall` | `mcp_read_resource` | ✅ |
| 41 | `ReadTodosToolCall` | `todo_list` | ✅ |
| 42 | `ReadToolCall` | `read_file` | ✅ |
| 43 | `RecordCiInvestigationFindingsToolCall` | `ci_investigate` | ✅ |
| 44 | `RecordScreenToolCall` | `computer_record_start/stop` | ✅ |
| 45 | `ReflectToolCall` | `reflect` | ✅ |
| 46 | `ReplaceEnvToolCall` | — | ❌ (**đổi env của session box/pod đang chạy**; open-bot chỉ tạo box mới với env mới) |
| 47 | `ReportBugToolCall` | `bug_report` | ✅ |
| 48 | `ReportBugfixResultsToolCall` | `bug_fix_report` | ✅ |
| 49 | `SearchConversationsToolCall` | `search_conversations` | ✅ |
| 50 | `SemSearchToolCall` | `semantic_search` | ✅ |
| 51 | `SendFinalSummaryToolCall` | `send_final_summary` | ✅ |
| 52 | `SendMessageToolCall` | `send_message_to_user` | ✅ |
| 53 | `SendToAgentToolCall` | `message_agent` | ✅ |
| 54 | `SendToUserToolCall` | `send_message_to_user` | ◐ (Grok tách 2 tool `SendMessage`/`SendToUser`; open-bot gộp 1 — khác biệt nhỏ, có thể là 2 đường nhắn khác nhau ở Grok: message thường vs message tới user) |
| 55 | `SetActiveBranchToolCall` | `set_active_branch` | ✅ |
| 56 | `SetupVmEnvironmentToolCall` | `sandbox_prepare` (+ `session_box_create`) | ✅ |
| 57 | `ShellToolCall` | `shell_exec` | ✅ |
| 58 | `StartGrindExecutionToolCall` | `grind_start` | ✅ |
| 59 | `StartGrindPlanningToolCall` | `grind_start` | ◐ (Grok tách planning vs execution thành 2 tool; open-bot gộp 1 tool `grind_start` + `grind_status/stop`) |
| 60 | `StartProjectUpdatesToolCall` | `project_set_updates` | ✅ |
| 61 | `StopAgentToolCall` | `stop_agent` | ✅ |
| 62 | `StopProjectUpdatesToolCall` | `project_set_updates` | ✅ |
| 63 | `SwitchModeToolCall` | `set_agent_mode` | ✅ |
| 64 | `TaskToolCall` | `delegate_task` | ✅ |
| 65 | `TruncatedToolCall` | (cơ chế, không phải tool) | ◐ (open-bot cắt kết quả ở 20.000 ký tự — `MAX_TOOL_RESULT_CHARS` trong `packages/tools/src/tools.ts` — nhưng **không giữ blob ID để lấy lại phần đầy đủ** như Grok) |
| 66 | `UpdateGoalToolCall` | `goal_update` | ✅ |
| 67 | `UpdatePrCodeTourToolCall` | `pr_code_tour_update` | ✅ |
| 68 | `UpdateTodosToolCall` | `todo_update` | ✅ |
| 69 | `UpdateTrackedTaskStatusesToolCall` | `task_set_status` | ✅ |
| 70 | `UpdateTrackedTaskTagsToolCall` | `task_set_tags` | ✅ |
| 71 | `UpdateTrackedTasksToolCall` | `task_update` | ✅ |
| 72 | `WebFetchToolCall` | `web_fetch` | ✅ |
| 73 | `WebSearchToolCall` | `web_search` | ✅ |
| 74 | `WriteCanvasToolCall` | `canvas_write` | ✅ |
| 75 | `WriteShellStdinToolCall` | `shell_session_write` | ✅ |
| 76 | `XSearchToolCall` | `x_search` | ✅ |

**Kết luận đối chiếu:** 76 kiểu Grok → **68 ✅, 6 ◐, 3 ❌ hoàn toàn**
(`FetchCloudAgentDataToolCall`, `ManageAccessToolCall`,
`ReplaceEnvToolCall`). Ngược lại, open-bot có **~55 tool Grok không có**
(A2A 6, session box 5, shell session 4, git commit/diff/status,
`supervisor_dispatch`, `list_subagent_roles`, `create_handoff`,
`memory_*`, `email_*`, `slack_*`, `teams_*`, `imessage_draft`,
`meeting_*`, `team_context_summary`, `transcript_archive`,
`agent_export/import`, `skill_marketplace_*`, `mcp_list_servers`,
`mcp_system_exec`, `mcp_revoke`, `video_from_images`, `canvas_list`,
`system_info`, `kill_process`, `list_processes`, `open_path`,
`plan_update`, `goal_list`, `project_list`…). Về **số lượng** open-bot
đã vượt Grok Bot; phần thiếu là các **cơ chế** (truncation có blob ref,
hook inject context, đo thời gian tool call, replay tool call, đổi env
của box đang chạy, bridge tool-local có approval) chứ không phải số tool.

## 4. Automations / Dream — luồng chi tiết hơn lần 1

### 4.1. Trigger: cron + webhook (chắc chắn)

Record automation phía client (đọc từ hàm parse trong `main-app.cjs`):

```
{automationId, id, name, triggerDescription, triggerPresentation (JSON),
 schedule, isEnabled, nextRunAtMs}
```

và validator record: `{prompt: string, trigger: unknown-record,
schedule: string, triggerDescription: string, isEnabled: boolean}`.
Trigger là union các object có `type` literal; **xác nhận được 2 kiểu**:

| Trigger | Schema (rpc def trong `main-app.cjs`) |
|---|---|
| `cron` | `{type: "cron", schedule: string, firesAt?: string, window: …}` — schedule dạng cron, có `firesAt` (lần chạy kế tiếp) và `window` (cửa sổ cho phép chạy lệch) |
| `webhook` | `{type: "webhook", …}` — gọi qua webhook (đi kèm thư mục key riêng, xem §8) |

Các literal khác (`temporal`, `box`, `slack`, `email`, `github`, `linear`,
`pagerduty`, `keyword`, `mention`, `message`, `reaction`, `connector_card`,
`chat_card`) xuất hiện trong file nhưng **chưa gắn được chắc chắn vào
trigger union** — có thể là loại trigger/event khác (Slack message,
GitHub event, PagerDuty…) hoặc là enum ở ngữ cảnh khác. **Suy đoán, cần
xác minh thêm** bằng cách parse AST của đoạn định nghĩa trigger.

Các RPC automation trong client (chắc chắn, tên method): `getAgentAutomations`,
`listAllAutomations`, `getAgentTasks`, `setAgentAutomationEnabled`,
`updateAgentAutomation`, `deleteAgentAutomation`, `runAutomationWebhook`,
`rerunAutomationFromCard`, `getAutomationWebhookCredential`,
`getBoxSecretsStatus`. Quyền xem/sửa automation là **policy-based**:
`GrokBotAutomationPolicyAction` = {`CREATE`, `CHANGE_POLICY`, …},
`GrokBotAutomationAction` = {`OPEN`, `TOGGLE`, `EDIT`, `DELETE`}; hàm
`viewerCapabilities` suy ra từ `viewerPermissions.allowedActions`.

Feature flag liên quan (Statsig, `main-app.cjs`): `automations_chain_prompts`
(xâu chuỗi prompt), `automations_block_pr_approval`, `automations_validate_on_enable`
(mặc định **bật** — validate automation khi enable), `automations_retry_button`,
`automations_self_hosted_pool_environment_targets` (chạy automation trên
pool tự host, chọn environment target), `automations_agent_ux`,
`managed_automations_team_revamp`.

### 4.2. Dream: chỉ là 1 RPC admin phía server (chắc chắn)

Từ `dream` trong toàn bộ `main-app.cjs` = **0 lần**; chỉ xuất hiện 1 lần
trong `proto.cjs`: `AdminStartGrokBotDream`. Tức client desktop **không có
logic dream** — dream là tác vụ nền do server khởi xướng qua RPC admin.
Open-bot đã đi xa hơn ở điểm này: dream chạy local trong
`packages/core/src/automations/dream.ts` (idle 15 phút, model rẻ nhất,
không chen vào chat đang chạy, kết quả lưu thành task + notification).
**Không có gì để học thêm từ Grok về dream**, trừ ý tưởng "dream như một
automation `run-agent` đặc biệt" (open-bot đã làm đúng như vậy).

### 4.3. Đối chiếu open-bot

Open-bot (`packages/core/src/automations/types.ts`): trigger =
`interval | cron | event(agent-done/file-changed) | manual`; action =
`run-agent | run-tool | create-task | notify`; scheduler không chạy khi
đang chat, run lỡ bị skip (không bù burst). **Thiếu so với Grok:**
trigger `webhook` (kèm credential + HMAC), `window` cho cron (cửa sổ lệch
cho phép), `triggerDescription` + `triggerPresentation` (mô tả trigger
hiển thị cho user), validate-on-enable, retry-run, policy
CREATE/CHANGE_POLICY theo viewer. Xem đề xuất P0-5.

## 5. Voice realtime — hệ thống voice-call đầy đủ

Đây là phần mới lớn nhất so với lần 1 (lần 1 chỉ nêu endpoint
`wss://api.x.ai/`). 

### 5.1. Dial policy: chỉ 1 origin được phép (chắc chắn)

```js
class … {
  static DIALABLE_ORIGIN = "wss://api.x.ai/";
  static isDialableURL(t) { return t.startsWith(e.DIALABLE_ORIGIN) }
  static undialableHostError(t) {
    return `${t} is not the allowed Sand voice-call realtime endpoint.` }
}
```

Client kiểm tra URL trước khi "dial" (quay số); origin khác → refusal
`edge_origin_not_dialable` / `not-configured`. Mint secret qua RPC
`MintSandVoiceCallSecret` (`MintSandVoiceCallSecretRequest/Response`);
ghi lại cuộc gọi qua `RecordGrokBotVoiceCall`; lấy thông tin qua
`GetGrokBotVoiceCall`.

### 5.2. Redial/backoff (chắc chắn — hằng số)

```
{maxAttempts: 20, maxSilentPathRedials: 3, dialTimeoutMs: 15_000,
 initialDelayMs: 1_000, maxDelayMs: 10_000, …}
```

So với open-bot (`packages/core/src/voice/realtime.ts`: reconnect tối đa
**3 lần**, delay 1s, backoff mũ): Grok quay số lại tới **20 lần** với
backoff 1s→10s, timeout mỗi lần quay 15s, riêng "silent path" (đường im
lặng — có thể là khi mic/đường truyền im) redial tối đa 3 lần. Close code
riêng: `1008`, `4001` (`VOICE_CALL_POLICY_CLOSE_CODE`,
`VOICE_CALL_SUPERSEDED_CLOSE_CODE` — superseded = phiên cũ bị phiên mới
thay thế). Có `VOICE_CALL_HEARTBEAT_MS`, `VOICE_CALL_STALE_MS`,
`VOICE_CALL_REMOTE_STALE_MS`, `VOICE_CALL_REDIAL`,
`voiceCallRedialDelayMs`, `voiceCallRejectedWorkLandedIds`.

### 5.3. Voice-call toolset riêng (chắc chắn — tên + mô tả)

Khi đang trong cuộc gọi, agent không dùng 76 tool thường mà dùng một bộ
tool voice riêng (mô tả lấy từ `VoiceCallToolDescriptions.*`):

| Tool (hằng) | Mô tả (tên hàm mô tả) |
|---|---|
| `VOICE_CALL_NUDGE_MAIN_TOOL` | `sendTask` (+ `sendTaskTo`, `sendTaskRequest`, `sendTaskAlreadyAnnounced`) — "nudge" agent đang làm việc: giao task, báo đã nhắc rồi |
| `VOICE_CALL_PEEK_AGENTS_TOOL` | `peekAgents` (+ `peekAgentsAgent`) — xem agent nào đang làm gì |
| `VOICE_CALL_PEEK_RUNS_TOOL` | `peekRuns` (+ `peekRunsQuery`) — xem các run đang chạy |
| `VOICE_CALL_PEEK_CHANGES_TOOL` | `peekChanges` (+ `peekChangesFile`) — xem thay đổi file |
| `VOICE_CALL_WORK_LANDED_TOOL` / `VOICE_CALL_WORK_OVERHEARD_TOOL` | Công việc đã "landed" (hoàn tất/merge) / nghe lỏm được |
| `VOICE_CALL_RECALL_TEXTS_TOOL` | `recallTextMessages` — nhớ lại tin nhắn |
| `VOICE_CALL_SEARCH_CONVERSATIONS_TOOL` | `searchConversations` (+ `…Query/Scope/Id/From/To/IfMissing`) — tìm trong hội thoại, có fallback khi không thấy (`SEARCH_MISS_FALLBACKS`) |
| `VOICE_CALL_SILENT_TOOL` | `staySilent` — giữ im lặng (có `VOICE_STAY_SILENT_REFUSALS` — các câu từ chối nói) |
| `VOICE_CALL_SWITCH_AGENT_TOOL` | `switchAgent` (+ `switchAgentTarget`) — đổi agent đang nói chuyện |
| `VOICE_CALL_TRANSFER_TOOL` | Chuyển cuộc gọi |
| `VOICE_CALL_HANGUP_TOOL` | `endTheCall` — cúp máy |

Giới hạn: `VOICE_CALL_REQUEST_CHAR_LIMIT` (độ dài request),
`VOICE_CALL_SEARCH_*_CHAR_LIMIT` (query/scope/quote/open/context),
`VOICE_CALL_SEARCH_HIT_LIMIT`, `VOICE_CALL_SENT_MESSAGE_LIMIT`,
`VOICE_CALL_LEFTOVER_LINE_LIMIT`, `VOICE_CALL_TURNS_PER_CHUNK`
(số turn mỗi chunk hội thoại), `VOICE_CALL_MAX_KEYTERMS` /
`VOICE_CALL_MAX_KEYTERM_LENGTH`, `VOICE_CALL_WRITTEN_SEND_WINDOW_MS`,
`VOICE_CALL_USER_FIRST_GRACE_MS` (grace khi user nói trước),
`VOICE_CALL_HEARD_COMPLETION_RATIO`. Receipts (biên nhận):
`VOICE_CALL_NUDGE_ABOUT_TO_BE_SAID_RECEIPT`,
`VOICE_CALL_NUDGE_QUEUED_RECEIPT`, `VOICE_CALL_NUDGE_UNDER_WAY_RECEIPT`.
Journal: `VOICE_CALL_JOURNAL_MAX_AGE_MS`,
`VOICE_CALL_JOURNAL_WAKE_MAX_AGE_MS` (nhật ký để "wake" — gọi lại khi có
việc). Chime/âm báo: `VOICE_CALL_CHIME_NOTES`,
`VOICE_CALL_STATUS_CHIMES`, `VOICE_CALL_DEFAULT_STATUS_CHIMES`,
`VoiceCallConnectChime`, `VOICE_CALL_INBOUND_WAKE_CUE`. Ngôn ngữ:
`VOICE_CALL_LANGUAGE_AUTO`, `VOICE_CALL_LANGUAGE_OPTIONS`;
giọng: `VOICE_CALL_VOICES`; tốc độ: `VOICE_CALL_SPEEDS`
(`voice-memo-speed`, `voice-settings` là 2 persisted store, xem §9).
Lỗi mic: `VOICE_CALL_MICROPHONE_FAULTS`. Lỗi tool:
`VOICE_CALL_TOOL_FAILED_ERROR`, `VOICE_CALL_MISSING_REQUEST_ERROR`,
`VOICE_CALL_REQUEST_TOO_LONG_ERROR`, `"the realtime connection cannot
carry the tool result"`, `"the tool failed on the caller's device"`.

### 5.4. Server-side voice harness (chắc chắn)

Hai RPC local-edge (xem §6.3): 
`/aiserver.v1.GrokBotService/VoiceCallHarnessSession` và
`/aiserver.v1.GrokBotService/VoiceCallHarnessTool` — server chạy tool
voice thay client; kết quả trả về `VoiceCallHarnessToolOutcomeKind` =
`SERVED` / `UNKNOWN_TOOL` / `INVALID_INPUT` (map sang chuỗi
`served`/`unknown_tool`/`invalid_input`). Các message:
`VoiceCallHarnessSession(Request/Response)`, `VoiceCallHarnessTool(Request/Response)`,
`VoiceCallToolDescriptor`, `VoiceCallLineState`, `VoiceCallReceipt`,
`VoiceCallReceiptOutput`, `VoiceCallGreeting`, `SandVoiceCallStartSurface`.
Tức kiến trúc là **harness**: client giữ đường voice, server thực thi tool
và trả outcome đã phân loại.

### 5.5. "Surface register" — câu trả lời theo màn hình (chắc chắn)

Chuỗi literal trong `main-app.cjs` (mô tả surface cho model):

- `desk`: "they can see the chat transcript, diff, and editor on screen.
  Keep spoken replies concise: name the key file or identifier and the key
  numbers, skip full directory paths, skip long lists unless they ask for a
  walkthrough, never deflect with 'details are on your screen' in place of
  the facts, and let subtle earcons stand in for repetitive verbal receipts."
- Các surface khác: `web`, `phone`, `carplay`, `headphones`
  (`VOICE_CALL_CHANNEL_PLATFORM`, `VOICE_SURFACES`).

Đây là pattern thiết kế đáng lấy: **câu trả lời thoại phải biết user đang
nhìn thấy gì** (transcript/diff/editor trên màn hình → nói ngắn gọn, nêu
tên file + con số chính, bỏ đường dẫn dài; dùng earcon thay lời xác nhận
lặp lại). Open-bot chưa có khái niệm này.

### 5.6. STT/dictation riêng (chắc chắn)

Ngoài realtime call còn một STT client: message
`SttClientMessage {payload: {case: "audio", value: {pcm16: Uint8Array}}}`,
`SttControl_Type.STOP`, class `DictationSession` với `pushAudio(pcm16)`.
Âm thanh đi dạng **PCM16** (không thấy opus trong luồng voice; opus chỉ
xuất hiện trong tên miền `mcp.opus.pro` và đuôi file `.opus`).
Audio realtime: PCM16 mono (khớp với open-bot đã chọn: 16 kHz in / 24 kHz
out theo chuẩn OpenAI Realtime — xem `packages/core/src/voice/types.ts`).

### 5.7. Đối chiếu open-bot

Open-bot có `RealtimeClient` theo wire shape **public OpenAI Realtime API**
(session.update → audio append base64 PCM16 → transcript/audio delta →
function call), reconnect tối đa 3 lần, `memo.ts` (voice memo). **Thiếu
so với Grok:** redial policy 20 lần + silent-path redial; voice toolset
riêng (nudge/peek/switch/transfer/hangup…); server-side harness +
outcome taxonomy; surface register; journal/wake; chime/earcon; dictation
STT client; voice settings/speed stores. Lưu ý: protocol realtime nội bộ
của xAI **không có trong client** (chỉ có URL + dial guard), nên open-bot
đúng khi giữ contract OpenAI Realtime công khai thay vì bắt chước xAI.
Xem đề xuất P0-1.

## 6. Update — track + service riêng

Bổ sung lần 1 (§3 #2 chỉ nêu endpoint `/updates`):

- **Track:** `sand-lab` (lab build) / `sand-nightly` / `sand-dogfood` /
  `sand` (stable mặc định). Hàm `Dz()` map `sandTrack` → tên môi trường
  Sentry (`SAND_SENTRY_ENVIRONMENT`).
- **Service:** `LiveUpdateService` với method `getStatus`,
  `checkForUpdates`, `checkForUpdatesExplicitly`, `setUpdateTrack({track})`,
  `quitAndInstallUpdate`; event `restart-to-update` (+ menu "restart").
  File nguồn lộ tên: `sand-update-service.ts` (trong seed lỗi
  `"checkForUpdates abort closure in sand-update-service.ts"`).
- **Lịch:** `checkForUpdates({trigger: "startup"})` khi khởi động +
  `scheduleNextPeriodicCheck()` (kiểm tra định kỳ; nếu lỗi thì "the next
  scheduled check retries"). Mã lỗi `SAND-E0505 updateDisabledByEnv`
  (tắt update bằng biến môi trường), domain `update`.
- **Flag:** `sand_update_required` (bắt buộc update), `sand_min_client_version`,
  `sand_internal_release_track_override`.
- **Đối chiếu:** open-bot chưa có auto-update (desktop app tự cập nhật là
  việc của wave triển khai). Xem đề xuất P1-9.

## 7. Vault / mã hoá token — sâu hơn lần 1

Lần 1 chỉ khẳng định safeStorage + `gateway-descriptor.json` +
`mcp-auth.json` + `PrivacyMode.NO_STORAGE`. Lần này thấy **3 kho riêng
biệt + cơ chế ghi bền**:

### 7.1. `user-secrets` store (chắc chắn)

Class có `diskCache` + `sessionSecrets: Map` (secret chỉ giữ trong phiên),
`isPersistent()` = `isEncryptedStorageAvailable()`, `listKeys()`,
`exportSnapshot()` trả `{accountScope, secrets}`, `upsert()`. Ghi file qua
`withBoundedDurableFileCopies` + `openDurableFileSync` — tức **ghi file
bền chống crash với số bản copy giới hạn** (ghi bản mới rồi xoay bản cũ,
không ghi đè trực tiếp 1 file). Giải mã: `safeStorage.decryptString(
Buffer.from(base64))`; lỗi giải mã → `reportDesktopEdgeFailure(
"user-secrets", "decrypt", …)` và trả `null` (fail-closed, không crash).

### 7.2. `gateway-descriptor.json` (chắc chắn)

Nằm trong `userData`, codec:
`encrypt: safeStorage.encryptString → base64`,
`decrypt: safeStorage.decryptString(Buffer.from(base64))`,
`isAvailable: isEncryptedStorageAvailable`. Nội dung JSON
`{version, entries}`, mỗi entry có `savedAtMs`; đọc có kiểm tra
`maxAgeMs` (hết hạn thì bỏ). Lỗi đọc/ghi/giải mã → báo
`reportDesktopEdgeFailure("gateway-descriptor", …)` rồi trả `{}`/`null`
(fail-soft có báo cáo).

### 7.3. `automation-webhook-keys/` (chắc chắn)

Thư mục riêng trong `userData`, encrypt/decrypt bằng safeStorage, chứa
key/credential của automation webhook (đi kèm trigger webhook §4.1).
Tương tự, `mcp-auth.json` có **startup scrub** (dọn credential lúc khởi
động) + `authWatchPollDeadline` (`mcp-auth-watch-poll`) + event
`mcp-auth-completed` / `mcp-servers-updated`.

### 7.4. Vault — kho đồ có giá trị (chắc chắn)

- Enum: `GrokBotVaultItemKind`, `GrokBotVaultItemManager`
  (`GROK_BOT_EMAIL` → `"grok-bot-email"`), `GrokBotVaultCreateRefusal`
  (có `VAULT_FULL` → `{kind: "vault_full"}`; các refusal khác →
  `{kind: "refused", message}`), lỗi `GrokBotVaultWireError`
  (15s timeout — `…+15e3`).
- Phương thức thanh toán `vault_card` (`{brand, last4, cardId?}`).
- RPC tạo vault item có cờ `saveToVault?: boolean` (user chọn có lưu vào
  vault không — opt-in, không tự động).
- Flag: `grok_bot_vault`, `grok_bot_vault_cards`,
  `grok_bot_vault_chrome_import` (import từ Chrome),
  `grok_bot_vault_card_scan_on_device` (quét thẻ trên thiết bị — khớp
  native module `sand-card-text-recognition`, xem §11).
- 1Password: `onepassword-connection-service.cjs` riêng +
  `DefaultOnePasswordConnectionService` + `OnePasswordBrokerConnectionState`
  + `MintSandVoiceCallSecretRequest`… (broker pattern: main process làm
  broker, không để renderer cầm credential 1Password trực tiếp).

### 7.5. Đối chiếu open-bot

Open-bot có Vault (`NO_STORAGE`, `rotateKey`, `pending-count by hash`,
`spend-limit`) — đã tốt. **Thiếu so với Grok:** (a) ghi file bền có
bounded copies (crash-safe); (b) kho secret tách 3 loại
(session-only vs disk vs webhook keys); (c) `maxAgeMs` + `savedAtMs`
cho entry mã hoá; (d) refusal taxonomy (`vault_full`/`refused`) +
wire-error timeout; (e) `saveToVault` opt-in trên từng RPC tạo credential;
(f) 1Password broker tách process. Xem đề xuất P1-8.

## 8. MCP client — xác nhận spec 2025-11-25 trong client thật

### 8.1. Client capabilities (chắc chắn — schema zod trong `main-app.cjs`)

Client khai báo và xử lý đầy đủ các server-initiated request:

| Method | Trạng thái |
|---|---|
| `sampling/createMessage` (kèm `tools` + `toolChoice`) | Có — sampling có tool (SEP-1577) |
| `elicitation/create` (form + **url mode**; `notifications/elicitation/complete`) | Có — action `accept`/`decline`/`cancel`; url mode có `elicitationId` + `url` |
| `roots/list` (+ `listChanged`) | Có |
| `logging/setLevel` + `notifications/message` | Có |
| `tasks` (experimental 2025-11) | Có trong capabilities (`tasks: …`) |

Capabilities object khai: `sampling: {context?, tools?}`,
`elicitation: {…}`, `roots: {listChanged?}`, `tasks: {…}`. Đây là bằng
chứng độc lập (từ client thật) rằng **Cursor/Grok Bot đã ở MCP 2025-11-25**,
khớp với `docs/research-mcp-2025-11.md` của open-bot.

### 8.2. Reconnect / resilience config (chắc chắn — `mcp_reconnect_config`)

```
fastRetryBaseDelayMs: 5_000, fastRetryMaxDelayMs: 60_000,
fastRetryMaxAttempts: 5,
periodicRetryBaseDelayMs: 5*60_000, periodicRetryMaxDelayMs: 30*60_000,
maxPeriodicCycles: null,
focusRetryCooldownMs: 5*60_000, inlineReconnectCooldownMs: 5*60_000,
oauthBackendRefreshHydrationPollIntervalMs: 500,
streamableHttpSession404TombstoneThreshold: 5,
healthProbeTimeoutMs: 10_000,
toolCallBoundedTimeoutEnabled: true,
toolCallIdleTimeoutMs: 120_000, toolCallMaxTotalTimeoutMs: 60*60_000,
degradedProbeDelayMs: 30_000, maxDegradedProbeFailures: 3,
keepaliveProbeDelayMs: 5*60_000, keepaliveJitterMs: 30_000,
stabilityThresholdMs: 30_000,
stdioConnectFailuresAreNonRetryable: true, retryNonRetryable: …
```

Mẫu: retry nhanh 5 lần (5s→60s) rồi chuyển retry định kỳ (5→30 phút, không
giới hạn chu kỳ); tool call có **2 timeout** (idle 120s + tổng 60 phút);
session HTTP 404 quá 5 lần thì "tombstone" (đánh dấu chết, không retry
vô hạn); probe sức khoẻ khi degraded (30s × 3 lần fail → degraded);
keepalive 5 phút ± jitter 30s; ổn định 30s mới coi là recovered; lỗi kết
nối stdio **không retry** (fail ngay — vì stdio lỗi thường là config sai,
retry vô ích).

### 8.3. Transport + auth UX (chắc chắn)

- Transport suy từ config: có `command` → `stdio`; `type: "sse"` → SSE;
  còn lại → Streamable HTTP (`"http"`). Flag
  `mcp_shared_process_transports` (share process transport giữa các client).
- `box-stdio-status` dedup (tránh spam trạng thái stdio của box).
- Khi server cần auth: client tự sinh **auth tool** với mô tả mẫu:
  "Authenticate this MCP server so its tools can be used. Call this tool
  through your MCP tool-calling interface when STATUS.md indicates this
  server needs authentication." + message lỗi mẫu hướng user vào
  Customize > MCPs. Tức MCP auth được **đưa vào luồng tool của agent**
  (model tự gọi tool auth), không chỉ là dialog UI.
- OAuth callback: `grokbot://mcp/oauth/callback`,
  `http://localhost:8787/callback`,
  `https://www.cursor.com/agents/mcp/oauth/callback`; `mcpOAuth…` (Entra
  admin consent: `cursor-entra-admin-consent`).
- Tailscale: MCP server trên private tailnet — dial qua Tailscale plugin;
  lỗi `tailnet_dial_failed`, `destination_not_…`, `dns_resolver_unreachable`,
  `host_unreachable`, `dial_failed` (phân loại lỗi dial chi tiết).

### 8.4. Đính chính tài liệu MCP cũ của open-bot (quan trọng)

`docs/research-mcp-2025-11.md` (2026-11-09) ghi open-bot "đang chạy MCP
2024-11-05, OAuth lấy token nhưng không dùng, không có MCP server".
**Kiểm tra lại code hiện tại (commit 23329a7) thấy đã lỗi thời:**

- `packages/core/src/mcp/client.ts`: `MCP_PROTOCOL_VERSION = '2025-11-25'`,
  `clientHandlers.ts` (elicitation/roots/sampling), capabilities quảng cáo
  đúng handler đã nối.
- OAuth token **đã được dùng**: `mcpTools.ts:170` gọi
  `getValidAccessToken(...)`; `client.ts:1055-1130` có `resolveAuth()` /
  `refreshAuthorization()` gắn header `Authorization` khi gọi MCP.
- **Đã có MCP server** (`packages/core/src/mcp/server.ts`, v0.13): stdio +
  Streamable HTTP, spec 2025-11-25, allowlist tool chỉ-đọc, lỗi validate
  → tool error (SEP-1303).

Điều phối viên nên cập nhật lại `research-mcp-2025-11.md` (không thuộc
phạm vi wave này — tôi không sửa file đó). Phần MCP còn thiếu thật của
open-bot so với Grok: reconnect config chi tiết (§8.2), auth-tool UX
(§8.3), tasks (experimental — nhưng lưu ý spec **2026-07-28 đã deprecate
sampling/roots/logging** và đưa tasks thành extension
`io.modelcontextprotocol/tasks`; xem research doc §1 — nên implement sau
một lớp abstraction). Xem đề xuất P0-4.

## 9. Renderer state management — persisted stores có version

- **Zustand** (chắc chắn): có trong `chunk-chat-*` và `chunk-core-*`.
  Không thấy Redux.
- **Persisted stores** (chắc chắn): pattern chung
  `{…, schemaVersion: 1, scope: "client-persisted", accountSensitive: true}`.
  Tên store đọc được: `account`, `agent-creations`,
  `cloud-agent-open-target`, `composer-drafts`, `ui-agent-refs`,
  `ui-layout`, `unprompted-answers`, `voice-memo-speed`, `voice-settings`,
  `host-durable`. Draft key bằng `crypto.randomUUID()` ("drafts-store:
  the draft id keys the persisted draft").
- **Telemetry cho persistence** (chắc chắn): `shipReport({kind:
  "client_persistence", …})` — báo cáo khi persistence gặp vấn đề.
- **Đối chiếu:** open-bot renderer dùng store gì chưa đối chiếu kỹ ở wave
  này; pattern đáng lấy: **mọi persisted store đều có `schemaVersion` +
  `scope` + cờ `accountSensitive`** (để biết store nào phải xoá khi đổi
  tài khoản / bật NO_STORAGE), và draft key bằng UUID thay vì key tự tăng.
  Xem đề xuất P1-10.

## 10. Egress tunnel / network allowlist — sandbox mạng

Phát hiện mới (flag Statsig + chuỗi lỗi trong `main-app.cjs`):

| Flag / chuỗi | Ý nghĩa |
|---|---|
| `sand_box_egress_tunnel` (mặc định **bật**) | Mọi traffic ra ngoài của session box đi qua một egress tunnel (proxy có kiểm soát) |
| `sand_egress_tunnel_fail_closed` / `sand_egress_tunnel_strict_fail_closed` | Tunnel lỗi → **chặn hết** (fail-closed) thay vì cho đi trực tiếp |
| `sand_egress_tunnel_ipv4_exit` | Exit IPv4 của tunnel |
| `sand_egress_tunnel_private_destinations` | Có cho phép đích private (LAN) không |
| `sand_local_egress_admin_control` (mặc định bật) | Admin local kiểm soát egress |
| `sand_team_egress_allowlist_dashboard` | Dashboard allowlist egress theo team |
| `sand_network_allowlist` | Allowlist mạng |
| `sand_anonymized_egress_telemetry` (mặc định bật) | Telemetry egress đã ẩn danh |
| `sand_attachments_via_server` | File đính kèm đi qua server (không đi trực tiếp) |
| Lỗi | `egress_unconfigured`, `egress_connect_unconfigured`, `signing_unconfigured`, `egress_unreachable`, `egress_invalid_response` |
| GitHub | "Ask a GitHub org admin to allowlist Cursor's egress IPs, then start the agent again" — agent checkout repo **từ IP của egress tunnel**, org phải allowlist IP đó |
| Tailscale | "Connect again from the Tailscale plugin in Grok Bot" — truy cập private network qua Tailscale plugin |

**Đối chiếu:** open-bot **chưa có** egress control nào (grep `egress`
trong `packages/*/src` = 0 kết quả). Sandbox hiện tại chỉ giam file/shell
(workspace allowlist, SSRF check cho `web_fetch`). Đây là lỗ hổng kiến
trúc lớn nhất nếu open-bot chạy agent cho team / chạy box phía server:
agent trong box có thể gọi bất kỳ host nào. Xem đề xuất P0-2.

## 11. Native modules — kết quả Rizin (tĩnh, không chạy)

Chạy `rizin -qc 'iE; ii; il; q'` trên 4 file `.node` (PE32+ DLL x64).
Kết quả chung cho cả 4: **chỉ export 2 hàm N-API chuẩn**
(`napi_register_module_v1`, `node_api_module_get_api_version_v1`) và
**chỉ link `kernel32.dll` + `node.exe`** — method thật đăng ký lúc runtime
qua `napi_define_properties` nên không thấy trong export table. Rizin
không cho thêm gì ở tầng này (đúng dự đoán: không phân tích binary
Electron chính).

Phần có giá trị là **`strings`** (tên method nội bộ + PDB path):

| Module | Tên method / chuỗi đáng chú ý |
|---|---|
| `sand-window-capture` (149.800 byte) | `capture_rect_async`, `capture_window_async`, `request_screen_capture_access_sync`, `screen_capture_access_sync` — chụp cửa sổ/vùng chữ nhật + **xin quyền chụp màn hình** (permission request, không chụp lén) |
| `sand-devicecheck` (155.944 byte) | `"DeviceCheck is not available in this build"`, `SandDeviceCheckErrorDomain` — DeviceCheck kiểu Apple, **stub trên bản Windows** |
| `sand-card-text-recognition` (142.632 byte) | (chỉ export N-API; tên gợi ý OCR text trên thẻ — khớp flag `grok_bot_vault_card_scan_on_device`) |
| `cursor-proclist` (184.104 byte), `tree-sitter` (492.840 byte) | Chỉ export N-API; không có string đặc biệt thêm |

PDB path lộ quy trình build: `C:\b\sand-release-cache\845\scratch\
pnpm-virtual-store\_<hash>\node_modules\<tên-module>\build\Release\
<module>.pdb` — build bằng pnpm trong sandbox cache, không có ý nghĩa
tích hợp (chỉ ghi nhận provenance).

## 12. Pattern từ framework/agent hàng đầu — đối chiếu open-bot

Nguồn: tài liệu công khai (web/docs chính thức + bài tổng hợp có dẫn nguồn).
Chỉ lấy pattern kiến trúc, không sao chép code.

### 12.1. MCP spec 2025-11-25 (modelcontextprotocol.io)

- 6 primitive: server offer tools/resources/prompts; client offer
  sampling/roots/elicitation. Mới ở 2025-11-25: **Tasks** (experimental,
  durable async request + poll `tasks/get`/`tasks/result`/`tasks/cancel`/
  `tasks/list`), **URL-mode elicitation** (form-mode MUST NOT dùng cho
  password/key/thanh toán), **sampling kèm tools** (`tools` + `toolChoice`),
  icons cho tool/resource/prompt, OIDC discovery + Client ID Metadata
  Documents cho OAuth, lỗi validate input → tool error (SEP-1303).
- **Cảnh báo tương lai (đã ghi trong `docs/research-mcp-2025-11.md` §1,
  xác nhận lại qua search):** spec **2026-07-28** deprecate
  sampling/roots/logging (SEP-2577), tasks thành extension
  `io.modelcontextprotocol/tasks` không tương thích ngược với bản
  experimental 2025-11-25. → Đừng đầu tư lớn vào sampling/roots; tasks +
  elicitation implement sau abstraction.
- **Grok Bot đã implement đủ client capabilities 2025-11-25** (§8.1) —
  bằng chứng thực tế rằng Cursor coi đây là baseline, không phải tính
  năng xa xỉ.
- **Open-bot:** client 2025-11-25 + handlers + MCP server đã có (§8.4).
  Còn thiếu: reconnect config chi tiết (§8.2), auth-tool UX (§8.3).

### 12.2. Claude Agent SDK / Claude Code (Anthropic)

Nguồn: `code.claude.com/docs`, bài tổng hợp
[morrison-lab.github.io/wai/chapters/agent-architecture.html](https://morrison-lab.github.io/wai/chapters/agent-architecture.html),
[medium.com/ml2vec — A Practical guide to building Agents](https://medium.com/ml2vec/a-developers-guide-to-building-agents-52a8fe51b632).

| Pattern | Nội dung | Open-bot |
|---|---|---|
| 3 lớp: tools → permissions → hooks | Tool là "động từ"; permission (`canUseTool`) chạy **trước** khi tool thực thi, chặn theo path/rule; hook (`PreToolUse`/`PostToolUse`) kiểm tra **nội dung** tool call (tham số đã thành hình) và có thể chặn | Đã có cả 3 lớp (ToolRegistry + auto-approve 3 tầng + hooks out-of-process), nhưng **hook chưa chặn theo nội dung** (content validation) — chỉ chặn theo tên tool/rule |
| Permission mode | `default` (hỏi) / `acceptEdits` / `plan` / `auto` (classifier chạy action an toàn, chặn action phá hoại) | Có auto-approve 3 tầng (denylist thắng) + plan mode fail-closed; **thiếu mode `auto` theo classifier** (Grok có `smart-mode-classifier-executor`, §2.5 — cùng ý tưởng) |
| `ToolSearch` | Nạp deferred tool schema theo nhu cầu (không gửi hết 100+ tool vào context) | Đã có tool-filter fallback (123 tool/~16.929 token → 20 defs/~3.241 token, v0.29); **thiếu nạp schema theo nhu cầu trong lúc chạy** (load-on-demand) |
| Subagent lồng nhau | Tối đa 5 tầng; mỗi subagent có system prompt + tool list + model riêng | Có subagent + roles; **chưa rõ có giới hạn độ sâu lồng nhau không** — cần cap 5 + báo cáo |
| Sandbox | Docker / Kubernetes / None (chạy trực tiếp host) | Có sandbox local + session box; **thiếu lựa chọn Docker/K8s** (chỉ có local + box) |
| Skill = thư mục `SKILL.md` | Frontmatter `description` (khi nào kích hoạt) + `model`/`agent` ghim; nạp progressive disclosure 3 tầng | Đã có skills YAML 3 tầng (v0.30) — khớp |

### 12.3. OpenAI Agents SDK

Nguồn: [opendatascience.com — Top 10 AI Agent Orchestration Frameworks](https://opendatascience.com/ai-agent-orchestration-frameworks-github/),
[framework-comparison.md (trwilcoxson/claude-skills)](https://github.com/trwilcoxson/claude-skills/blob/HEAD/skills/agentic-ai-requirements/references/framework-comparison.md).

- 4 primitive: **Agent / Tool / Handoff / Guardrail** + tracing built-in.
- **Handoff = chuyển quyền điều khiển vòng lặp**, không phải gọi hàm trả
  kết quả (khác với task dispatch). Open-bot có cả `delegate_task` (giao
  việc, trả kết quả) và `create_handoff`/`session handoff` — cần làm rõ
  ngữ nghĩa: handoff chuyển hẳn conversation + quyền điều khiển, delegate
  chỉ giao việc.
- **Guardrail = tripwire**: input/output guardrail chạy song song hoặc chặn
  hẳn; fail → dừng ngay trước khi gọi model đắt tiền. Open-bot có guardrails
  P0-5 (v0.32) — đối chiếu xem đã có tripwire chạy **trước** model call
  (pre-model) hay chỉ kiểm tra sau.
- Sessions = bộ nhớ hội thoại bền (persistent conversation memory);
  provider-agnostic (có đường dùng model non-OpenAI).

### 12.4. LangGraph 1.0 (GA 2025-10-22)

Nguồn: xem §12.3 (cùng 2 link trên).

- Graph có hướng + conditional edge; state bất biến theo reducer;
  **durable checkpointing** (sống qua restart server) + **time-travel
  replay**; `interrupt()` = human-in-the-loop hạng nhất; short-term +
  long-term memory tách bạch.
- Open-bot có transcript archive + handoff + plan mode, nhưng **chưa có
  checkpoint/resume thật của agent run** (chạy lại từ đầu khi crash) và
  **chưa có interrupt point** (dừng giữa run để hỏi user rồi tiếp tục từ
  đúng điểm đó — plan approval 1 bước hiện tại là dạng đơn giản nhất).
  Đây là pattern đáng lấy nhất cho độ bền của run dài (grind mode).

### 12.5. Google ADK (GA Python 2025-04)

Nguồn: xem §12.3; bài so sánh
[chingjustwe.github.io — Agent Framework Deep Dive](https://github.com/chingjustwe/chingjustwe.github.io/blob/HEAD/_posts/2026-04-11-agent-framework-comparison-en.md).

- Mô hình 3 tầng state: **Session / Memory / Artifact** (Memory giữ thông
  tin user xuyên session; Artifact quản file/binary; có backend managed
  như VertexAIMemoryBankService, SQL).
- Agent cây phân cấp + Workflow Runtime (graph); `transfer_to_agent`;
  **agents-as-tools** (dùng agent khác như một tool).
- Open-bot: có Memory (embeddings + semantic search, v0.34) + session box
  snapshot, nhưng **chưa tách Artifact store** (file/binary do agent tạo
  ra chưa có kho riêng có version + metadata) và chưa có agents-as-tools
  (subagent chỉ gọi qua `delegate_task`).

### 12.6. Microsoft Agent Framework / A2A / AG-UI

Nguồn: xem §12.3 (bảng so sánh opendatascience).

- Graph workflow: sequential / concurrent / handoff / group chat; session
  state + checkpointing; native MCP + **A2A** + AG-UI; thiết kế cho
  human-review của run dài.
- Open-bot đã có A2A client (6 tool) + A2A server? (cần kiểm tra — A2A
  client đã nối, server chưa rõ). Group chat (nhiều agent cùng thảo luận
  1 task) là pattern chưa có.

### 12.7. Bảng tổng hợp: pattern nào open-bot chưa có (đáng lấy)

| Pattern | Nguồn | Open-bot | Mức độ đáng lấy |
|---|---|---|---|
| Egress tunnel fail-closed + IP allowlist | Grok Bot §10 | ❌ chưa có | **Cao nhất** (bảo mật khi chạy cho team) |
| Voice redial 20 lần + voice toolset + surface register | Grok Bot §5 | ◐ (realtime cơ bản có) | Cao |
| MCP reconnect config chi tiết + auth-tool UX | Grok Bot §8 | ◐ (client/server đã có) | Cao |
| Truncation giữ blob ref để lấy lại | Grok Bot §3.3 | ◐ (cắt cứng 20k) | Cao (rẻ, ít rủi ro) |
| Hook inject context vào tool call + đo thời gian tool call | Grok Bot §3.3 | ❌ | Cao (rẻ) |
| Webhook trigger + validate-on-enable + retry-run cho automations | Grok Bot §4 | ◐ (cron/event có) | Cao |
| Vault ghi bền bounded-copies + 3 kho tách biệt + refusal taxonomy | Grok Bot §7 | ◐ (Vault cơ bản có) | Trung bình |
| Tool schema load-on-demand (`ToolSearch`) | Claude SDK | ◐ (tool-filter có) | Trung bình |
| Checkpoint/resume + interrupt HITL + time-travel | LangGraph | ❌ | Trung bình (lớn) |
| Guardrail tripwire pre-model | OpenAI SDK | ◐ (guardrails có) | Trung bình |
| Artifact store tách khỏi Memory | Google ADK | ❌ | Trung bình |
| Agents-as-tools + handoff ngữ nghĩa rõ | ADK / OpenAI SDK | ◐ | Trung bình |
| Update track (lab/nightly/dogfood/stable) | Grok Bot §6 | ❌ | Trung bình (khi đóng gói) |
| Persisted store có schemaVersion + accountSensitive | Grok Bot §9 | ❌/chưa rõ | Thấp–trung bình |
| Docker/K8s sandbox option | Claude SDK | ❌ | Thấp (nặng) |
| Group chat đa agent | MS Agent Framework | ❌ | Thấp |

## 13. Đề xuất tích hợp — xếp theo ưu tiên

Chỉ đề xuất, **không viết code ở wave này**. Mỗi đề xuất ghi file/module
open-bot cần chạm. "Rẻ" = ít file, ít rủi ro; "Lớn" = thay đổi kiến trúc.

### P0 — làm trước (bảo mật + voice + độ bền)

**P0-1. Voice: redial policy + voice toolset + surface register**
(§5.2, §5.3, §5.5)
- Lấy: `maxAttempts 20`, `dialTimeoutMs 15s`, backoff 1s→10s,
  `maxSilentPathRedials 3`, close code superseded; bộ tool voice
  (nudge/peek_agents/peek_runs/peek_changes/recall_texts/
  search_conversations/stay_silent/switch_agent/transfer/end_call) với
  giới hạn ký tự; surface register (desk/web/phone/carplay/headphones)
  để câu trả lời thoại ngắn gọn theo màn hình user đang thấy; harness
  outcome `served/unknown_tool/invalid_input`; STT dictation PCM16.
- Chạm: `packages/core/src/voice/realtime.ts` (redial),
  `packages/core/src/voice/types.ts` (thêm `VoiceSurface`,
  `VoiceCallTool*`), mới `packages/core/src/voice/harness.ts`,
  `packages/core/src/voice/dictation.ts`, `apps/desktop/src/renderer/*`
  (voice UI: surface hiện tại, chime/earcon), test voice.
- Lưu ý: giữ contract OpenAI Realtime công khai, không bắt chước
  protocol xAI nội bộ (không có trong client).

**P0-2. Egress control cho session box / agent chạy mạng** (§10)
- Lấy: egress tunnel với fail-closed mặc định, allowlist host/IP theo
  team, chặn đích private (LAN) trừ khi cho phép, IP allowlist cho
  GitHub checkout, telemetry egress ẩn danh, phân loại lỗi egress
  (unconfigured/unreachable/invalid_response).
- Chạm: mới `packages/core/src/egress/*` (policy + allowlist +
  fail-closed), `packages/tools/src/sandbox.ts` + `ssrf.ts` (mở rộng
  SSRF check thành egress policy chung), `packages/tools/src/daemon/*`
  (áp policy cho shell trong box), `packages/core/src/team/*` (allowlist
  theo team), docs.
- Đây là lỗ hổng lớn nhất hiện tại (grep `egress` = 0). Làm trước khi
  mở team/multi-user rộng.

**P0-3. Ba tool còn thiếu + cơ chế tool-call** (§3.4, §3.3)
- Thêm tool: `session_box_replace_env` (đổi env của box đang chạy,
  theo `ReplaceEnvToolCall` + `associated_pod_key`),
  `cloud_agent_fetch_data` (theo `FetchCloudAgentDataToolCall`),
  `manage_access` (theo `ManageAccessToolCall`, hoặc quyết định rõ là
  "không làm tool này, chỉ làm UI quản trị" — cần quyết định, không để
  lửng).
- Thêm cơ chế: `TruncatedToolCall` kiểu Grok — giữ `blob_id` +
  `original_size_bytes` + `preview` khi kết quả tool quá dài, agent gọi
  lại để lấy phần đầy đủ (thay cho cắt cứng 20k ký tự hiện tại);
  `hook_additional_contexts` — hook được inject context vào tool call;
  `started_at_ms`/`completed_at_ms` cho mọi tool call (nối vào tracing
  đã có).
- Chạm: `packages/tools/src/sessionBox*` / `agentDataTools.ts` /
  `agentTools.ts` (tool mới), `packages/tools/src/tools.ts`
  (`MAX_TOOL_RESULT_CHARS` → blob store), `packages/core/src/agent/*`
  (hook context + timing), `packages/core/src/tracing/*`.

**P0-4. MCP: reconnect config + auth-tool UX + tasks sau abstraction**
(§8.2, §8.3; §12.1)
- Lấy số liệu `mcp_reconnect_config` của Grok (fast retry 5s→60s ×5,
  periodic 5→30 phút, tool idle 120s / tổng 60 phút, session-404
  tombstone 5, degraded probe 30s ×3, keepalive 5 phút ±30s jitter,
  stability 30s, stdio lỗi không retry).
- Auth-tool UX: khi MCP server cần auth, sinh tool auth để **model tự
  gọi** (mô tả mẫu như Grok), thay vì chỉ báo lỗi.
- Tasks (MCP 2025-11 experimental) sau một lớp abstraction (vì spec
  2026-07-28 đổi thành extension không tương thích ngược); elicitation
  URL-mode + form-mode đã có handler — kiểm tra lại coverage thực tế.
- Chạm: `packages/core/src/mcp/client.ts` (reconnect + timeout),
  `packages/tools/src/mcpTools.ts` + `mcpSystemTools.ts` (auth tool),
  mới `packages/core/src/mcp/tasks.ts` (abstraction), test MCP.
- Kèm: cập nhật `docs/research-mcp-2025-11.md` (đã lỗi thời, §8.4).

**P0-5. Automation: webhook trigger + validate-on-enable + retry**
(§4.1, §4.3)
- Thêm trigger `webhook` (kèm credential lưu Vault theo mẫu thư mục
  `automation-webhook-keys/`, HMAC verify); `window` cho cron (cửa sổ
  lệch cho phép); `triggerDescription` + `triggerPresentation` hiển thị;
  validate automation khi enable (mặc định bật); nút retry-run;
  policy CREATE/CHANGE_POLICY theo viewer.
- Chạm: `packages/core/src/automations/types.ts` (thêm trigger +
  field), `engine.ts` (webhook handler + validate), `scheduler.ts`
  (window), `packages/core/src/vault/*` (webhook keys),
  `apps/desktop/src/renderer/*` (UI automation), test.

### P1 — làm sau P0 (cứng hoá + vận hành)

**P1-6. Vault hardening theo mẫu Grok** (§7)
- Ghi file bền bounded-copies (crash-safe, xoay bản cũ); tách 3 kho
  (session-only Map / disk encrypted / webhook keys); `maxAgeMs` +
  `savedAtMs` cho entry mã hoá; refusal taxonomy
  (`vault_full`/`refused` + wire timeout); `saveToVault` opt-in trên
  từng thao tác tạo credential; 1Password broker tách process (hiện
  open-bot đã nối 1Password? — kiểm tra, nếu chưa thì làm broker).
- Chạm: `packages/core/src/vault/*`, `apps/desktop/src/main/*`.

**P1-7. Tool-call replay + computer-local bridge** (§3.3)
- Replay tool call cũ bằng `tool_call_id`/`tool_name`/`args_json`
  (`ConversationHistoryToolCall`); bridge tool-local tổng quát
  (`tool_id`/`input_json`/`approval_id`/`conversation_id`/
  `image_uploads`) cho phone/desktop tool (iMessage/mail/use-app —
  nối với daemon allowlist kiểu Grok §2.5).
- Chạm: `packages/tools/src/agentDataTools.ts` (replay),
  mới `packages/tools/src/localBridge.ts`, `packages/tools/src/daemon/*`.

**P1-8. Checkpoint/resume + interrupt HITL cho run dài** (§12.4)
- Checkpoint durable của agent run (sống qua restart), resume từ
  checkpoint, `interrupt()` dừng giữa run để hỏi user rồi tiếp tục đúng
  điểm (mở rộng plan-approval 1 bước hiện tại), time-travel replay để
  debug. Áp trước cho grind mode (run dài nhất).
- Chạm: `packages/core/src/agent/*` (runner + checkpoint store),
  `packages/core/src/subagents/*`, `packages/tools/src/*` (grind),
  `apps/desktop/src/renderer/*` (UI resume/interrupt).

**P1-9. Update theo track + scheduled check** (§6)
- Track `lab/nightly/dogfood/stable`, `setUpdateTrack`,
  `checkForUpdates` lúc startup + định kỳ (lỗi thì retry ở lần sau),
  `quitAndInstallUpdate`, mã lỗi `updateDisabledByEnv`, cờ
  `update_required`/`min_client_version`.
- Chạm: `apps/desktop/src/main/*` (mới `updateService.ts`),
  `apps/desktop/src/renderer/*` (menu + banner), docs.
- Chỉ làm khi bắt đầu đóng gói phát hành (hiện push GitHub còn defer).

**P1-10. Renderer persisted store có version** (§9)
- Mọi store persist đều có `schemaVersion` + `scope` +
  `accountSensitive` (xoá khi đổi tài khoản / bật NO_STORAGE); draft
  key bằng UUID; telemetry `client_persistence` khi persistence lỗi.
- Chạm: `apps/desktop/src/renderer/*` (store), test.

### P2 — khi có thời gian (mở rộng)

**P2-11. Guardrail tripwire pre-model + classifier mode** (§12.2, §12.3)
- Guardrail chạy **trước** model call (chặn input vi phạm trước khi tốn
  tiền model); mode `auto` theo classifier (chạy action an toàn, chặn
  action phá hoại — cùng ý tưởng `smart-mode-classifier-executor` §2.5);
  hook `PreToolUse` kiểm tra **nội dung** tham số (không chỉ tên tool).
- Chạm: `packages/core/src/agent/*`, `packages/core/src/guardrails/*`,
  `packages/tools/src/shellQuote.ts` + `sandbox.ts` (precheck executor
  tách riêng khỏi executor chạy — theo mẫu daemon §2.5).

**P2-12. Artifact store + agents-as-tools + handoff rõ nghĩa**
(§12.5, §12.3)
- Tách Artifact store (file/binary agent tạo ra, có version + metadata)
  khỏi Memory; subagent dùng được như một tool (agents-as-tools);
  phân biệt `delegate_task` (giao việc, trả kết quả) vs `handoff`
  (chuyển hẳn quyền điều khiển + conversation).
- Chạm: mới `packages/core/src/artifacts/*`,
  `packages/core/src/subagents/*`, `packages/tools/src/subagentTools.ts`
  + `handoffTools.ts`.

**P2-13. Tool schema load-on-demand + subagent depth cap** (§12.2)
- Nạp schema tool theo nhu cầu trong lúc chạy (kiểu `ToolSearch`),
  thay vì chỉ filter 1 lần đầu run; cap subagent lồng nhau 5 tầng.
- Chạm: `packages/core/src/agent/toolFilter.ts`,
  `packages/core/src/subagents/*`.

**P2-14. Window capture native + VNC/desktop-mount** (§2.2, §11)
- Chỉ làm nếu computer-use cần chụp cửa sổ riêng lẻ (hiện
  `computer_screenshot` qua xdotool đã đủ trên Linux): native module
  chụp window/rect + xin quyền chụp màn hình (permission request, không
  chụp lén); VNC viewer nhúng + desktop-mount là tính năng lớn, để sau
  khi có nhu cầu rõ ràng (điều khiển máy từ xa).
- Chạm: mới `packages/tools/src/native/*` (cần build native theo OS),
  `apps/desktop/src/main/*`, `apps/desktop/src/renderer/*`.

**P2-15. Remote config / feature flag kiểu Statsig** (§4.1, §10)
- Bắt đầu bằng flag file local (đã có config?), sau đó mới remote:
  bật/tắt tính năng + thử nghiệm model không cần phát hành bản mới;
  model registry per-feature do server trả về (open-bot đã có model
  registry v0.5 — chỉ cần thêm per-feature default/fallback).
- Chạm: mới `packages/core/src/flags/*`, `packages/core/src/models/*`.

## 14. Đính chính tài liệu cũ (để điều phối viên cập nhật)

1. `docs/GROK-BOT-ANALYSIS.md` §5.2: danh sách 76 tool **thiếu
   `ReplaceEnvToolCall`, thừa `ExecuteSandMcpTool`** (không phải
   `*ToolCall`). Nên sửa §5.2 (thêm 1 dòng ReplaceEnv, đổi
   `ExecuteSandMcpTool` thành "executor, không phải tool") — nhưng wave
   này không sửa file của người khác; ghi ở đây để điều phối viên sửa.
2. `docs/research-mcp-2025-11.md`: đã lỗi thời ở 3 điểm (§8.4) — client
   đã lên 2025-11-25, OAuth token đã được dùng, MCP server đã có.
3. `docs/BEYOND-ROADMAP.md`: "129 tool/bot" vs đếm trực tiếp từ dist =
   **131 tên duy nhất** — lệch 2, cần đếm lại từ `defaultToolFactory`
   thật (§3.4).
4. Lần 1 §6: "không thấy `grok-4.7`" — **vẫn đúng** ở bản 0.79.3 này
   (chỉ thấy `grok-4.5` ×2, `grok-4.6` ×1 trong ASAR; 176 chuỗi `grok-`
   còn lại là `grok-bot`/…).

## 15. Giới hạn của đợt đào sâu này

- **Chỉ tĩnh, không chạy app** (giữ nguyên giới hạn lần 1 §8). Mọi luồng
  chạy (đăng nhập thật, gọi API thật, agent thực thi, voice call thật)
  vẫn là suy luận từ chuỗi/tên symbol.
- **IPC không liệt kê đủ:** channel minify thành biến — cần giải minify
  hoặc quan sát runtime mới đủ.
- **Schema Args của tool:** chỉ đọc được field `args`/`result` ở tầng
  `*ToolCall`; field chi tiết trong message `*Args` chưa trích được
  bằng grep (tên message con đã minify). `rea
  analyze-javascript-application` đã timeout ở file `main-app.cjs`
  (§1.1) nên không cho thêm graph — muốn schema Args đầy đủ thì chạy lại
  lệnh đó với `--source-path` trỏ riêng `proto.cjs` (file nhỏ hơn nhiều)
  hoặc tăng `--analysis-timeout-ms`.
- **Trigger automation:** chỉ chắc chắn `cron` + `webhook`; các literal
  khác (`temporal`, `slack`, `github`…) chưa gắn được vào trigger union.
- **Logic server không có trong installer** (giữ nguyên): model routing,
  quota/giá, kiểm duyệt, phần lớn nghiệp vụ `GrokBotService` (392 RPC)
  nằm ở `api2.cursor.sh`.
- **Không kiểm tra lỗ hổng bảo mật** của sandbox/computer-use/vault ngoài
  mô tả khái niệm.
- **Một phiên bản duy nhất:** chỉ đúng cho Grok Bot 0.79.3 (build
  2026-11-06).
- **Chữ ký số PE chưa xác minh signer** (giữ nguyên từ lần 1).

## 16. Phụ lục — đường dẫn & lệnh đã chạy

- Installer: `~/tools/grokbot/Grok_Bot_0.79.3_Setup.exe`
  (SHA-256 đã khớp lần 1: `5dede0efa229dfb7d1b6c251edf4a7a19225df6837bccc7e09d1193de5766846`).
- ASAR đã trích: `~/tools/grokbot/asar-src/` (921 file); NSIS đã giải nén:
  `~/tools/grokbot/extracted/`.
- File nguồn chính: `asar-src/dist/electron-main/proto.cjs`
  (tool descriptor + service), `main-app.cjs` (main logic),
  `main-core.cjs` (boot/update), `preload.cjs`,
  `dist/local-exec-daemon/main.cjs`, `dist/node-agent-coordinator/main.cjs`,
  `dist/renderer/assets/index.eager-app-*.js` (+ `chunk-chat-*`,
  `chunk-core-*`).
- Lệnh xác minh tool: `source ~/.bashrc; rea doctor` → healthy: true
  (sau khi `bash ~/tools/reinstall-system-tools.sh` khôi phục VM bị thay
  mới giữa chừng); `rea --version` → 6.8.0; `rizin -v` → 0.9.1.
- Lệnh REA: `rea analyze-javascript-application
  ~/tools/grokbot/asar-src --json` — **timeout sau ~10 phút**
  (`provider_timeout`, trần 300.000 ms, kẹt ở `main-app.cjs` file 78/737);
  Evidence từng phần đã lưu tại
  `~/workspace/rea-evidence/rea-js-app-partial-20261109.json`
  (evidence_id `ev_6b8e5a2db7ef1be1bc00bad0f8d4b25a460c35590bbe09c16a5bc039f3be1ebd`,
  xem §1.1); chạy lại bằng `--analysis-timeout-ms` lớn hơn hoặc
  `--source-path` chọn file.
- Lệnh Rizin: `rizin -qc 'iE; ii; il; q' <file.node>` trên 4 file
  `.node` (§11).
- Đếm tool: `grep -oh '"[A-Za-z0-9]*ToolCall|' proto.cjs | sort -u`
  → 76; `node -e` trên `packages/tools/dist/index.js` → 131 tên duy nhất.
- Nguồn web (chỉ docs/bài công khai):
  `https://modelcontextprotocol.io/specification/2025-11-25/changelog`
  (qua search), `https://code.claude.com/docs` (qua search tổng hợp),
  `https://morrison-lab.github.io/wai/chapters/agent-architecture.html`,
  `https://medium.com/ml2vec/a-developers-guide-to-building-agents-52a8fe51b632`,
  `https://opendatascience.com/ai-agent-orchestration-frameworks-github/`,
  `https://github.com/trwilcoxson/claude-skills/blob/HEAD/skills/agentic-ai-requirements/references/framework-comparison.md`,
  `https://github.com/chingjustwe/chingjustwe.github.io/blob/HEAD/_posts/2026-04-11-agent-framework-comparison-en.md`.
- Tài liệu open-bot đã đối chiếu: `docs/GROK-BOT-ANALYSIS.md`,
  `docs/BEYOND-ROADMAP.md`, `docs/research-mcp-2025-11.md`,
  `packages/tools/src/tools.ts` (`MAX_TOOL_RESULT_CHARS`),
  `packages/core/src/voice/{types,realtime,memo}.ts`,
  `packages/core/src/automations/{types,engine,scheduler,dream}.ts`,
  `packages/core/src/mcp/{client,server,oauth}.ts`,
  `packages/tools/src/{mcpTools,mcpSystemTools}.ts`,
  `packages/core/src/coordinator/coordinator.ts` (`defaultToolFactory`).
