# Platform / fleet v2 + UI (sóng v1.02, đội T6)

> Xây trên tầng fleet v1 (`docs/fleet.md`) — không sửa registry/manager/
> service/usage v1. Tất cả local-first: không server trung tâm, không
> network, không tài khoản/thanh toán.

## Mô hình mới

| Thành phần | Ý nghĩa |
| --- | --- |
| Fleet console (`fleet/console.ts`) | User directory toàn fleet + role console (`admin` / `operator` / `viewer`) + overview từng bot |
| Per-bot quotas (`fleet/quotas.ts`) | Giới hạn CPU/RAM/disk cho từng bot, cảnh báo ở ngưỡng (mặc định 80%), thống kê usage |
| Bot marketplace v2 (`agent/marketplaceV2.ts`) | Catalog gộp 20 template built-in + agent đã publish local; tìm/lọc/sắp xếp, rating 1–5, cài một chạm |
| Plugin catalog (`plugins/catalog.ts`) | Quét plugin đã cài + template, gộp theo id (installed thắng), review quyền trước khi cài |

## Phân quyền console (khác role workspace v1)

Role console là **toàn fleet**, khác `FleetRole` (`admin` / `member` /
`chat-only`) vốn chỉ có hiệu lực trong một workspace:

- `admin`: mọi hành động.
- `operator`: chạy bot, cài plugin, đổi quota, start/stop service, xem usage/audit, rating. Không quản lý user/workspace.
- `viewer`: chỉ xem usage/audit + rating.

Ma trận quyền ở `FLEET_CONSOLE_PERMISSIONS`, kiểm tra bằng
`canPerform` / `assertCanPerform` (fail-closed). Không được xóa hay
hạ cấp admin cuối cùng. Mọi thay đổi user/role đều ghi vào audit log
chuỗi hash của fleet (`console.user-add`, `console.role-change`, …).

## Quota: đo thật, không bịa số

- RAM = RSS mới nhất, disk = kích thước thư mục đo được (từ usage ledger).
- CPU là **tốc độ** (core đang dùng), suy ra từ delta CPU-seconds / delta
  thời gian giữa 2 mẫu cuối (`cpuRateFromSamples`). Ít hơn 2 mẫu đo được
  → mức `unknown`, không đoán.
- Quota tắt (`enabled: false`) được lưu nhưng không bao giờ đánh giá.
- Cảnh báo: `warning` ở ≥ `warnPercent`, `breach` ở ≥ 100%.

## File layout (thêm vào `<fleetRoot>/`, `<userData>/marketplace/`)

```
<userData>/fleet/
  fleet-users.json    # user directory console (atomic, mode 0600)
  fleet-quotas.json   # quota từng bot (atomic, mode 0600)
<userData>/marketplace/
  ratings.json        # rating 1–5, một rating/user/entry
  catalog-stats.json  # số lượt cài template (published đếm trong agents.json)
```

Plugin catalog không ghi file nào: trạng thái enabled đọc từ
`<pluginsDir>/enabled.json` của loader (chỉ đọc); bật/tắt đi qua IPC
`plugins:toggle` có sẵn, cài template qua `plugin-templates:apply` —
một writer duy nhất cho trạng thái plugin.

## IPC mới (main.ts / preload.ts)

- `fleet:console-users`, `fleet:console-add-user`,
  `fleet:console-set-role`, `fleet:console-remove-user`,
  `fleet:console-assign-workspace`, `fleet:console-unassign-workspace`,
  `fleet:console-overview` (bots + alerts + quotas)
- `fleet:quotas-list`, `fleet:quotas-set`, `fleet:quotas-remove`,
  `fleet:quotas-alerts`
- `marketplace-v2:catalog`, `marketplace-v2:search`,
  `marketplace-v2:install`, `marketplace-v2:rate`
- `plugin-marketplace:catalog`, `plugin-marketplace:review`

## UI (renderer, sidebar menu — tính năng nâng cao sau menu)

- `FleetConsoleView`: tab Bots (trạng thái + thanh RAM/disk đã dùng),
  Users (directory, đổi role, thêm/xóa), Quotas (cảnh báo + sửa quota).
- `BotMarketplaceView`: tìm/lọc/sắp xếp (search chạy ở core),
  cài một chạm, chấm 1–5 sao.
- `PluginMarketplaceView`: duyệt plugin đã cài + template, bấm vào
  từng plugin xem review quyền (mức rủi ro từng quyền; quyền lạ =
  high risk), bật/tắt, cài template.
- i18n: 83 key mới (`fleetConsole.*`, `botMarketplace.*`,
  `pluginMarketplace.*`, `sidebar.*`) × 6 locale (en/vi/es/fr/ja/zh).

## Test

- `tests/fleet-console-v102.test.mjs`, `tests/fleet-quotas-v102.test.mjs`,
  `tests/bot-marketplace-v2-v102.test.mjs`,
  `tests/plugin-catalog-v102.test.mjs` — 30 test, chạy sau khi build core.
- `tests/i18n.test.mjs` bao phủ tự động các key `t('…')` trong 3 view mới.
