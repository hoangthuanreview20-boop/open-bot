# Memory blocks — v0.96 (Đội T1)

Memory blocks kiểu Letta/MemGPT, tự thiết kế lại hoàn toàn cho open-bot
(ý tưởng học từ Letta/OpenMausBot, không copy code/text/tài sản nào).

## Khái niệm

Một **block** là một mẩu bộ nhớ có tên (label slug), mô tả, nội dung và
giới hạn ký tự riêng (mặc định 2000 ký tự/block, cấu hình được
100–20000). Block sống **một lần** trong file
`<workspace>/.open-bot/memory-blocks.json` và được **attach** vào một
hay nhiều bot: cùng một block id attach ở nhiều bot thì sửa một nơi,
mọi bot đều thấy nội dung mới (share).

Label hệ thống (luôn render trước khi vào prompt):

- `human` — sự thật về người dùng (consolidation đẩy fact quan trọng lên đây)
- `persona` — tính cách / cách hành xử của bot

Block chưa attach vào bot nào không bao giờ lọt vào system prompt của
bot đó.

## File liên quan

| File | Vai trò |
|---|---|
| `packages/core/src/memory/blocks.ts` | `MemoryBlockStore`: CRUD, attach/detach/share, read-only guard, audit JSONL, cấu hình consolidation lúc idle |
| `packages/core/src/memory/consolidate.ts` | Consolidation + `ConsolidationScheduler` (mặc định TẮT) |
| `packages/core/src/memory/memfs.ts` | MemFS-lite: export/import Markdown (frontmatter YAML) |
| `packages/core/src/memory/turnContext.ts` | `buildMemoryBlocksSection` + nối blocks vào `buildMemoryTurnContext` |
| `packages/tools/src/memoryBlockTools.ts` | 10 tool `memory_block_*` + `memory_consolidate` |
| `apps/desktop/src/renderer/components/MemoryBlocksView.tsx` | UI quản lý block (tab trong MemoryView) |
| `apps/desktop/src/main/main.ts` | 12 kênh IPC `memory-blocks:*` |

## Quy tắc

- **Read-only**: block read-only chặn update/append/replace/delete.
  Chỉ `setReadOnly(false)` mới mở khoá (chính thao tác này không bị chặn).
- **Giới hạn ký tự**: nội dung vượt giới hạn thì throw lỗi rõ, không cắt lén.
- **Audit**: mọi thay đổi ghi append-only vào
  `.open-bot/memory-blocks-audit.jsonl` với actor `user` hoặc
  `agent:<botId>` (đọc qua `store.readAudit(n)`).
- **Self-editing**: agent sửa memory bằng tool call trong turn; mọi tool
  ghi đều `needsApproval: true` (chỉ `memory_block_list/get` là đọc).
- **Privacy**: block là local-first, không rời máy; tool/UI không bao giờ
  trả vector embedding (block vốn không có embedding).

## Consolidation (sleep-time compute)

Chạy tay qua tool `memory_consolidate` (action `run`) hoặc tự động khi
bot idle (`configure` bật + `idleMinutes`, mặc định TẮT). Coordinator
gọi `runIdleConsolidationIfDue()` lúc setup turn, best-effort. Một lần
chạy (không gọi model, luật xác định trên text):

1. **Dedupe** — cùng key + value chuẩn hoá (bỏ dấu, bỏ dấu câu) chỉ giữ
   bản mới nhất.
2. **Resolve conflict** — cùng key, value khác nhau: bản mới hơn thắng
   (hoà timestamp thì confidence cao hơn thắng); bản thua vào archive
   kèm nguồn (id, value, updatedAt) trong report.
3. **Promote** — fact quan trọng (confidence ≥ 0.9 hoặc tag `quan trọng`/
   `important`) được đẩy lên block `human` dạng bullet `- key: value`,
   bỏ qua dòng đã có.

Entry bị loại không xoá hẳn: ghi vào
`.open-bot/memory-archives/archive-<timestamp>.json` rồi mới gỡ khỏi kho
live (`forgetById`).

## MemFS-lite

Export ra `<userData>/memory-blocks/` (IPC `memory-blocks:export`):

- 1 file/block: `<label>.md`, frontmatter YAML (`label`, `description`,
  `scope`, `readOnly`, `version`, `updatedAt`, `charLimit`,
  `attachedBots`), body là nội dung block.
- `longterm-facts.md`: 1 section `## key` cho mỗi long-term memory.

Import merge, không ghi đè bừa: block đã có chỉ cập nhật khi bản import
**mới hơn** (`updatedAt` lớn hơn) và block không read-only; trường hợp
còn lại ghi vào `conflicts`/`skipped` trong kết quả. Facts merge theo
`(botId, key)`, bản mới hơn thắng.

## Prompt

`buildMemoryTurnContext` render các block đã attach thành phần
`<memory>` trong system prompt, sau profile và trước recall dài hạn:

```xml
<memory>
[human — Sự thật quan trọng về người dùng]
- Dị ứng: dị ứng đậu phộng
[persona — Tính cách]
Trả lời ngắn gọn.
</memory>
```

Ngân sách riêng cho blocks: 3000 ký tự mặc định (`MEMORY_BLOCKS_MAX_CHARS`),
điền theo thứ tự ưu tiên human → persona → khác; block không vừa thì
cắt nội dung (đánh dấu `…`) và báo `blocksTruncated`.

## Giới hạn còn lại

- Auto-consolidation lúc idle đo "idle" bằng khoảng cách giữa các lần
  setup turn (không có tiến trình nền riêng chạy khi app rảnh hoàn toàn).
- Bản dịch 6 locale chưa qua người bản ngữ soát (giới hạn chung).
- MemFS import không tự attach block mới vào bot ngoài danh sách
  `attachedBots` trong frontmatter; botId lạ trong frontmatter được bỏ qua.
- Consolidation là luật text xác định, không gọi model nên không phát
  hiện trùng lặp ngữ nghĩa sâu (vd hai cách diễn đạt khác nhau hoàn toàn
  cho cùng một fact) — chỉ trùng sau chuẩn hoá và xung đột cùng key.
