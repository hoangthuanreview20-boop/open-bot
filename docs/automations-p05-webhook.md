# Automations P0-5 — webhook trigger, validate-on-enable, retry-run, policy (v0.52)

Nguồn: đề xuất P0-5 §13 trong `docs/rea-grokbot-deep-dive.md` (§4.1, §4.3).
Code gốc, tự viết lại theo ý tưởng/kiến trúc — không sao chép code/text/tài sản
từ Grok Bot hay repo nào khác.

## 1. Webhook trigger

Trigger mới trên `Automation`:

```ts
{ kind: 'webhook', keyId: string }   // keyId = automation id
```

### Key

- 1 key HMAC / automation, lưu trong **store riêng**
  `WebhookKeyStore` — file `automation-webhook-keys.json` trong
  userData, namespace `webhook` (v0.59, P1-6 xong: xem
  `packages/core/src/vault/webhookKeys.ts`). Trước v0.59 key nằm
  trong Vault chính, namespace `automation-webhook-keys/` — key cũ
  được migrate lười: lần đọc đầu tiên sau nâng cấp copy key sang
  store riêng rồi xoá khỏi Vault cũ (xem
  `packages/core/src/automations/webhookKeys.ts` — hàm vẫn nhận cả
  Vault cũ, store riêng, hoặc cặp `{ store, legacyStore }`; ghi mới
  chỉ vào store riêng, xoá thì xoá cả hai kho).
- Secret = 32 byte ngẫu nhiên, hex (64 ký tự). Chỉ trả về đúng 1 lần lúc
  tạo (`createAutomationWebhookKey`) hoặc xoay (`rotateAutomationWebhookKey`).
  UI hiện secret 1 lần + nút copy/ẩn, không lưu lại. `hasAutomationWebhookKey`
  là cách duy nhất UI hỏi "đã có key chưa" (không bao giờ trả giá trị).
- Xoá automation thì main xoá cả key (best-effort).
- Lưu ý: worker P1-6 đã xong `WebhookKeyStore` riêng file
  (`packages/core/src/vault/webhookKeys.ts`, v0.53) — khoá tách file,
  namespace `webhook`, có `maxAgeMs`/`saveToVault`. V0.59 đã di dời
  key sang store riêng (xem `automations/webhookKeys.ts`): ghi mới
  chỉ vào store riêng, đọc fallback kho cũ một lần để migrate.
  Kho cũ trong Vault chính không còn được ghi nữa.

### Ký + verify (HMAC-SHA256)

```
signature = "sha256=" + hex(HMAC-SHA256(secret, rawBody))
header: x-open-bot-signature
```

- Verify trên **raw body đúng byte nhận được**, trước khi chạy bất kỳ action
  nào. Sai/thiếu/malformed chữ ký → ném lỗi, không ghi run nào, handler
  không được gọi. So sánh bằng `crypto.timingSafeEqual` (độ dài khác nhau
  thì từ chối ngay, không so sánh).
- Secret không bao giờ log.
- Payload JSON được đưa vào action: `run-agent` nối JSON payload vào prompt,
  `run-tool` merge key object payload vào args (args của action thắng),
  action khác giữ nguyên. Payload ghi lên run (`triggerInput`, cắt 2.000 ký
  tự) để retry dùng lại. **Đừng gửi secret trong payload webhook** — payload
  được lưu vào lịch sử run trên đĩa.

### Đường gọi

- Core: `AutomationScheduler.handleWebhook(automationId, rawBody, signature)`
  (cần `webhookKeyProvider` nối vào Vault — main nối sẵn trong
  `initAutomations`).
- IPC main: `automations:webhook` (`{ id, body, signature }`),
  `automations:webhook:test` (main tự ký bằng key trong Vault — secret không
  rời main process), `automations:webhook-key:create/rotate/delete/exists`.
- **Route HTTP public (v0.59)**: Local API có `POST
  /v1/automations/:id/webhook` — yêu cầu CẢ auth Local API
  (Bearer token + `X-Open-Bot-Team` khi server bind team) VÀ header
  `x-open-bot-signature` (`sha256=<hex>` trên đúng raw body nhận
  được). Handler (`ApiHandlers.deliverAutomationWebhook`, main nối
  vào `AutomationScheduler.handleWebhook`) verify HMAC bằng
  `crypto.timingSafeEqual` trước khi chạy action nào. Sai/thiếu/
  malformed chữ ký → 401, không ghi run, handler không được gọi;
  automation không tồn tại → 404; disabled / không phải trigger
  webhook / chưa có key → 400; handler chưa mount → 404. Body được
  đọc raw (không parse lại JSON) để chữ ký khớp đúng byte.
- Webhook chưa test với provider thật nào (GitHub/Slack/…): mới chỉ test
  bằng chữ ký tự tính + Vault thật + handler giả. Thuật toán: HMAC-SHA256.

## 2. Window cho cron

`trigger: { kind: 'cron', expression, window?: { minutes } }` — `minutes`
nguyên 1..1440. `missedGraceMs()` dùng window khi có, không thì mặc định
60 phút. Tick: chạy trong window, trễ hơn thì ghi run `skipped` (không bù
burst), như policy cũ.

## 3. triggerDescription + triggerPresentation

Field mới trên `Automation` (đều optional):

- `triggerDescription?: string` (≤ 500 ký tự) — mô tả tự do.
- `triggerPresentation?: { label, detail?, icon? }` — `icon` là key ổn định
  (`clock` | `calendar` | `webhook` | `bolt` | `hand`).
- Chưa lưu thì engine tự tính: `describeTrigger()` /
  `buildTriggerPresentation()`; UI dùng `getTriggerDescription()` /
  `getTriggerPresentation()` (lưu sẵn thắng fallback).

## 4. Validate-on-enable (mặc định bật)

- `validateForEnable(automation, { hasWebhookKey })` = `validateAutomation`
  + kiểm tra key webhook còn trong Vault (khi host cấp provider).
- `scheduler.setEnabled(id, true)` fail-closed: lỗi → ném
  `Cannot enable automation "<name>": <lý do>...`, automation giữ disabled.
  Tắt (`false`) không validate.
- Opt-out: `automation.validateOnEnable: false` (từng automation) hoặc
  `AutomationSchedulerOptions.validateOnEnable: false` (toàn cục, tương đương
  flag Grok `automations_validate_on_enable` mặc định bật).
- Automation opt-out có cron hỏng: `setEnabled` vẫn bật được (không tính
  được `nextRunAt` thì để `null`); tick chạy nó 1 lần (chưa chạy bao giờ =
  due) rồi bỏ qua các lần sau, không crash tick (`fire` / `recordSkipped` /
  `tick` đều bọc `nextRunAtFor`).
- `create()` / `update()` vẫn validate toàn bộ như cũ — opt-out chỉ ảnh
  hưởng lúc bật.

## 5. Retry-run

- `scheduler.retryRun(runId)` — chỉ chạy lại run `status: 'error'`, với
  đúng `triggerInput` đã lưu; run mới mang `retriedFromRunId`.
- `scheduler.retryLastFailedRun(automationId)` — lần lỗi gần nhất **chưa
  được retry thành công** (lần lỗi đã có run ok trỏ `retriedFromRunId` về
  nó thì coi như xong).
- Retry chạy **action hiện tại** của automation, không phải snapshot lúc lỗi
  — sửa action rồi retry thì bản sửa sẽ chạy.

## 6. Policy CREATE / CHANGE_POLICY theo viewer

`packages/core/src/automations/policy.ts` (theo
`GrokBotAutomationPolicyAction` + `viewerCapabilities` của Grok, map sang
team role local của open-bot):

| Role | Được làm |
|---|---|
| admin | Tất cả, kể cả CHANGE_POLICY |
| member | CREATE, OPEN, TOGGLE, EDIT, DELETE — nhưng EDIT/TOGGLE/DELETE chỉ automation mình tạo (`createdBy`); automation legacy (`createdBy: ''`) thì được |
| viewer | Chỉ OPEN (xem, không đổi/không chạy) |

- Đổi `access` hoặc `createdBy` của automation cần `CHANGE_POLICY`
  (admin-only).
- `automation.access.roles` giới hạn thêm: role phải nằm trong danh sách
  (admin luôn qua — để luôn cứu được automation).
- Chạy automation (`runNow` / retry) kiểm tra ở mức TOGGLE: Grok không có
  action RUN riêng; actuating đổi trạng thái runtime như toggle.
- Scheduler chỉ enforce khi host cấp `policyChecker` (không cấp = install
  single-user, cho hết). `currentUserId` được ghi làm `createdBy` lúc tạo.
- Đây là model chia sẻ local cho install tin cậy (như module team) — không
  phải access control chống user thù địch. **Main process đã nối viewer
  thật (v0.59)**: `initAutomations` cấp `policyChecker` đọc role team
  của user local (`LOCAL_USER_ID = 'local'`) MỖI lần check + `currentUserId:
  'local'` — viewer chỉ OPEN, member chỉ sửa automation mình tạo, admin
  làm tất; không đọc được team config hoặc không xác định được viewer thì
  checker chặn hết (fail-closed). Không có team member nào, hoặc owner
  không phải member, thì không giới hạn (như install single-user).

## 7. UI

`AutomationsView.tsx`: chọn trigger webhook, nhập window cron (phút, để
trống = mặc định), checkbox validate-on-enable (mặc định bật), hiện
`triggerDescription` (fallback sang mô tả tính sẵn) + presentation, quản lý
key webhook (tạo/xoay/xoá/gửi thử; secret hiện 1 lần), nút Retry trên từng
run lỗi. IPC/preload/`global.d.ts` expose đủ method mới (kể cả interface
`OpenBotApi` trong `preload.ts`).

## 8. Test

`tests/automations-webhook-p05.test.mjs` — 17 test (xem file để biết danh
sách đầy đủ). Chạy sau khi build core:

```sh
npm run build --workspace=@open-bot/core
node --test tests/automations-webhook-p05.test.mjs tests/automations.test.mjs
```

v0.59 thêm `tests/automations-webhook-http-v059.test.mjs`: route HTTP
`POST /v1/automations/:id/webhook` (chữ ký đúng/sai/thiếu/malformed,
sai auth Local API, payload vào action), policy theo role, và migration
key cũ → store riêng:

```sh
node --test tests/automations-webhook-http-v059.test.mjs
```
