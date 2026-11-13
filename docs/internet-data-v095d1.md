# Internet data — v0.95 Team D1

Hướng mới 2026-11-12 (Huy): **không cần dữ liệu X** — xây lớp dữ liệu
internet toàn diện, nhiều hơn X, miễn phí, local-first. Toàn bộ code
viết lại từ đầu cho open-bot (chỉ học ý tưởng, không copy code/text/
asset của bất kỳ repo nào). Không kết nối live tới x.ai.

## Tool mới (10, trong `packages/tools/src/internetData.ts`)

| Tool | Mô tả |
| --- | --- |
| `internet_search` | Tìm kiếm đa nguồn: Wikipedia API → DuckDuckGo lite → DuckDuckGo HTML (miễn phí, không key). Nguồn `brave` (Brave Search API) là opt-in, cần key trong Vault (`search` / `brave-api-key`); thiếu key thì tool giải thích cách thêm, không gọi API, không chặn app. |
| `web_fetch_clean` | Fetch URL + trích nội dung sạch kiểu readability (title + heading + đoạn văn, bỏ nav/header/footer/script/form/aside). |
| `feed_subscribe` / `feed_list` / `feed_read` / `feed_unsubscribe` | RSS/Atom (parse cả RSS 2.0 và Atom, CDATA + entities). Subscribe validate bằng cách fetch thật 1 lần. |
| `watch_url` / `watch_list` / `watch_check` / `watch_remove` | Theo dõi thay đổi trang: poll theo interval (5–1440 phút, mặc định 60), hash nội dung đã trích, diff tóm tắt theo dòng. Lần check đầu chỉ ghi baseline. |

`web_fetch` cũ cũng được nâng cấp: dùng chung `extractReadableText`
thay cho strip tag phẳng (nội dung trả về vẫn là text thuần, max
20.000 ký tự như cũ).

State (feed + watch) lưu ở `<userData>/internet-data.json`
(`InternetDataStore`, ghi atomic tmp+rename, file hỏng → state rỗng,
không throw). Không có state file (embedder) thì tool dùng store
trong bộ nhớ, không persist.

## An toàn

- Mọi fetch qua SSRF guard (`assertPublicUrl`, hoặc egress policy của
  team khi có) + follow redirect thủ công tối đa 5 hop, mỗi hop kiểm
  tra lại — cùng luật với `web_fetch` / `http_get` / `http_request`.
- Timeout 20s, body tối đa 1 MB, kết quả tool tối đa 20.000 ký tự.
- Không credential nào được gửi, trừ Brave key và chỉ tới
  `api.search.brave.com`, chỉ khi host đã cấu hình key qua Vault.
- Key không bao giờ nằm trong file/log/test (test dùng mock).

## Đăng ký (tránh trùng tên)

10 tool đã nằm trong `ALL_TOOLS` (`tools.ts`). Coordinator **không**
đăng ký riêng nữa — `defaultToolFactory` chỉ truyền opts vào
`createDefaultTools` (`getInternetDataFile`, `getBraveSearchApiKey`,
`onWatchChanged`) để **thay placeholder bằng bản bound** (cùng mẫu
`http_request`). Đăng ký riêng sẽ làm `ToolRegistry` ném lỗi trùng
tên — đã từng xảy ra trong sóng này, có test hồi quy trong
`tests/internet-data-v095d1.test.mjs`.

## Thông báo khi trang đổi

- Tool `watch_check` (hoặc nút "Kiểm tra ngay" của UI) gọi
  `onWatchChanged` cho mỗi watch đổi thật.
- Coordinator forward thành agent event `internet.watch-changed`
  (`packages/core/src/coordinator/types.ts`).
- Main (`routeCoordinatorEvent`) forward tiếp về renderer qua IPC
  `internet:watch-changed` (InternetDataView hiện banner + reload)
  và bắn OS notification kind mới `watch-change`
  (`packages/core/src/notifications/` — template 6 locale, toggle
  riêng trong Settings → Notifications, mặc định ON).
- Chưa có daemon nền chạy poll tự động: watch chỉ được kiểm tra khi
  agent/user chạy `watch_check` hoặc bấm "Kiểm tra ngay" trong UI
  (xem "Giới hạn" dưới).

## UI — màn "Internet data"

`InternetDataView` (sidebar 🌐 Internet data): 2 tab Feeds / Watchlist,
cùng IPC `internet-data:*` trong main (main tự fetch trực tiếp nên
không cần bot đang chạy). Tính năng nâng cao (hash nội dung, lỗi cuối,
dòng tóm tắt đã lưu) nằm sau `<details>` (progressive disclosure).
Mọi chuỗi qua i18n `internet.*` — 42 key mới, đủ 6 locale
(1538 → 1580 key/locale).

## Test

`tests/internet-data-v095d1.test.mjs` — 28 test, mock fetch + fake DNS,
**không gọi mạng thật**: parser (readable text, RSS, Atom, DDG lite/
HTML), search (Wikipedia-first, Brave có/không key), SSRF (localhost /
private IP / redirect sang host nội bộ), vòng đời feed + watch
(baseline → không đổi → đổi + diff + callback), interval gating,
store (round-trip JSON, file hỏng), registry + binding không trùng,
notification text `watch-change` (vi/en).

## Giới hạn còn lại (chưa kiểm chứng live)

- Chưa test live với mạng thật: Wikipedia/DDG/Brave/feed RSS thật,
  Electron app thật (chỉ build + typecheck), OS notification popup
  thật trên máy có notification daemon (VM headless không có).
- Brave Search: chưa có key thật để test live; chưa có ô nhập key
  trong Settings — key phải có sẵn trong Vault (`search` /
  `brave-api-key`) thì nguồn `brave` mới chạy.
- Poll tự động nền: chưa có scheduler/daemon gọi `watch_check`
  định kỳ — watch chỉ chạy khi được gọi (agent hoặc UI). Có thể nối
  vào Automations/cron ở sóng sau.
- `extractReadableText` là readability-lite bằng regex (không dùng
  thư viện): trang có cấu trúc lạ có thể trích thiếu/thừa; chưa có
  benchmark độ chính xác trích xuất.
- Diff của watch chỉ so với 40 dòng đầu đã lưu của lần fetch trước
  (không lưu toàn bộ nội dung cũ) — đủ cho trang đổi ít, trang đổi
  nhiều ở cuối trang có thể báo diff không đầy đủ.
