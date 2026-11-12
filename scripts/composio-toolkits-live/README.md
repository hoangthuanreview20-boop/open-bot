# Composio toolkits — live discovery (Team A, v0.72a)

Bằng chứng slug thật cho 10 toolkit Composio mới trong open-bot
(`packages/core/src/composio/toolkits.ts`). Chạy live ngày 2026-11-10
với key project Composio thật (đã lưu dạng connector `custom.composio`,
live test HTTP 200) — **không có key nào trong thư mục này**.

## Kết quả live (2026-11-10)

| Toolkit | Tool thật trên Composio |
|---|---:|
| googlesheets | 58 |
| googledrive | 105 |
| googlecalendar | 50 |
| jira | 132 |
| linear | 48 |
| discord | 28 |
| telegram | 18 |
| trello | 335 |
| asana | 247 |
| hubspot | 344 |
| **Tổng** | **1.365** |

## Kết quả live v0.82 (2026-11-11)

8 toolkit mới, đối chiếu qua `GET /api/v3.1/tools?toolkit_slug=<slug>`
với cùng key project thật — bằng chứng
`toolkits-live-2026-11-11.json`, chạy lại bằng
`python3 discover.py toolkits-live-2026-11-11.json zoom salesforce zendesk airtable monday clickup dropbox outlook`:

| Toolkit | Tool thật trên Composio |
|---|---:|
| zoom | 107 |
| salesforce | 327 |
| zendesk | 457 |
| airtable | 28 |
| monday | 126 |
| clickup | 165 |
| dropbox | 178 |
| outlook | 333 |
| **Tổng 8 mới** | **1.721** |
| **Tổng 22 toolkit** | **4.285** |

Mỗi toolkit mới giữ đúng 10 slug dùng nhiều nhất trong catalog
(`packages/core/src/composio/toolkits.ts`, cap M7) — toàn bộ tool còn
lại vẫn tới được qua `COMPOSIO_SEARCH_TOOLS` lúc chạy. Không slug nào
trong 80 slug mới là bịa: test `tests/composio-toolkits-a.test.mjs`
đối chiếu từng slug với cả 2 file JSON live.

## Vì sao catalog chỉ liệt kê 10 slug/toolkit

Cap M7 (`packages/core/src/apps/toolCap.ts`, `DEFAULT_APP_TOOL_CAP = 10`)
chỉ expose tối đa 10 tool/app/turn — liệt kê hàng trăm slug vào
catalog vừa tốn context vừa bị cap cắt. Catalog giữ 10 slug dùng nhiều
nhất mỗi toolkit (CRUD + tìm kiếm + đọc, đã xác nhận live); toàn bộ
tool còn lại model vẫn dùng được qua discovery lúc chạy
(`COMPOSIO_SEARCH_TOOLS` → `COMPOSIO_GET_TOOL_SCHEMAS` →
`COMPOSIO_MULTI_EXECUTE_TOOL`), đúng thiết kế Tool Router từ v0.57.

## Chạy lại

```text
python3 discover.py [toolkits-live.json]
```

Script dùng credential đã đăng ký qua surrogate (như helper
`custom.composio`), key không bao giờ chạm file hay log.

## Hai phát hiện khi live test

1. Tool Router session (`POST /tool_router/session` rồi
   `GET .../session/{id}/tools`) chỉ trả 6 meta-tool `COMPOSIO_*` —
   tool từng toolkit KHÔNG nằm trong danh sách session, mà được tìm
   qua `COMPOSIO_SEARCH_TOOLS` lúc chạy.
2. Endpoint catalog `GET /api/v3.1/tools` lọc theo toolkit bằng tham
   số `toolkit_slug` — tham số `toolkit` bị API lặng lẽ bỏ qua (bẫy
   này khiến helper `--toolkit` trước đây trả về danh sách không lọc).
