# Router — nối IPC + đích CLI/API (v0.98, Đội T2)

Nối tiếp v0.96 (Đội T3, xem `docs/router-v096.md`): router 3 tầng
(structural → semantic → decision) đã chọn model mỗi turn, nhưng
RouterPanel hiển thị trạng thái trống vì 3 kênh IPC chưa nối, lịch
sử chỉ sống trong bộ nhớ, và coordinator chỉ offer được default +
Ollama local. Sóng này đóng cả ba lỗ đó.

## 1. IPC: `router:decisions` / `router:stats` / `router:set-config`

Đường đi đầy đủ (coordinator chạy tiến trình con, main không giữ
coordinator trong process):

```
RouterPanel (renderer)
  → window.openBot.getRouterDecisions/getRouterStats/getRouterConfig/
    setRouterConfig/clearRouterLog/getRouterTargets (preload.ts)
  → IPC router:* (apps/desktop/src/main/main.ts)
  → CoordinatorClient (packages/core/src/coordinator/client.ts)
  → RPC router.* (NDJSON-RPC, handle() trong coordinator.ts)
  → AgentCoordinator.getRouterDecisions/getRouterStats/...
```

| IPC | RPC | Đọc từ |
|---|---|---|
| `router:decisions` `{botId?, limit?}` | `router.getDecisions` | `RouterDecisionStore` (bền vững) → fallback log nhớ |
| `router:stats` `{botId?}` | `router.getStats` | store (unhealthyTargets lấy từ router đang chạy) |
| `router:get-config` | `router.getConfig` | cấu hình hiệu lực của router |
| `router:set-config` `{config}` | `router.setConfig` | validate → `ModelRouter.updateConfig` + ghi file + `settings.json` |
| `router:clear-log` `{botId?}` | `router.clearLog` | store + log nhớ |
| `router:targets` | `router.getTargets` | local + CLI + API đã khám phá (xem §3) |

Quyết định mới còn được đẩy **live** về renderer: sink `onDecision`
của router publish event `router.decision` lên harness (kind
`HarnessEventKind`, KHÔNG phải `AgentEventKind` — main KHÔNG có case
riêng cho nó trong `routeCoordinatorEvent`); event về main dưới dạng
`agent.event` kind `'harness.event'`, main forward thành IPC
`router:changed` trong nhánh `case 'harness.event'`; panel subscribe
qua `window.openBot.onRouterChanged` và kéo lại lịch sử + thống kê.
Panel vẫn kéo lại khi mở — `router:changed` chỉ là tín hiệu làm mới,
nguồn thật nằm ở coordinator. (Lỗi đã gặp: đặt `case
'router.decision':` trong switch `AgentEventKind` thì tsc báo TS2678
và case đó không bao giờ chạy — đã sửa thành nhánh harness.event.)

Validate 2 lớp: main validate `botId`/`limit` (requireString/
requireInt) rồi coordinator validate lại patch cấu hình
(`validateRouterConfigPatch` — key lạ / sai kiểu / số ngoài khoảng
bị từ chối kèm lý do; số được kẹp về biên). Patch sai → lỗi rõ,
cấu hình cũ giữ nguyên.

## 2. Lịch sử bền vững + thống kê (`packages/core/src/router/history.ts`)

- **Store**: file `<dataDir>/router-decisions.json`
  (`{version: 1, bots: {botId: StoredRouterDecision[]}}`), tối đa 200
  quyết định/bot, tối đa 50 bot (bot lâu không hoạt động nhất bị tỉa).
  Ghi atomic (tmp + rename). Mọi lỗi I/O đều nuốt — store không bao
  giờ làm hỏng turn. `RoutingDecision` mang thêm `defaultTargetId`
  (để tính tỉ lệ fallback) và `savingsUsd` (tiền tiết kiệm của chính
  quyết định đó, tính trong `ModelRouter.record`).
- **Thống kê** (`computeRouterStats`, dùng chung cho log nhớ và store):
  tổng lượt, local/cli/api, theo tầng, theo provider, độ trễ trung
  bình + p50/p95, **tỉ lệ fallback** (quyết định rời khỏi đích mặc
  định / số quyết định biết đích mặc định), tiền ước tính tiết kiệm.
  Quyết định cũ không có `defaultTargetId` không bị đếm sai thành
  fallback (không tính vào mẫu số).
- **Cấu hình bền vững**: file `<dataDir>/router-config.json` (ghi
  khi `router.setConfig` thành công) + `settings.json` ở main
  (`settings.router`). Coordinator respawn: main đẩy lại
  `settings.router` lúc spawn (`syncRouterToCoordinator`, cùng mẫu
  `syncComposioToCoordinator`); file dưới dataDir là backstop khi
  main chưa kịp đẩy.

## 3. Đích CLI/API (`packages/core/src/router/targets.ts`)

v0.96 chỉ offer default + Ollama local. Nay `applyRouting` gộp thêm:

- **CLI** (`discoverCliTargets`): từ snapshot của
  `DetectedEngineRegistry` (đọc `<dataDir>/detected-engines.json`,
  detect có cache 60s). Chỉ engine `available` **và** đã bật
  (opt-in) mới thành target; engine chưa cài / chưa đăng nhập / user
  tắt thì không xuất hiện. Windsurf được nới như main: trạng thái
  `unknown` vẫn dùng được khi đã bật. Custom ACP bị bỏ qua có chủ ý:
  snapshot không mang `acpArgs` nên không dựng được provider.
  Target mang `cliBinary` (đường dẫn tuyệt đối do detector tìm
  thấy) — driver CLI throw khi thiếu binary nên coordinator chỉ
  dựng override khi có binary (fail-open về default khi thiếu).
- **API** (`discoverApiTargets`): từ danh sách provider id mà main
  đã seed key cho coordinator qua RPC `router.setApiKey` (đúng mẫu
  seed key Composio/media — key chỉ sống trong bộ nhớ coordinator,
  không log, không ghi file). Main seed toàn bộ key lúc spawn
  (`seedRouterApiKeysToCoordinator`) và seed lại từng key khi user
  lưu/xoá key trong Vault (`vault:set` / `vault:delete` /
  provider-settings save). Không có key seed thì không có target.
- **Chọn đích mạnh** (`pickCapable` trong `router.ts`): default đã
  mạnh (API/CLI) thì giữ default. Default là local yếu thì chọn đích
  mạnh nhất trong pool: context lớn trước, CLI (subscription sẵn,
  không tốn key) trước API, rẻ trước (`compareCapable`). Giá USD và
  context limit là **ước tính công khai** (bảng trong `targets.ts`)
  — chỉ dùng để tính tiền tiết kiệm ước tính và xếp hạng, không phải
  cam kết giá của nhà cung cấp.

### Miễn trừ bắt buộc (giữ nguyên từ v0.96)

`applyRouting` trả default ngay khi provider **của bot** là `mock`
hoặc kind `cli` (phiên CLI ngoài có trạng thái — router không được
đổi model giữa chừng; xem `tests/router-mock-v096.test.mjs`). Miễn
trừ này chỉ áp cho provider của bot — route **sang** đích CLI/API
khác từ một bot API/local vẫn được phép (đó là tính năng sóng này).

### Cấu hình routing mới (`RouterConfig`)

- `allowLocal` / `allowCli` / `allowApi` (mặc định bật cả 3): tắt
  một loại thì đích loại đó không được offer — trừ đích mặc định
  của bot (luôn giữ để turn còn đường chạy).
- `disabledProviders: string[]`: provider id user tắt routing tới
  (default của bot không bao giờ bị loại bởi danh sách này).
- Lọc áp ở 2 chỗ: `buildAvailableTargets` (lúc coordinator gộp đích)
  và `ModelRouter.route` (`isTargetAllowed`, phòng khi caller đưa
  đích chưa lọc).

## 4. RouterPanel (`apps/desktop/src/renderer/components/RouterPanel.tsx`)

- Kéo config/decisions/stats/targets qua IPC lúc mở + khi đổi filter
  bot; subscribe `router:changed` để làm mới live; loading/error +
  retry rõ ràng, không bịa số khi chưa có dữ liệu.
- Lịch sử theo từng bot (filter dropdown khi có > 1 bot) + nút xoá
  lịch sử (`router:clear-log`).
- Thống kê: tổng lượt, local/CLI/API, tỉ lệ fallback, p50/p95 độ
  trễ, tiền tiết kiệm ước tính.
- Cấu hình: bật/tắt router, ngưỡng dễ/khó, bật/tắt từng tầng,
  allow local/CLI/API, tắt routing tới từng provider (từ đích đã
  khám phá + trạng thái engine), ngưỡng nâng cao (semantic/
  decision confidence, decision timeout). Lưu tự động (debounce
  400ms) qua `router:set-config`, hiện trạng thái saving/saved/
  error; IPC không khả dụng thì dùng cache localStorage và báo rõ.
- Đích khả dụng: local + CLI/API đã offer + trạng thái từng engine
  CLI (offered hay không, vì sao — chưa cài / chưa đăng nhập / chưa
  bật).
- i18n đủ 6 locale (`router.*`, 49 key).

## 5. Giới hạn còn lại

- Bug đã sửa trong lúc test (commit 43052c9): fallback log nhớ của
  `getRouterDecisions`/`getRouterStats` là toàn cục — hỏi bot A lại
  trả quyết định của bot B, và `clearRouterLog(botId)` chỉ xoá store
  nên quyết định cũ vẫn quay lại qua fallback. Đã sửa: fallback lọc
  theo botId; thêm `ModelRouter.clearLogForBot()` (tính lại tổng độ
  trễ/tiết kiệm từ log còn lại) và gọi nó từ `clearRouterLog`.
- Custom ACP CLI chưa route được (thiếu `acpArgs` trong snapshot).
- Đích CLI/API chỉ là fallback ladder khi default của bot đã mạnh
  (API/CLI) — router không tự đổi bot API sang CLI khác chỉ vì rẻ
  hơn; CLI/API chỉ thắng khi default là local yếu và prompt cần
  model mạnh.
- Detect CLI lần đầu có thể tốn vài giây (spawn `--version`/status);
  `getRouterTargets` chạy trong RPC nên không chặn turn nào, nhưng
  panel mở lần đầu có thể chờ lâu hơn bình thường.
- Giá USD / context limit của đích khám phá là ước tính, không phải
  giá/limit thật của nhà cung cấp.
- `router:changed` chỉ báo "có quyết định mới" — panel kéo lại toàn
  bộ danh sách (20 quyết định) thay vì append 1 dòng; đủ nhanh ở
  quy mô này.

## 6. Test

- `tests/router-v098.test.mjs`: targets thuần, store + stats +
  validate, ModelRouter updateConfig/route CLI+API, RPC round-trip
  (config, apiKey, targets, decisions/stats/clearLog), live Ollama
  (turn thật ghi quyết định bền vững + respawn-safe) và live mock
  (miễn trừ v0.96 còn nguyên).
- `tests/router-ui-v098.test.mjs`: i18n parity 49 key × 6 locale,
  preload expose API router, main đăng ký IPC `router:*` +
  forward `router.decision`, RouterPanel testid + filter + config
  controls, renderer types.
