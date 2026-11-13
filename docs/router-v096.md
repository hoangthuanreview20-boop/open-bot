# Router chọn model mỗi turn — v0.96 (Đội T3)

Router chọn model/provider cho mỗi turn qua 3 tầng rẻ-dần-đắt-dần,
chỉ leo tầng khi tầng dưới chưa đủ tự tin. Mọi tầng đều chạy local
hoặc không gọi model; router lỗi thì turn vẫn chạy bằng model mặc
định của bot (fail-open tuyệt đối).

## Tầng

| Tầng | Module | Chi phí | Quyết khi |
|---|---|---|---|
| 1. Structural | `packages/core/src/router/structuralScore.ts` | 0 gọi model, <1ms | Điểm ≤ 0.15 → local; ≥ 0.3 → model mạnh |
| 2. Semantic | `packages/core/src/router/semanticRouter.ts` | 1 lần embed local (`nomic-embed-text`) | Route đủ tự tin (cosine ≥ 0.35, margin ≥ 0.08) |
| 3. Decision | `packages/core/src/router/decisionRouter.ts` | 1 lần gọi `qwen2.5:0.5b` local, JSON, timeout 4s | Model nhỏ đủ tự tin (≥ 0.5) |

Structural chấm 6 tín hiệu (độ dài, code, từ khoá suy luận, ràng
buộc cứng, số yêu cầu, bối cảnh) song ngữ Anh + Việt, thuần hàm nên
cùng input luôn cho cùng score. Semantic có 6 route mặc định
(simple-chat, code, reasoning, research, creative, howto), câu mẫu
được embed lười + cache; Ollama chết → `null`. Decision hỏi model
nhỏ đúng 1 JSON `{route, needs_powerful_model, confidence, reason}`,
parse nghiêm ngặt, timeout race tường minh (kể cả fetch không tôn
trọng AbortSignal) → `null` khi quá hạn.

## Session pinning

Đã chọn model cho một thread thì giữ nguyên (`ModelRouter` giữ map
pin theo `botId:threadId`), trừ khi: user đổi model tay
(`switchModel` gỡ pin), hết TTL lượt, hoặc context sắp đầy (≥ 90%
mặc định → gỡ pin, route lại sang model context lớn hơn).

## Fallback ladder

`fallbackLadder(chosen, targets)`: cùng loại trước, rồi local rẻ
nhất, rồi các đích còn lại; target bị `markUnhealthy()` (vd provider
lỗi) đẩy xuống cuối kèm cooldown 60s, hết hạn tự khoẻ lại.

## Nối vào coordinator

`AgentCoordinator.executeRun()` gọi `applyRouting()` trước khi dựng
`AgentRunner`: router chọn trong các đích coordinator dựng được
(default của bot + model chat local nhỏ nhất Ollama đang cài, probe
`/api/tags` cache 60s). Chỉ override được 2 dạng: cùng provider
khác model (vd CLI đã đăng nhập) và Ollama local; đích API/CLI khác
bị bỏ qua vì coordinator không có key/binary của nó. Provider
override được dispose trong `finally` của run. Mọi quyết định vào
ring buffer trong router + sink đẩy lên harness event log với kind
mới `router.decision` (thêm vào `HarnessEventKind` +
`HARNESS_EVENT_KINDS` để EventLog/SSE lọc được).

## UI

`RouterPanel` (Settings → Bot & Model → Router): quyết định gần
nhất + lịch sử ngắn, thống kê local-vs-cloud + tiền ước tính tiết
kiệm, chỉnh ngưỡng đơn giản/khó, bật/tắt từng tầng. Ngưỡng + toggle
lưu ở localStorage renderer; i18n đủ 6 locale (`router.*`, 13 key).

## Nối IPC còn lại (follow-up, ĐÃ LÀM trong v0.98 — xem docs/router-v098.md)

- Main process: IPC `router:decisions` / `router:stats` đọc từ
  `coordinator.getRouterDecisions()` / `getRouterStats()` (RPC
  `router.getDecisions` / `router.getStats`), và `router:set-config`
  đẩy cấu hình panel xuống `CoordinatorOptions.router` (RPC
  `router.setConfig`, bền vững trong `settings.json` +
  `<dataDir>/router-config.json`). Quyết định mới còn được đẩy live
  qua `router:changed` (event `router.decision`).
- `discoverLocalTarget` chỉ thấy model Ollama; đích CLI/API khác nay
  được offer qua `discoverCliTargets` (registry detected engines) và
  `discoverApiTargets` (key API main seed qua RPC `router.setApiKey`).

## Test

`tests/router-v096.test.mjs` — structural determinism + <1ms,
semantic trên ví dụ mẫu (embedder giả), decision parse/timeout,
pinning, fallback ladder, log/stats, + 1 live test Ollama thật
(structural+semantic < 500ms, route "hello" → simple-chat).
