# Kế hoạch triển khai 4 khoảng trống ưu tiên — open-bot

Ngày audit: 2026-11-09. Cơ sở: đọc code thật trong repo (không đoán), các
dòng `file:line` dưới đây đã kiểm chứng bằng `grep`/đọc file.
Phạm vi: chỉ audit + viết kế hoạch này. Không sửa code, không commit/push,
không cần API key, không kết nối live tới x.ai.

Trạng thái chung đã xác nhận trước khi đi vào từng mục:

- Repo ở v0.2.0/v0.8 (ROADMAP 140/140 đã xong local, chưa push GitHub).
- Không có CI: không có thư mục `.github/`; test chỉ chạy trên Linux
  (`docs/TESTING.md`: "Linux VM, Node v24.22.1").
- `packages/core/package.json` yêu cầu `node >= 24`; test chạy bằng
  `node --test` (file `tests/*.test.mjs`, root `package.json`).
- Đã có sẵn 2 mẫu out-of-process để tái dùng: coordinator
  (`packages/core/src/coordinator/client.ts`, spawn + NDJSON-RPC qua stdio)
  và exec daemon (`packages/tools/src/daemon/client.ts`, cùng mẫu).

Thứ tự đề xuất: **1 → 2 → 3 → 4** (1 mở khóa điều khiển run từ xa cho
mọi client API; 2 sửa lỗi token hết hạn âm thầm; 3 là thay đổi kiến trúc
lớn nhất; 4 là hạ tầng test đi kèm cả 3 mục trên).

---

## 1. WS control messages — stop/cancel run, trả lời approval/ask-user qua WebSocket

### 1.1. Hiện trạng (đã xác nhận bằng code)

**WS server ở đâu, message format hiện tại:**

- Server: `packages/core/src/api/server.ts` — WebSocket framing RFC 6455
  viết tay, không dependency (`server.ts:26-29,82-118`).
- Endpoint duy nhất: `GET /v1/bots/:id/run/stream?text=...`
  (`server.ts:12-16,503-590`). Auth Bearer + `X-Open-Bot-Team` kiểm tra
  **trước** handshake 101 (`server.ts:545-560`).
- Server → client: JSON `{ kind, data }` một message một event, kind ∈
  `delta | toolcall | toolresult | summary | error`
  (`packages/core/src/api/types.ts:36-44`, `server.ts:454-502`
  `startStreamRun`). Hết run thì đóng 1000, lỗi thì event `error` + đóng
  1011.
- Client → server: **không có gì**. `WsConnection` parse được frame
  client nhưng handler bỏ qua toàn bộ
  (`server.ts:569-575`: `onMessage: () => { /* ignored */ }`, kèm comment
  "the stream endpoint is server -> client only"). Đóng socket cũng
  không dừng run: "A client that disconnects early stops receiving
  events, but the run still finishes in the background"
  (`server.ts:445-453`).
- Giới hạn khung: 1 MB/message, quá thì đóng 1009
  (`server.ts:55-56`); binary frame bị từ chối 1003; ping → pong.

**Agent run loop có hỗ trợ abort không — có một nửa:**

- `AgentRunner` nhận `signal?: AbortSignal` và forward cho tool qua
  `ctx.signal` (`packages/core/src/agent/loop.ts:29-30,157`).
- **Nhưng:** (a) `run()` không kiểm tra `signal.aborted` giữa các bước
  (không có `throwIfAborted` nào trong `loop.ts`); (b) `Provider.chat()`
  không nhận signal — `ChatCompletionRequest`
  (`packages/core/src/types.ts`) không có trường signal, và provider
  OpenAI-compatible chỉ dùng `AbortSignal.timeout(timeoutMs)` nội bộ
  (`packages/core/src/providers/openaiCompatible.ts:169`). Kết quả: một
  `provider.chat()` đang bay không thể bị hủy từ ngoài.
- Coordinator đã có stop theo bot: `stopBot()` abort controller của run
  đang chạy + hủy run đang xếp hàng (`packages/core/src/coordinator/
  coordinator.ts:1251-1272`, `cancelQueuedRuns` ở `:1129-1152`), và tự
  thừa nhận trong comment `:1262-1265` là "an in-flight provider.chat()
  is not cancelled by the runner — the run may still finish".
  `stopBot` đã có trong RPC dispatch (`coordinator.ts:941-942`) và
  client `CoordinatorClient.stopBot()` (`client.ts:252-254`).
- **Nhưng** stop chỉ có粒度 theo bot, không theo run: `run()` không trả
  `runId` cho caller (`coordinator.ts:1090-1100`, `RunParams` ở
  `coordinator/types.ts:198-208` không có `runId`), nên 2 run song song
  của cùng bot (cho phép bởi `maxConcurrentRuns`, v0.8 parallel runs)
  không thể dừng riêng lẻ. Và Local API server **không expose stop**:
  không có `POST /v1/bots/:id/stop` hay `DELETE /v1/runs/:id`.

**Approval flow đi qua kênh nào:**

- Loop gọi `events.onApprovalNeeded(call)` / `events.onAskUser(...)`
  (`loop.ts:117-121,185-196`); coordinator giữ 2 map chờ trả lời
  (`coordinator.ts:523-525` `pendingApprovals` / `pendingAskUser`),
  emit event `approval-needed` / `ask-user`, chờ tối đa 10 phút rồi
  mặc định từ chối / trả `''` (`coordinator.ts:126`, `:1176-1210`).
  Trả lời qua RPC `respondApproval` / `respondAskUser`
  (`coordinator.ts:951-954,1274-1300`).
- Main process đã nối sẵn kênh này cho **renderer**: `routeCoordinatorEvent`
  (`apps/desktop/src/main/main.ts:907-945`) forward `approval-needed` /
  `ask-user` về renderer qua IPC, nhận lại qua
  `chat:approval-response` / `chat:ask-user-response`
  (`main.ts:2424-2441`); đồng thời bắn webhook `approval.needed`.
- **Nhưng** handler `runBotStream` của main lọc event của run WS chỉ còn
  4 kind `delta | toolcall | toolresult | summary`
  (`main.ts:503-540`, bộ lọc ở `:517-527`) — `approval-needed` và
  `ask-user` vẫn tới renderer qua kênh global, nhưng **WS client không
  bao giờ thấy chúng và không có đường nào để trả lời**. Main còn ghi rõ
  ở `:505-507`: "run qua WS không trả lời được approval/ask-user — chỉ
  dùng cho bot autoApprove hoặc run không cần duyệt; nếu cần duyệt, run
  chờ tới timeout của coordinator rồi đóng socket bằng lỗi". Tức là
  hiện tại WS + approval = treo tới 10 phút rồi lỗi.
- Test hiện có: `tests/api-v08.test.mjs:89-180` (WS happy path, fallback,
  lỗi, auth trước upgrade; helper `connectStream` chỉ gửi, không nhận
  control message).

### 1.2. Vấn đề

1. WS là một chiều: không stop/cancel được run, không trả lời được
   approval/ask-user — đúng 2 thao tác mà client API từ xa cần nhất.
2. Không có định danh run phía client: `runId` chỉ tồn tại trong map
   nội bộ của server (`server.ts:454-460`), không gửi cho client, không
   có API stop theo run.
3. Stop hiện tại là best-effort yếu: abort chỉ tới được tool
   (`ctx.signal`), không tới được `provider.chat()` đang bay, và loop
   không kiểm tra abort giữa các step — stop có thể "treo" tới hết
   timeout của provider rồi mới dừng.
4. Đóng socket không dừng run (chạy nền tiếp, tốn token/tiền) — hành vi
   này hiện là mặc định không có cách nào đổi.

### 1.3. Thiết kế đề xuất

**Protocol (giữ tương thích ngược: client cũ chỉ nghe vẫn chạy):**

- Server → client, thêm 3 kind mới vào `ApiStreamEventKind`
  (`api/types.ts:36`):
  - `{ kind: 'run-started', data: { runId } }` — gửi ngay sau handshake,
    trước mọi event khác. Client dùng `runId` này cho mọi control message.
  - `{ kind: 'approval-needed', data: { callId, call } }` — y hệt payload
    coordinator đã emit (`coordinator.ts:1180`).
  - `{ kind: 'ask-user', data: { requestId, question, options? } }` —
    y hệt payload (`coordinator.ts:1196-1198`).
  - `{ kind: 'stopped', data: { runId, reason? } }` — gửi khi run bị
    dừng bởi control message / socket đóng (trước khi đóng 1000).
  - Giữ nguyên `summary` cuối run; run bị stop thì `ApiRunRecord.status`
    thêm `'stopped'` (hiện chỉ có `running | done | error`,
    `api/types.ts:21-30`) để `GET /v1/runs/:id` phân biệt được.
- Client → server, JSON `{ type, ... }`, parse trong `WsConnection`
  `onMessage` (hiện đang bỏ qua, `server.ts:569`):
  - `{ type: 'stop' }` / `{ type: 'cancel', runId? }` — dừng run của
    socket này (mặc định) hoặc run chỉ định.
  - `{ type: 'approval-response', callId, approved: boolean }`.
  - `{ type: 'ask-user-response', requestId, answer: string }`.
  - Message sai định dạng / `callId` không tồn tại → gửi lại event
    `{ kind: 'error', data: { error } }` nhưng **không đóng socket**
    (lỗi control message không phải lỗi run); message không phải JSON →
    đóng 1007/1002 như hiện tại. Giới hạn 1 MB giữ nguyên.
- **Auth/quyền:** control message chỉ được phép từ chính socket đã
  xác thực tạo ra run đó (cùng Bearer token + team đã check ở handshake).
  Không cho WS client dừng run của socket khác, không cho trả lời
  approval của bot khác: server kiểm tra `runId`/`callId` thuộc về run
  của socket này, sai thì trả `error` event, không thực thi.

**Luồng stop đi qua các lớp (theo thứ tự):**

1. `server.ts` — `startStreamRun` tạo một `AbortController` riêng cho
   stream run; `onMessage` `stop` → `controller.abort()`; socket đóng →
   abort luôn (đổi mặc định: đóng socket = hủy run; xem mục "quyết định
   cần chốt" dưới). `run.status` → `'stopped'`, emit event `stopped`,
   đóng 1000.
2. `ApiHandlers` (`api/types.ts:57-73`) — thêm tham số tùy chọn vào
   `runBotStream`: `(botId, text, emit, opts?: { signal?: AbortSignal })`
   và 3 handler tùy chọn `stopRun?(runId)`, `respondApproval?`,
   `respondAskUser?` — hoặc gọn hơn: handler `runBotStream` trả về
   `{ text, runId }` kèm controller. Chọn cách **thêm `opts.signal` +
   3 handler riêng** để `server.ts` không cần biết coordinator.
3. Main (`main.ts:503-540`) — `runBotStream` truyền `signal` xuống
   `getCoordinator().run(...)`; bỏ bộ lọc 4 kind, forward thêm
   `approval-needed` / `ask-user` qua `emit`; `stop` → gọi
   `coordinator.stopBot(botId)` (bước đầu) hoặc `stopRun(runId)` mới
   (bước sau, xem dưới); `approval-response` / `ask-user-response` →
   `coordinator.respondApproval/respondAskUser` (đã có sẵn,
   `client.ts:257-264`).
4. Coordinator — thêm `runId` vào `RunParams` (`coordinator/types.ts:
   198-208`, sinh bằng `randomUUID()` ở `run()` nếu caller không đưa),
   lưu map `runId → entry/controller`; thêm RPC `stopRun({ runId })`
   (bên cạnh `stopBot` theo bot) để dừng đúng một run khi bot chạy
   song song. `RunResult` đã có `stopped: boolean` — giữ nguyên.
5. Hủy thật provider call đang bay (phần khó nhất, làm sau bước 1-4):
   thêm `signal?: AbortSignal` vào `ChatCompletionRequest`
   (`core/src/types.ts`); `AgentRunner.run()` kiểm tra
   `signal.throwIfAborted()` ở đầu mỗi step và trước mỗi
   `provider.chat()`; 3 provider (`openaiCompatible.ts`,
   `anthropic.ts`, `gemini.ts`) hợp nhất signal ngoài với timeout nội
   bộ bằng `AbortSignal.any([AbortSignal.timeout(ms), req.signal])`
   (Node ≥ 24 có `AbortSignal.any` — kiểm chứng khi làm). Bắt
   `AbortError` ở loop → kết thúc run với text `'đã dừng'` /
   `stopped: true`, không tính là lỗi provider. Lưu ý: `AbortSignal.
   timeout` hiện tại ở `openaiCompatible.ts:169` phải giữ nguyên hành vi
   timeout (lỗi rõ ràng, không biến thành "đã dừng") — phân biệt bằng
   cách kiểm tra `req.signal.aborted` trước khi map lỗi.

**Quyết định cần chốt trước khi code (ghi vào plan, hỏi Huy/main agent
nếu cần):** socket đóng có hủy run không? Đề xuất: **có, mặc định hủy**,
vì client WS thường là "người đang xem run đó"; run HTTP
(`POST /v1/bots/:id/run`) giữ nguyên chạy nền. Nếu cần run nền qua WS
thì thêm flag `{ type: 'detach' }` hoặc query `?detach=1` ở handshake
sau này — không làm trong đợt này.

### 1.4. Các bước làm

1. `api/types.ts`: thêm kind `run-started | approval-needed | ask-user |
   stopped` vào `ApiStreamEventKind`; thêm `'stopped'` vào
   `ApiRunRecord.status`; thêm `opts.signal` + handler stop/respond vào
   `ApiHandlers`.
2. `api/server.ts`: `WsConnection` gọi `onMessage` thật (parse JSON,
   validate shape, giới hạn 1 MB đã có); `startStreamRun` tạo
   `AbortController`, gửi `run-started`, xử lý stop/đóng socket → abort
   + event `stopped` + status `stopped`; map `runId → { controller,
   botId }` để chặn control message lạ run.
3. `main.ts` `runBotStream`: bỏ bộ lọc 4 kind, forward thêm
   approval/ask-user; nối 3 control message xuống coordinator; xóa
   comment ở `:505-507` khi xong (nó sẽ sai sau khi làm).
4. `coordinator/types.ts` + `coordinator.ts`: `RunParams.runId`,
   map runId, RPC `stopRun`; `client.ts`: `stopRun(runId)`.
5. `core/src/types.ts` + `agent/loop.ts` + 3 provider: signal xuyên
   suốt tới `fetch` của provider; loop kiểm tra abort mỗi step.
6. Docs: cập nhật header `server.ts:12-16` (mô tả protocol 2 chiều) và
   `docs/ARCHITECTURE.md` (mục Local API/WS nếu có).

### 1.5. Test cần thêm

- Mở rộng `tests/api-v08.test.mjs` (dùng lại helper `connectStream`
  ở `:89-122`, mock `runBotStream`): nhận `run-started` đầu tiên;
  gửi `stop` giữa run mock có delay → nhận `stopped`, socket đóng
  1000, run record `stopped`; đóng socket giữa run → run bị hủy
  (mock ghi nhận signal aborted); gửi `approval-response` /
  `ask-user-response` với `callId`/`requestId` đúng → run tiếp tục
  và hoàn tất; gửi `callId` lạ → event `error`, socket vẫn mở, run
  không bị ảnh hưởng; gửi message không phải JSON → đóng lỗi, run
  bị hủy.
- Test loop/provider (mới, `tests/ws-control.test.mjs` hoặc thêm vào
  `tests/coordinator.test.mjs`): mock provider delay dài + abort giữa
  `chat()` → run kết thúc nhanh với `stopped: true`, không chờ hết
  timeout; abort giữa 2 step → không gọi provider lần nữa.
- Test `stopRun` theo runId: 2 run song song cùng bot, stop 1 → run
  còn lại chạy tiếp (cần `maxConcurrentRuns ≥ 2` trong test).

### 1.6. Độ khó

- **M** cho control message + approval/ask-user qua WS + stop theo run
  (bước 1-4; toàn bộ hạ tầng `pendingApprovals`/`respondApproval` đã
  có sẵn, chỉ thiếu đường nối).
- **L** nếu tính cả hủy thật provider call đang bay (bước 5: chạm
  `Provider` interface — contract chung của `core/src/types.ts` — và cả
  3 provider + loop; cần kiểm chứng `AbortSignal.any` và hành vi
  timeout của từng provider).

---

## 2. OAuth auto-refresh cho integrations (Slack / Gmail / Teams)

### 2.1. Hiện trạng (đã xác nhận bằng code)

**Cái đã có (chỉ dùng cho MCP OAuth, không dùng cho integrations):**

- `packages/core/src/connectors/framework.ts:246-290` đã có
  `refreshAccessToken()` (grant `refresh_token`, delegate sang
  `mcp/oauth.ts:473`) và `getValidAccessToken()` — đọc `TokenSet` từ
  store, nếu còn hạn > 60 giây thì dùng tiếp, nếu hết hạn và có
  `refreshToken` thì refresh rồi **ghi lại vào store**, giữ lại refresh
  token cũ khi provider không rotate (`:279-288`). `TokenSet` có đủ
  `accessToken / refreshToken / expiresAt (ISO) / tokenType / scope`
  (`framework.ts:100-113`).
- `vaultTokenStore()` (`framework.ts:370-398`): lưu `TokenSet` JSON vào
  Vault namespace `connector`, key = connector id.
- `mcp/oauth.ts:568-594` có `getValidAccessToken` tương tự cho MCP
  server (skew 60 s, `OAUTH_EXPIRY_SKEW_MS`, `:40`), và hàm này
  **đang được dùng thật** — re-export qua `mcpSystemTools.ts:40,376`.
- Ngược lại, `getValidAccessToken` của **connectors framework chỉ được
  export** ở `core/src/index.ts:203` (`getValidConnectorAccessToken`)
  và **không có caller nào** trong repo (grep toàn repo: 0 lượt dùng).

**Cái chưa có — integrations đang dùng token trần, không refresh:**

- 3 connector đều nhận `getToken: () => string | null`
  (`connectors/slack.ts:55`, `email.ts:44`, `teams.ts:42`) — chỉ trả
  access token dạng chuỗi, không có `expiresAt`, không có refresh token,
  không có `clientId`/`clientSecret`.
- Call site đều ném lỗi chung khi HTTP không ok, **không phân biệt 401**,
  không retry: `slackCall` (`slack.ts:95-100`), `gmailCall`
  (`email.ts:73-100`), `graphCall` (`teams.ts:72-100`) — lỗi chỉ ghi
  `HTTP ${status}`, không echo body (đúng về bảo mật, nhưng 401 bị xử
  lý như mọi lỗi khác).
- `packages/tools/src/integrationTools.ts:180-200`: `resolveToken()` chỉ
  gọi callback lấy chuỗi token rồi đưa thẳng cho connector; không kiểm
  tra hạn, không refresh.
- Host (main) là nơi duy nhất chạm Vault cho integrations, và nó tự
  thú nhận: `apps/desktop/src/main/main.ts:1108-1125`
  `connectorAccessTokens()` parse `TokenSet` JSON từ Vault rồi **chỉ
  lấy `accessToken`, bỏ `expiresAt`/`refreshToken`**, kèm comment
  `:1105-1106`: "Token hết hạn không tự refresh ở đây — refresh cho
  integration là việc của milestone sau." Token này còn là **snapshot
  tĩnh lúc `createBot`** (`main.ts:1157`, coordinator merge ở
  `coordinator.ts:1003-1004` thành `this.connectorTokens`, tool đọc qua
  `getConnectorToken` đồng bộ ở `:596-597`) — token refresh sau đó
  không tới được tool đang chạy nếu không tạo lại bot.
- Login OAuth của user (Google) cũng chỉ lưu refresh token, chưa từng
  dùng lại: `main.ts:1290` ghi `vault.setSecret('oauth-refresh',
  providerId, refreshToken)`; grep `oauth-refresh` toàn repo chỉ thấy
  ghi + audit, **không có chỗ nào đọc lại để refresh**
  (`auth/oauth.ts:13` mô tả đúng thiết kế này nhưng không có hàm
  refresh nào cho nó; `exchangeCodeForTokens` ở `auth/oauth.ts:230-282`
  chỉ đổi code, không có grant refresh).
- Định nghĩa connector đã có đủ `tokenUrl` để refresh:
  Slack `connectors/slack.ts` (`tokenUrl:
  https://slack.com/api/oauth.v2.access`), Gmail `connectors/email.ts:
  27-32` (`tokenUrl: https://oauth2.googleapis.com/token`), Teams
  `connectors/teams.ts` (`tokenUrl:
  https://login.microsoftonline.com/common/oauth2/v2.0/token`).
  Nhưng **không có `clientId`/`clientSecret` nào được lưu cho 3
  connector này** (chỉ có login Google lưu ở Vault namespace
  `oauth-client`, `main.ts:1247-1267`) — refresh cần client credentials,
  hiện chưa có chỗ nhập/lưu cho Slack/Gmail/Teams.
- Test hiện có: `tests/connectors-v07.test.mjs` dùng mock fetch, không
  có case hết hạn/refresh/401.

**Lưu ý theo provider (cần tôn trọng khi thiết kế):**

- Gmail/Google và Teams/Microsoft: refresh token chuẩn OAuth2, rotate
  hoặc giữ nguyên tùy provider — dùng chung `refreshAccessToken` được.
- Slack: bot token `xoxb` **không hết hạn, không có refresh token** —
  refresh chỉ áp dụng cho user token `xoxp` có rotation bật. Thiết kế
  phải cho phép "không refresh được" là trạng thái hợp lệ, không báo
  lỗi giả.

### 2.2. Vấn đề

1. Token hết hạn → mọi tool Slack/Gmail/Teams lỗi 401 cho tới khi user
   kết nối lại thủ công; không có cơ chế nào tự phục hồi.
2. Hàm refresh đã viết sẵn (`framework.ts:267`) nhưng không ai gọi —
   lãng phí và dễ gây hiểu lầm là "đã có auto-refresh".
3. Kiến trúc chặn refresh: token là chuỗi tĩnh snapshot lúc `createBot`,
   tool chạy ở **tiến trình coordinator con** (không có Vault), callback
   `getConnectorToken` là đồng bộ — không có đường nào để tool xin token
   mới từ main khi cần.
4. Thiếu client credentials cho integrations nên dù có gọi refresh cũng
   không đủ tham số (thiếu `clientId`, có provider cần `clientSecret`).
5. Không phân biệt 401 do hết hạn (refresh được) với 401 do bị revoke
   (`invalid_grant`, phải đăng nhập lại) — retry mù sẽ spam token
   endpoint và che lỗi thật.

### 2.3. Thiết kế đề xuất

**Nguyên tắc:** refresh **trước khi hết hạn** (proactive) + **retry 401
một lần** (reactive); refresh là trách nhiệm của **main process**
(nơi duy nhất có Vault + client secret); coordinator con chỉ xin token
tươi qua RPC, không bao giờ cầm refresh token hay client secret.

**Tầng core (`connectors/framework.ts`, sửa ít nhất):**

- Dùng lại `getValidAccessToken()` đã có, nhưng sửa 2 điểm:
  - Ngưỡng refresh nới từ 60 s lên **5 phút** (`REFRESH_BEFORE_MS =
    5*60_000`): tránh trường hợp token còn 61 s, gọi API chậm là hết
    hạn giữa chừng. Giữ 60 s làm floor khi `expiresAt` không có độ
    chính xác cao.
  - Thêm **dedup refresh đang bay**: một `Map<connectorId, Promise>`
    — 5 tool gọi cùng lúc khi token hết hạn chỉ tạo 1 request refresh.
    Promise lỗi thì xóa khỏi map để lần sau thử lại.
- Thêm `TokenProvider` interface mới (để không phá signature cũ):
  ```ts
  interface ConnectorTokenProvider {
    getAccessToken(connectorId: string, opts?: { forceRefresh?: boolean }): Promise<string | null>;
  }
  ```
  và hàm `withAutoRefresh(fetchFn, provider, ...)` hoặc sửa trực tiếp
  3 hàm `slackCall`/`gmailCall`/`graphCall` theo cùng một mẫu:
  1. Lấy token qua provider (đã refresh trước nếu sắp hết).
  2. Gọi API; nếu **401** → gọi `provider.getAccessToken(id,
     { forceRefresh: true })` rồi **retry đúng 1 lần** với token mới.
  3. Nếu vẫn 401 → ném lỗi phân loại `TokenExpiredError` /
     `TokenRevokedError` (phân biệt bằng body `error: invalid_grant`
     khi đọc được, hoặc sau retry vẫn 401) để UI báo "kết nối lại"
     thay vì "lỗi mạng".
  4. Không retry lỗi khác 401; không retry khi request là POST gửi tin
     đã qua bước... (ngoại lệ: POST gửi tin retry 1 lần vẫn có nguy cơ
     gửi trùng — Slack/Gmail/Graph đều không idempotent ở đây; ghi rõ
     trong doc: retry chỉ áp dụng cho GET, còn POST thì chỉ refresh
     trước khi gửi và **không retry sau 401** nếu không chắc chắn chưa
     gửi thành công. Đây là quyết định an toàn hơn là tiện.)
- Token không có `expiresAt` (token trần kiểu cũ, Slack `xoxb`):
  coi là không hết hạn, dùng tiếp, không refresh — migration không bắt
  buộc.

**Tầng main (`apps/desktop/src/main/main.ts`):**

- Lưu client credentials cho từng connector: mở rộng namespace Vault
  `oauth-client` đã dùng cho login Google (`main.ts:1247-1267`) thành
  key `<connectorId>` / `<connectorId>-secret`; UI Settings →
  Connectors thêm ô nhập client id/secret cho Slack/Gmail/Teams (dùng
  lại UI login OAuth đã có). Không có client id → connector ở trạng
  thái "kết nối bằng token tĩnh, không auto-refresh", báo rõ trong UI.
- Thay `connectorAccessTokens()` snapshot (`main.ts:1108-1125`) bằng
  `getConnectorTokenProvider()` trả về `ConnectorTokenProvider` dùng
  `vaultTokenStore` + `getValidAccessToken` của framework; `createBot`
  không snapshot token nữa mà truyền provider này xuống.
- **Đường RPC mới** (vì coordinator con không có Vault): thêm
  `CoordinatorMethod 'connector.getToken'` — child gọi khi tool cần
  token, main thực hiện refresh (nếu cần) rồi trả **chỉ access token**
  về; refresh token/client secret không bao giờ qua IPC. `coordinator.
  ts:596-597` `getConnectorToken` đổi từ đọc map tĩnh thành gọi RPC
  này (async — cần đổi signature `ToolFactoryHost.getConnectorToken`
  thành `Promise<string | null>`, và 3 connector `getToken` vốn đã
  async nên khớp). Cache ngắn ở child: access token vừa lấy được cache
  tối đa 60 s để không RPC mỗi lần gọi tool.
- Lộ trình 2 giai đoạn để không phải làm RPC ngay: **Giai đoạn 1**
  (làm trước): refresh chủ động ở main — trước mỗi `createBot` và theo
  timer mỗi 5 phút, main refresh mọi token sắp hết rồi mới snapshot như
  cũ; cộng retry-401 ở tầng connector bằng token đã refresh sẵn.
  **Giai đoạn 2**: RPC `connector.getToken` như trên, bỏ snapshot.
  Giai đoạn 1 đủ để hết lỗi 401 trong đa số ca dùng (run ngắn), giai
  đoạn 2 mới đúng cho run dài/automation.

### 2.4. Các bước làm

1. `connectors/framework.ts`: thêm `REFRESH_BEFORE_MS`, dedup map,
   `ConnectorTokenProvider`, sửa `getValidAccessToken` dùng ngưỡng mới.
2. `connectors/slack.ts` / `email.ts` / `teams.ts`: đổi `getToken`
   thành nhận provider (giữ backward-compat: vẫn chấp nhận callback
   chuỗi cũ cho test), thêm retry-401-một-lần cho GET, lỗi phân loại
   `invalid_grant`.
3. `tools/src/integrationTools.ts`: `resolveToken()` nhận provider
   thay vì chuỗi tĩnh; truyền `forceRefresh` khi tool vừa nhận 401.
4. `main.ts`: Vault `oauth-client:<id>` cho 3 connector + UI nhập;
   `getConnectorTokenProvider()`; giai đoạn 1: refresh timer +
   refresh trước `createBot`; giai đoạn 2: RPC `connector.getToken`
   (`coordinator/types.ts`, `coordinator.ts` dispatch,
   `client.ts`, `coordinator.ts:596` đổi sang async RPC + cache 60 s).
5. `auth/oauth.ts`: thêm `refreshTokens()` (grant `refresh_token`)
   dùng chung cho login Google, hoặc ghi rõ là login Google dùng
   `framework.refreshAccessToken` thay vì viết mới — tránh 2 bộ refresh
   song song. (Hiện `auth/oauth.ts` không có hàm refresh nào.)
6. Docs: `docs/ARCHITECTURE.md` + comment ở `main.ts:1105-1106` (xóa
   khi xong).

### 2.5. Test cần thêm

- `tests/connectors-v07.test.mjs` (mở rộng) + file mới
  `tests/connector-refresh.test.mjs` (mock fetch, không live):
  - Token còn hạn > 5 phút → không gọi token endpoint.
  - Token hết hạn / còn < 5 phút → refresh 1 lần, token mới được lưu
    lại vào store, refresh token cũ được giữ khi provider không rotate,
    refresh token mới được lưu khi provider rotate.
  - 5 lần gọi đồng thời khi hết hạn → chỉ 1 request refresh (dedup).
  - GET gặp 401 → refresh + retry 1 lần thành công; 401 lần 2 → lỗi
    phân loại, không retry lần 3.
  - Token endpoint trả `invalid_grant` → store bị xóa, lỗi báo "kết
    nối lại", không retry.
  - Token trần kiểu cũ / Slack `xoxb` (không `expiresAt`, không
    `refreshToken`) → dùng tiếp, không gọi refresh, không lỗi.
  - RPC `connector.getToken` (test qua `CoordinatorClient` + mock
    main): child không bao giờ nhận được refresh token/client secret
    trong IPC payload.

### 2.6. Độ khó

- **M** cho giai đoạn 1 (dùng lại hàm đã có + retry 401 + UI client id).
- **M+** cho giai đoạn 2 (RPC token từ main xuống coordinator con +
  đổi `getConnectorToken` sang async — chạm `ToolFactoryHost` và 3
  connector, nhưng không đổi `Tool` interface).

---

## 3. Sandbox plugin riêng process (out-of-process)

### 3.1. Hiện trạng (đã xác nhận bằng code)

- Plugin load: `packages/tools/src/plugins/loader.ts` — đọc
  `manifest.json`, validate, quét tĩnh `require`/`import` và capability
  (`loader.ts:10-45`), rồi **`require` entry ngay trong process hiện
  tại** (`loader.ts:387-395`, `createRequire` + `req(entryPath)`).
- Chính repo tự ghi giới hạn này 3 lần: `loader.ts:29-36` ("HONEST
  LIMIT: ... plugins run in-process ... deliberately obfuscated code
  can evade a text scan, and trusted in-process code can always call
  Node APIs directly. Do not load plugins you do not trust. Real
  isolation — a separate plugin process — is wave-2 work"),
  `plugins/types.ts:20-28`, `plugins/manager.ts` (header).
- `PluginManager.unload()` (`manager.ts`) chỉ xóa tool khỏi map —
  code vẫn nằm trong require cache, không thể đuổi ra khỏi bộ nhớ
  ("unload means 'no longer callable', not 'code evicted'").
- Nơi plugin thực sự chạy: **tiến trình coordinator con**, không phải
  main — `coordinator.ts:424-460` `loadPluginTools()` ghi rõ
  "in-process in the child. Plugin tools are functions — they cannot
  cross the RPC boundary, so the child loads them itself". Tức là hiện
  tại plugin đã cách main một process, nhưng **chung process với
  AgentRunner, BotMemory (SQLite), toàn bộ tool core, provider keys và
  token đã load trong coordinator**. Một plugin lỗi có thể: vòng lặp vô
  hạn (treo run), ăn hết RAM (OOM kill cả coordinator → mọi bot chết),
  `process.exit()` (giết coordinator), ghi đè global/prototype làm bẩn
  tool khác, đọc `process.env` / bộ nhớ (key/token của bot khác).
- Chưa có `worker_threads` hay `child_process.fork` nào trong repo
  (grep: 0). Chỉ có `spawn` thường: coordinator client
  (`core/src/coordinator/client.ts:79`), exec daemon
  (`tools/src/daemon/client.ts:70`), shell (`tools/src/sandbox.ts:208`).
- Cái đã có để tái dùng:
  - Mẫu NDJSON-RPC qua stdio + request/response map theo `id` +
    timeout + fail-all-pending khi child chết: `coordinator/client.ts`
    (đặc biệt `:79-120` spawn, `:252-264` RPC, exit handler) và
    `daemon/client.ts:60-130`.
  - `runShell` (`sandbox.ts:147-265`): timeout, kill cả process group
    (POSIX `process.kill(-pid)`, `:199`), env allowlist `safeEnv()`
    (`:130-158`, chặn `*KEY|*TOKEN|*SECRET...*`), `windowsHide`.
  - `Tool` interface (`core/src/types.ts`): `execute(args, ctx)` trả
    `Promise<string>` — đã là async nên có thể thay body bằng IPC mà
    không đổi interface; `ToolContext` có `workspaceDir, botId, signal,
    runSubagent, subagentStatus` — lưu ý `runSubagent`/`subagentStatus`
    là function, **không serialize qua IPC được** (xem §3.3).
  - Truncate output 20_000 ký tự đã có ở `wrapPluginTool`
    (`loader.ts`, `MAX_PLUGIN_TOOL_OUTPUT_CHARS`).

### 3.2. Vấn đề

1. Không có isolation thật: quét tĩnh chỉ chặn lỗi vô tình, không chặn
   mã cố ý (repo tự thừa nhận).
2. Một plugin lỗi = cả coordinator chết = mọi bot + mọi run đang chạy
   chết theo; không có timeout/kill riêng cho từng tool plugin (tool
   core có timeout qua `runShell`, plugin thì không).
3. Không giới hạn bộ nhớ/CPU cho plugin; không có restart/crash policy.
4. `unload`/`disable` không đuổi được code khỏi bộ nhớ; plugin update
   phải restart coordinator mới chắc chắn sạch.

### 3.3. Thiết kế đề xuất

**Chọn `child_process.fork` (không chọn `worker_threads`) — lý do:**

| Tiêu chí | `fork` (chọn) | `worker_threads` |
|---|---|---|
| Cô lập bộ nhớ/heap | Thật (process riêng, OOM chỉ giết plugin) | Chung process, `resourceLimits` chỉ giới hạn được worker heap, OOM vẫn có thể giết cả process |
| Kill/timeout | `SIGKILL` cả process, chắc chắn | `worker.terminate()` thường được nhưng code native/kẹt event loop có thể không dừng sạch |
| Crash containment | Child crash ≠ coordinator crash | Worker crash có thể bắt được, nhưng lỗi native vẫn hạ cả process |
| Chi phí | Nặng hơn (~30-50 MB/process, spawn chậm hơn) | Nhẹ, start nhanh |
| IPC | Kênh `fork` tích hợp (`child.send`, JSON) | `MessagePort`, phải tự nối |

Chọn `fork` vì mục tiêu là **an toàn**, không phải tốc độ; bù chi phí
bằng cách **một process host cho mỗi plugin** (không phải mỗi tool
call spawn mới) và giữ host sống suốt phiên coordinator. Ghi chú:
`worker_threads` có `resourceLimits: { maxOldGenerationSizeMb, ... }`
là ưu điểm duy nhất của nó — với `fork`, giới hạn RAM bằng flag
`--max-old-space-size=<MB>` khi spawn + giám sát RSS từ parent, kill
khi vượt.

**Kiến trúc (3 thành phần, tái dùng mẫu coordinator/daemon):**

1. **Plugin host — tiến trình con** (file mới
   `packages/tools/src/plugins/host.ts`, compile ra
   `dist/plugins/host.js`):
   - Entry nhận `pluginDir` qua argv; tự `loadPlugin(dir)` bằng loader
     hiện tại (giữ nguyên toàn bộ validate/quét tĩnh làm **cửa 1** —
     plugin lỗi vẫn bị chặn trước khi spawn).
   - Lắng nghe IPC: `{ id, method: 'execute', tool, args, ctx }` →
     gọi `tool.execute(args, ctxThuGọn)` → trả `{ id, ok, output }`
     hoặc `{ id, ok: false, error }`. `ctx` qua IPC chỉ còn
     `{ workspaceDir, botId }` (dạng data, không function) — xem lưu ý
     dưới.
   - Chỉ `console.error`/stderr để log; **stdout phải sạch JSON/NDJSON
     hoặc không dùng stdout làm IPC** — dùng kênh IPC của `fork`
     (`child.send`), không dùng stdio, để tránh plugin `console.log`
     làm bẩn protocol (bài học đã có ở coordinator client:
     "child's stdout is NDJSON only").
   - Host tự giới hạn: `process.setMaxListeners`, không load gì ngoài
     plugin + loader; `uncaughtException` → trả lỗi cho request đang
     chờ rồi exit (để parent restart theo policy, không cố chạy tiếp
     trong trạng thái bẩn).
2. **Plugin runner — phía parent** (file mới
   `packages/tools/src/plugins/runner.ts`, chạy trong coordinator):
   - `spawn(process.execPath, ['--max-old-space-size=<MB>',
     hostPath, pluginDir], { stdio: ['ignore','pipe','pipe','ipc'],
     env: safeEnv(), windowsHide: true })` — env dùng lại
     `safeEnv()` của `sandbox.ts` (không secret nào lọt sang).
   - Request/response map theo `id` (copy mẫu `daemon/client.ts`),
     timeout mặc định **30 s** cho mỗi tool call (config được qua
     manifest hoặc `PluginHostOptions.timeoutMs`), quá hạn → `SIGKILL`
     cả process (POSIX: kill group như `sandbox.ts:199`; Windows:
     `child.kill('SIGKILL')` — xem mục 4 về cháu process trên Windows),
     request trả lỗi timeout, host được restart tối đa **3 lần** rồi
     đánh dấu plugin `crashed` (không restart vô hạn), tool trả lỗi
     "plugin đã crash, đã tắt".
   - Giám sát RSS mỗi 1 s qua `process.memoryUsage()` của child
     (đọc từ parent bằng `pid`? Node không có API sẵn — dùng
     `child` + ước lượng qua `--max-old-space-size` làm rào chính,
     cộng watchdog đọc `/proc/<pid>/status` trên Linux và
     `Get-Process` qua `tasklist` trên Windows chỉ khi cần; **không
     làm watchdog phức tạp ở đợt 1** — flag V8 + timeout đã chặn 2
     kiểu lỗi phổ biến nhất).
   - Crash của host (exit code/signal bất ngờ) → fail-all-pending
     (mẫu `daemon/client.ts`), ghi log, restart theo policy.
   - `ping()` định kỳ (mẫu `daemon/client.ts:ping`) để phát hiện host
     treo mà không chết.
3. **Nối vào hệ thống hiện tại:**
   - `PluginManager` (`manager.ts`) thêm chế độ `mode: 'sandboxed' |
     'in-process'` (mặc định `'sandboxed'`; giữ `'in-process'` làm
     escape hatch cho plugin cần `runSubagent` hoặc debug). `load()`
     vẫn validate manifest ở parent; `toolsForRegistry()` trả về tool
     đã wrap mà `execute` đi qua runner IPC thay vì gọi trực tiếp.
   - `loadPluginTools()` (`coordinator.ts:424-460`) truyền mode +
     `pluginsDir` xuống; không đổi chữ ký `Tool` nên `AgentRunner`
     không biết plugin đang ở process khác.
   - Truncate 20_000 ký tự giữ ở **parent** sau khi nhận IPC (đề
     phòng plugin trả output khổng lồ làm đầy IPC).

**Giới hạn trung thực của đợt này (phải ghi vào doc, không quảng cáo
quá):** `fork` + IPC chặn được crash / treo / OOM / đọc trộm bộ nhớ
của coordinator / làm bẩn global. Nó **không** chặn được plugin gọi
trực tiếp `node:fs`/`fetch`/`child_process` trong process của chính
nó — plugin vẫn có toàn quyền trên filesystem/mạng **trong process
con**, với env đã stripped và cwd = plugin dir. Muốn chặn cả fs/network
cần **giai đoạn 2** (không làm đợt này): mediation — host chỉ expose
API hẹp qua IPC (`readFile`/`writeFile` qua `resolveWithin` ở parent,
shell qua `runShell`, fetch qua allowlist) và plugin chạy với Node
Permission Model (`--experimental-permission --allow-fs-read=...
--allow-fs-write=...`, Node ≥ 22, còn experimental — phải kiểm chứng
tính ổn định trước khi dựa vào). Quyền `permissions` trong manifest
(`fs/shell/network/mcp`) khi đó mới thành **enforced**, hiện tại vẫn
chỉ là khai báo + quét tĩnh.

**Lưu ý `ToolContext` qua IPC:**

- `runSubagent` / `subagentStatus` là function — không qua IPC được.
  Plugin tool nào gọi chúng sẽ nhận `undefined` → trả lỗi rõ ràng
  "không hỗ trợ trong sandbox". Kiểm chứng: grep cho thấy chỉ tool
  core dùng `runSubagent`, plugin mẫu (`tests/fixtures/sample-plugin`)
  không dùng — chấp nhận được.
- `signal` (AbortSignal) cũng không qua IPC: parent dịch abort thành
  IPC `{ type: 'abort', id }` → host hủy tool call đang chạy (tốt
  nhất có thể: host không hủy được code JS đang chạy đồng bộ, nhưng
  hủy được khi tool đang `await`; nếu host không phản hồi sau 5 s thì
  parent kill process). Đây là điểm yếu cần ghi rõ.

### 3.4. Các bước làm

1. `plugins/types.ts`: thêm `PluginHostOptions { timeoutMs?,
   maxMemoryMb?, mode?: 'sandboxed'|'in-process', maxRestarts? }` và
   ghi rõ giới hạn trung thực mới (fork chặn gì/không chặn gì).
2. `plugins/host.ts` (mới): entry tiến trình con — load plugin bằng
   `loadPlugin()`, vòng IPC execute/ping/abort, stderr log, exit sạch
   khi uncaught.
3. `plugins/runner.ts` (mới): `PluginHostRunner` — spawn fork, map
   request id, timeout + kill, restart tối đa 3 lần, ping, fail-all-
   pending khi crash; implement `Tool.execute` wrapper qua IPC.
4. `plugins/manager.ts`: thêm mode, `toolsForRegistry()` trả tool đã
   qua runner khi sandboxed; `unload()` kill host process tương ứng
   (lần đầu tiên unload thật sự đuổi được code); `disable()` kill host
   luôn để giải phóng RAM.
5. `plugins/loader.ts`: giữ nguyên validate/quét tĩnh (cửa 1); thêm
   export `loadPlugin` dùng được từ host (đã có sẵn, chỉ cần chắc host
   `require` đúng `dist`).
6. `coordinator.ts` `loadPluginTools()`: tạo runner/manager ở chế độ
   sandboxed, truyền `PluginHostOptions` từ `CreateBotParams` (thêm
   field tùy chọn, mặc định timeout 30 s / 256 MB).
7. Build: đảm bảo `host.js` được compile vào `dist/plugins/` và
   `runner` resolve đúng đường dẫn `__dirname` (mẫu
   `daemon/client.ts:70` dùng `path.join(__dirname, 'daemon.js')` —
   copy y hệt, đừng hard-code đường dẫn source).
8. Docs: cập nhật HONEST LIMIT ở `loader.ts:29-36`,
   `types.ts:20-28`, `manager.ts` header.

### 3.5. Test cần thêm

- File mới `tests/plugins-sandbox.test.mjs` (mock plugin thật trong
  `tests/fixtures/`, chạy trên `node --test`):
  - Plugin vòng lặp vô hạn → timeout 30 s (test dùng timeout ngắn
    2 s) → tool trả lỗi timeout, coordinator vẫn sống, gọi lại được.
  - Plugin cấp phát RAM vô hạn (`--max-old-space-size` nhỏ trong
    test, vd 64 MB) → host bị kill, lỗi rõ ràng, không OOM cả test
    process.
  - Plugin `process.exit(1)` / throw ở top-level → coordinator không
    chết, plugin bị đánh dấu crashed sau 3 restart, tool sau đó trả
    lỗi "plugin đã tắt".
  - Plugin ghi đè `globalThis` / `Object.prototype` / đọc
    `process.env` → thay đổi không lọt sang coordinator;
    `process.env` trong host không chứa secret (assert không có key
    chứa `TOKEN|KEY|SECRET`).
  - 2 plugin cùng lúc: một plugin crash không ảnh hưởng plugin còn lại.
  - Plugin bình thường (fixture `sample-plugin`) qua sandbox cho kết
    quả giống hệt in-process (regression: output, truncate 20_000).
  - `unload()` → host process thật sự chết (assert `child.pid`
    không còn), load lại → host mới.
- Giữ nguyên `tests/plugins.test.mjs` cho chế độ in-process (escape
  hatch) — không xóa test cũ.

### 3.6. Độ khó

- **L** cho toàn bộ (spawn + IPC + timeout/kill + restart + nối
  manager/coordinator + test). Phần khó nhất không phải spawn mà là
  **quản lý vòng đời** (restart, fail-all-pending, abort qua IPC) và
  **giữ tương thích** `Tool` interface.
- **M** nếu chỉ làm bản tối thiểu: 1 host/process cho mỗi plugin, IPC
  execute, timeout kill, không restart policy, không ping (bỏ watchdog
  RSS và abort IPC sang đợt sau).
- Giai đoạn 2 (mediation fs/network + Node Permission Model): **L**
  riêng, làm sau, cần kiểm chứng tính ổn định của
  `--experimental-permission` trước.

---

## 4. Test Windows/macOS (hiện chỉ test Linux)

### 4.1. Hiện trạng (đã xác nhận bằng code)

- **Không có CI:** không có `.github/`; `docs/TESTING.md` ghi rõ môi
  trường duy nhất là "Linux VM, Node v24.22.1"; toàn bộ 30+ file
  `tests/*.test.mjs` chạy bằng `node --test` trên Linux. 8 test
  computer-use đã fail khi không có display (ghi trong memory: "without
  a display, 8 computer-use tests fail — environment, not code").
- **Không có packaging:** `apps/desktop/package.json` (Electron
  `^38.0.0`) không có `electron-builder` / `electron-forge` /
  `electron-packager`, không có script build Windows/macOS, `main` chỉ
  là `electron .`. Tức là hiện tại **không thể cài/test bản đóng gói
  trên Win/mac** — chỉ có thể chạy từ source qua `npm run dev`.
- **Code phụ thuộc platform — kiểm kê đầy đủ (grep
  `process.platform|win32|darwin`):**

  | Vùng | File:line | Hành vi theo platform |
  |---|---|---|
  | Shell chạy lệnh | `tools/src/sandbox.ts:175-176,208-212` | Win: `powershell -NoProfile -Command`; khác: `/bin/sh -c`. `detached` (process group riêng) chỉ bật ngoài Windows |
  | Kill process group | `tools/src/sandbox.ts:191-199`, `tools/src/daemon/daemon.ts:104-108,260,401`, `tools/src/shellTools.ts:388,474-478` | POSIX: `process.kill(-pid, 'SIGKILL')`; Windows: chỉ `child.kill('SIGKILL')` — **cháu process trên Windows có thể sống sót** sau kill |
  | Shell mặc định | `tools/src/shellTools.ts:140-148`, `tools/src/tools.ts:290-291` | Win: powershell; khác: `/bin/sh` |
  | Quote shell | `tools/src/tools.ts:64`, `codeTools.ts:72`, `gitTools.ts:108`, `webMedia.ts:168` | Win: `"..."` + strip `"$`` `; POSIX: `'...'` — comment ở `tools.ts` tự thừa nhận quoting PowerShell khác, "accepted for simple values" |
  | Mở file bằng app mặc định | `tools/src/localTools.ts:267-273` | Win: `cmd /c start`; macOS: `open`; Linux: `xdg-open` |
  | Liệt kê process | `tools/src/localTools.ts:334` | Win: `tasklist /FO CSV` (không có ppid/cpu); Unix: `ps` |
  | iMessage | `core/src/connectors/imessage.ts:62-67,102` | Chỉ macOS mới mở Messages thật (`spawnSync('open', ...)`); Win/Linux chỉ ghi file nháp |
  | Computer-use | `tools/src/computerUse.ts:6-7,105,128,217-225` | **Linux + X11 only**: cần `DISPLAY`, `xdotool`, `ffmpeg (x11grab)`; không có đường nào cho Win/mac |
  | Vault/keychain | `core/src/vault/vault.ts:69-77,162-167` | `safeStorage` = DPAPI (Win) / keychain (macOS) / libsecret (Linux); không khả dụng → fallback `LocalEncryptor` (AES-256-GCM + scrypt, key file mode 0600) |
  | Đường dẫn userData | `apps/desktop/src/main/main.ts:206,255,353-369` (`app.getPath('userData')`) | Win: `%APPDATA%\<app>`; macOS: `~/Library/Application Support/<app>`; Linux: `~/.config/<app>` — mọi file settings/vault/usage/plugins/skills đều neo vào đây |
  | Spawn coordinator/daemon | `core/src/coordinator/client.ts:77-83`, `tools/src/daemon/client.ts:70` | `spawn(process.execPath, [entry])`; riêng Electron cần env `ELECTRON_RUN_AS_NODE=1` (`client.ts:39-50`, `main.ts:877-883`) — `process.execPath` trên macOS là binary trong `.app` bundle, trên Win là `.exe` |
  | Path/filesystem | `tools/src/sandbox.ts:20-50` (`resolveWithin`), `core/src/agent/memory.ts:25` (`node:sqlite`) | `resolveWithin` dùng `path.sep` + `realpathSync` (đúng hướng); `node:sqlite` là built-in Node — cần kiểm chứng trong runtime Electron (xem §4.3) |
  | Denylist shell | `tools/src/sandbox.ts:60-80` | Có cả mẫu Windows (`%USERPROFILE%`, `powershell`, `cmd`) — tốt, nhưng chưa test thật trên Win |

- **Điểm tốt đã có (đừng phá khi sửa):** nhiều chỗ đã inject `platform`
  để test — `imessage.ts:48` ("Ghi đè platform để test"), 
  `integrationTools.ts:101` (`platform` option cho `imessage_draft`).
  Đây là mẫu cần nhân rộng (xem §4.3).
- **Điểm chưa kiểm chứng, cần xác minh khi làm (không đoán):**
  - Electron 38 dùng Node nội bộ phiên bản mấy — `core` yêu cầu
    `node >= 24` (`packages/core/package.json:7-8`) nhưng Electron
    bundle Node riêng, khác Node hệ thống. Cần xác minh `node:sqlite`,
    `AbortSignal.any`, global `WebSocket` client có chạy trong main
    process của Electron 38 không (WS server dùng `node:http` nên
    ít rủi ro hơn, nhưng `node:sqlite` trong `BotMemory` là rủi ro
    thật nếu Electron dùng Node < 24).
  - `fs.statfsSync` ở `localTools.ts:309` được gọi qua cast
    `as unknown` (không chắc có trên mọi Node/platform) — đã có
    fallback null, nhưng chưa test trên Win/mac.
  - Đường dẫn có ký tự đặc biệt/dấu tiếng Việt, khoảng trắng, ổ đĩa
    `C:\`, UNC `\\server\share`, case-insensitive FS (macOS/Win):
    `resolveWithin` dùng `path.resolve` nên đúng hướng, nhưng chưa
    có test nào cho các case này.

### 4.2. Vấn đề

1. Mọi nhánh `win32`/`darwin` trong bảng trên đều **chưa từng chạy
   thật**: code viết theo suy luận, không có test nào assert hành vi
   Windows/macOS (trừ `imessage` có override platform để test).
2. Không có CI matrix → regression trên Win/mac chỉ phát hiện khi user
   báo lỗi.
3. Không có packaging → không thể test bản cài đặt thật (quyền ghi
   userData, safeStorage, auto-update, icon, code signing) — chỉ test
   được chạy từ source.
4. Một số tính năng **mặc định không chạy** trên Win/mac mà không báo
   rõ: computer-use (Linux+X11 only), iMessage gửi thật (macOS only).
   Chưa rõ tool trả lỗi đẹp hay crash khi gọi trên platform không hỗ trợ.

### 4.3. Thiết kế đề xuất

**A. CI matrix (làm đầu tiên, rẻ nhất, bắt được nhiều nhất):**

- Thêm `.github/workflows/ci.yml`: `runs-on: [ubuntu-latest,
  windows-latest, macos-latest]`, Node 24 (`actions/setup-node`), các
  bước `npm ci` → `npm run build` → `npm run typecheck` →
  `npm test` (`node --test`). Cache `npm` theo OS.
- Xử lý test cần display: computer-use test đã fail không display
  trên Linux; trên CI macOS/Windows cũng không có display — cho phép
  test này skip khi không có display (biến môi trường hoặc detect
  `DISPLAY`/`process.platform`), **không** để cả suite đỏ vì nó.
  Ghi rõ trong test: skip có lý do, không phải pass giả.
- Chạy lint/typecheck trên cả 3 OS (typecheck đã bắt được lỗi
  `__dirname`/EOL khác nhau nếu có).

**B. Unit test theo platform (không cần máy thật):**

- Nhân rộng mẫu đã có (`imessage.ts:48` inject `platform`): refactor
  các hàm đọc `process.platform` trực tiếp thành nhận `platform?:
  NodeJS.Platform` (mặc định `process.platform`):
  - `shellQuote()` ở `tools.ts:64`, `codeTools.ts:72`,
    `gitTools.ts:108`, `webMedia.ts:168` — **gộp thành một hàm duy
    nhất** ở `sandbox.ts` (hiện 4 bản copy gần giống nhau, dễ lệch).
  - Chọn shell + args (`sandbox.ts:175-176`, `shellTools.ts:140-148`,
    `tools.ts:290-291`) → hàm `platformShell(platform)` thuần, test
    được.
  - Opener (`localTools.ts:267-273`), `readProcessList`
    (`localTools.ts:334`) → tách hàm thuần nhận platform.
  - `runShell` kill group: test được phần chọn lệnh kill (không test
    được kill thật trên CI khác OS — phần đó thuộc về CI matrix).
- File test mới `tests/platform.test.mjs`: bảng case cho từng hàm trên
  với cả 3 platform (quote chứa `"`, `'`, `$`, backtick, newline;
  opener đúng lệnh; shell đúng binary/args). Thêm case path:
  `resolveWithin` với `C:\` drive, UNC, symlink, case khác nhau
  (chạy được trên Win CI; trên Linux test phần POSIX).
- Quy tắc mới cho code sau này: **không đọc `process.platform` trực
  tiếp trong logic nghiệp vụ** — luôn đi qua hàm thuần có tham số
  platform để test được (ghi vào `AGENTS.md` hoặc CONTRIBUTING khi có).

**C. Kiểm chứng runtime Electron trên Win/mac (checklist, làm bằng tay
  lần đầu, sau đó tự động hóa dần):**

1. `npx electron --version` + in app log `process.versions.node` trên
   cả 3 OS — xác nhận Node nội bộ của Electron 38 có `node:sqlite`,
   `AbortSignal.any`, global `WebSocket` không. Nếu Electron dùng
   Node < 24: hoặc hạ `engines` của core, hoặc thay `node:sqlite`
   bằng fallback — **quyết định này phải có trước khi release Win/mac**.
2. First-run: tạo `userData`, `settings.json`, `vault.json` (cả 2
   backend: safeStorage khả dụng và fallback LocalEncryptor — đặc
   biệt Linux không có libsecret là case fallback hay gặp).
3. Vault round-trip: set/get secret, restart app, đọc lại được.
4. Shell tool: chạy lệnh đơn giản, lệnh có pipe, lệnh timeout, lệnh
   bị deny; kiểm tra cháu process có bị kill hết trên Windows không
   (case yếu nhất đã nêu ở §4.1).
5. `open_path`, `list_processes`, `git` tool, plugin load (đường dẫn
   plugin có khoảng trắng/dấu tiếng Việt).
6. Computer-use / iMessage trên Win/mac: gọi thử, xác nhận trả lỗi
   rõ ràng ("chỉ hỗ trợ Linux+X11" / "chỉ macOS") thay vì crash hay
   treo.
7. Local API + WS stream: chạy server, kết nối bằng client WS thật
   trên từng OS (port loopback, firewall prompt trên Windows lần đầu
   là hành vi cần ghi nhận).

**D. Packaging (tách riêng, sau A-C):**

- Thêm `electron-builder` (quyết định: chọn `electron-builder` vì phổ
  biến, config `win: nsis`, `mac: dmg`, `linux: AppImage`) + script
  `dist:win` / `dist:mac` / `dist:linux`. Code signing/notarization
  macOS và Windows là việc riêng (cần cert, không làm trong đợt này
  — build unsigned trước, ghi rõ).
- Khi có packaging mới test được: cài đặt thật, chạy từ shortcut,
  auto-update (`update/checker.ts` hiện chỉ parse version, chưa có
  tải/cài theo platform).

### 4.4. Các bước làm

1. `.github/workflows/ci.yml`: matrix 3 OS × Node 24, `npm ci` +
   build + typecheck + test; cho phép computer-use test skip khi
   không có display (sửa test, không sửa CI để giấu lỗi).
2. `tools/src/sandbox.ts`: gộp 4 `shellQuote` thành một hàm export;
   thêm `platformShell(platform)` thuần; `runShell`/`killGroup` nhận
   platform qua tham số nội bộ.
3. `tools/src/localTools.ts`, `codeTools.ts`, `gitTools.ts`,
   `webMedia.ts`, `shellTools.ts`: dùng hàm chung, inject platform
   thay vì đọc trực tiếp.
4. `tests/platform.test.mjs` (mới): bảng case 3 platform cho quote/
   shell/opener/process-list + `resolveWithin` case Windows
   (chạy trên Win CI).
5. Checklist thủ công §4.3.C chạy 1 lần trên máy thật/VM Win 11 +
   macOS (ghi kết quả vào `docs/TESTING.md`, đặc biệt mục Node của
   Electron 38 và kill cháu process trên Windows).
6. (Sau) `electron-builder` + script đóng gói 3 OS; CI thêm job build
   installer (unsigned) để ít nhất biết là đóng gói được.

### 4.5. Test cần thêm

- `tests/platform.test.mjs` (mới, chạy được trên Linux CI ngay):
  quote/shell/opener/process-list cho cả 3 platform bằng tham số
  inject; `resolveWithin` với path Windows-style (chỉ assert phần
  thuần túy, không đụng filesystem thật của Win).
- CI matrix (mục A) — bản thân nó là test: toàn bộ suite hiện có chạy
  trên Win/mac lần đầu sẽ lòi ra lỗi thật (vd: test nào dùng `/bin/sh`,
  đường dẫn `/tmp`, `process.kill(-pid)`...).
- Test computer-use: skip có điều kiện khi không có display, kèm lý
  do trong output (đừng để CI xanh giả).
- Checklist thủ công §4.3.C ghi kết quả vào `docs/TESTING.md` (không
  phải test tự động, nhưng là bằng chứng đã chạy).

### 4.6. Độ khó

- **S** cho unit test platform + gộp `shellQuote` (thuần túy, không
  cần máy Win/mac).
- **M** cho CI matrix (viết workflow nhanh, nhưng lần đầu chạy sẽ lòi
  lỗi cần sửa — dự trù 1-2 vòng sửa test/code cho Win/mac).
- **L** cho packaging + QA thủ công đầy đủ (electron-builder config,
  code signing, test cài đặt thật trên VM Win/mac, sửa kill cháu
  process trên Windows nếu cần `taskkill /T /F`).

---

## Phụ lục — Ghi chú chung

- **Không đổi contract công khai khi chưa cần:** mục 1 chạm `Provider`
  interface (contract của core) nên làm cuối trong mục 1; mục 2 giữ
  `getToken` cũ cho test; mục 3 giữ `Tool` interface nguyên.
- **Bảo mật xuyên suốt:** không log token (mọi lỗi connector đã tuân
  thủ — giữ nguyên khi thêm retry); refresh token/client secret không
  qua IPC, không qua WS; plugin host không nhận secret qua env
  (`safeEnv()` đã chặn).
- **Thứ tự triển khai đề xuất:** 1 (M) → 2 giai đoạn 1 (M) → 4A+4B
  (S/M, làm song song với 1-2 vì là hạ tầng test) → 3 bản tối thiểu
  (M) → 2 giai đoạn 2 (M+) → 3 giai đoạn 2 mediation (L) → 4D
  packaging (L).
