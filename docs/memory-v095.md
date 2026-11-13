# Cá nhân hoá + trí nhớ dài hạn — v0.95 (Đội D4)

Local-first, miễn phí, không cloud. Mọi thứ trong tài liệu này đều
chạy trên máy user; không có dữ liệu profile/memory nào rời khỏi máy
ngoài phần context của chính turn đó (như mọi system prompt khác).

## Hồ sơ người dùng (user profile)

- **Store:** `<userData>/profile.json` — cùng file với `LocalProfile`
  của v0.7 (`packages/core/src/auth/identity.ts`, đã mở rộng):
  `userId` ổn định (uuid, không đổi), `displayName`, và các field mới
  `addressForm` (cách xưng hô — vd "bạn", "anh", "chị"), `interests`,
  `habits`, `facts` (mỗi field tối đa 50 mục × 200 ký tự).
- **Ghi:** chỉ qua UI Settings (section Hồ sơ, tab Chung) hoặc
  `updateLocalProfile` (validate strict, merge, `userId`/`createdAt`
  không đổi). File cũ (trước v0.95) vẫn đọc được — các field mới vắng
  thì coi như trống.
- **Đọc vào turn:** `buildProfileContext(profile)` trong
  `packages/core/src/memory/profile.ts` render một section chèn vào
  system prompt (tối đa 2000 ký tự); profile trống thì không chèn gì.
  Không có gì trong profile được suy ra lén — mọi field đều do user
  tự nhập.
- **IPC:** `profile:get` / `profile:update` (main.ts) →
  `window.openBot.getUserProfile/updateUserProfile` (preload).

## Trí nhớ dài hạn (long-term memory)

- **Store:** `<workspace>/.open-bot/memories.json` (JSON, ghi atomic,
  mode 0600) — giữ nguyên định dạng của v0.7
  (`packages/core/src/memory/longterm.ts`). Mỗi entry: `id`, `key`,
  `value`, `tags`, `confidence`, `botId`, `userId?`, `embedding?`,
  `createdAt`/`updatedAt`.
- **Phạm vi (scope):**
  - `botId ''` = memory chung cho mọi bot; khác rỗng = chỉ bot đó.
    Recall của một turn lấy cả memory của bot đó **và** memory chung
    (`includeShared`).
  - `userId` = user sở hữu memory (lấy từ `<userData>/profile.json`).
    Entry legacy chưa gắn user (vắng/`''`) được coi là của user hiện
    tại; entry gắn userId khác không bao giờ lọt vào recall/list của
    user này.
- **Embedding (ngữ nghĩa):** Ollama local
  `http://127.0.0.1:11434`, model `nomic-embed-text` (768 chiều) —
  `packages/core/src/memory/embeddings.ts` (đã có từ v0.14).
  Vector đã chuẩn hoá L2 được persist cùng entry; đổi value/model thì
  vector cũ bị xoá để embed lại. Ollama chết → recall fallback về
  tìm kiếm từ khoá, có ghi rõ `usedFallback` + `fallbackReason`
  (không lặng lẽ). Probe khả dụng được cache 60s, timeout 1.5s
  (`isEmbedderAvailableCached`) để một turn không treo 30s chờ
  Ollama.
- **Ngân sách turn:** `buildMemoryTurnContext`
  (`packages/core/src/memory/turnContext.ts`) — profile trước, recall
  sau, tối đa 6000 ký tự (~1500 token) và 5 memory/turn. Coordinator
  (`run()`) gọi nó best-effort: lỗi thì turn chạy như cũ, không có
  section memory.
- **Quy tắc đồng ý (consent):** agent chỉ gọi `memory_save` khi user
  nói rõ "hãy nhớ …" / "ghi nhớ …" / "lưu lại …" hoặc đã duyệt một đề
  xuất lưu cụ thể. Không tự suy ra fact/sở thích từ hội thoại rồi ghi
  lén — description của tool nói rõ điều này, và `memory_save` /
  `memory_delete` đều có `needsApproval: true` nên mọi lần ghi/xoá
  đều qua thẻ duyệt của user.
- **Tools (registry):** `memory_save`, `memory_search`, `memory_list`,
  `memory_delete` (`packages/tools/src/memoryTools.ts`,
  `createMemoryTools`, đăng ký trong `defaultToolFactory`). Output
  không bao giờ kèm vector embedding.
- **UI quản lý:** màn hình Trí nhớ (sidebar) — chọn bot, tìm kiếm,
  xem/sửa (value + tags)/xoá (xác nhận 2 bước), xuất JSON
  (`memory:export`, JSON không kèm vector), dòng trạng thái
  (tổng số / đã embed / Ollama chạy hay chưa / model).
  IPC: `memory:list` / `memory:update` / `memory:delete` /
  `memory:export` / `memory:status` (main.ts).

## Quyền riêng tư — tóm tắt

| Dữ liệu | Ở đâu | Rời khỏi máy? |
|---|---|---|
| Profile (`profile.json`) | userData, local | Không |
| Memories (`memories.json`) | workspace của bot, local | Không |
| Embeddings | Ollama `127.0.0.1:11434`, local | Không |
| Context turn (profile + recall) | Chỉ trong prompt gửi tới provider mà user đã chọn cho bot đó | Theo provider của bot (như mọi tin nhắn khác) |

Không có tài khoản cloud, không đồng bộ, không telemetry cho
profile/memory. Xoá memory trong UI là xoá thật khỏi file local.
Export JSON chỉ chứa nội dung đọc được, không kèm vector.

## Giới hạn còn lại (v0.95d4)

- Recall ngữ nghĩa cần Ollama chạy + model `nomic-embed-text` đã
  pull; nếu không có thì recall từ khoá (đã báo rõ trong kết quả).
- Memory recall trong turn dùng query = tin user hiện tại; chưa có
  tóm tắt/suy luận chéo giữa các memory (chỉ trích chọn top-k).
- Profile mới chỉ có 5 nhóm field (tên, xưng hô, sở thích, thói
  quen, facts); chưa có ảnh đại diện hay múi giờ/ngôn ngữ riêng.
- Export là JSON thô, chưa có import ngược.
- Chưa có kiểm tra người bản ngữ cho bản dịch zh/ja/es/fr mới.
