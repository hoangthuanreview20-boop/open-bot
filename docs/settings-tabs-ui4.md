# Settings tabs + search + standalone Connected apps (UI-4, v0.59)

- **Nhiệm vụ:** `docs/ui-parity-review.md` §3.6 (T1–T3), §4 hạng 4, §5 UI-4.
- **Nguyên tắc:** chỉ tái cấu trúc render — giữ nguyên toàn bộ logic,
  IPC, state, i18n key vi/en (không đổi tên key, không bỏ section nào,
  không đổi hành vi nút nào).

## Trước UI-4

`apps/desktop/src/renderer/components/SettingsView.tsx` 2.422 dòng,
~20 section xếp dọc trong 1 trang cuộn dài: 19 nhóm section + 6 card
provider API key + 1 section Composio lồng trong section Connected apps
= **25 `<section>`**.

## Sau UI-4 — 5 tab

| Tab | Label key | Section |
|---|---|---|
| Chung (`general`) | `settings.tab.general` | usage, language, update, limits, usageReset |
| Bot & Model (`bot-model`) | `settings.tab.botModel` | smallModelGuard, autoApprove, models, engines, providers (6 card) |
| Kết nối & Apps (`connections`) | `settings.tab.connections` | connectors + thẻ link mở Connected apps |
| Bảo mật & Vault (`security`) | `settings.tab.security` | auth, vault, onePassword (v0.59, song song) |
| Nâng cao (`advanced`) | `settings.tab.advanced` | dream, perf, plugins, hooks, api (Local API + token + webhooks) |

Mỗi tab cuộn riêng; nút Lưu provider nằm cuối tab Bot & Model (nó lưu
cài đặt provider). Thứ tự section trong mỗi tab giữ đúng thứ tự tương
đối của trang dài cũ.

## Tìm kiếm setting

Ô tìm kiếm trên đầu Settings (`data-testid="settings-search"`,
placeholder `settings.searchPlaceholder`). Gõ truy vấn thì hiển thị các
section khớp **từ mọi tab**, gom dưới tiêu đề tab của chúng; không khớp
thì hiện `settings.searchNoResults`. Xoá truy vấn thì trở về tab đang mở.

- Từ khoá ở `components/settings/settingsTabs.ts` (`SECTION_KEYWORDS`,
  vi + en). Khớp không phân biệt dấu: "bao mat" tìm "bảo mật".
- Ví dụ: "vault" → Vault + 1Password; "webhook" → Local API;
  "composio" → thẻ link Connected apps (tab Kết nối & Apps);
  "model" → small-model guard, models, providers.
- Hàm thuần `filterSections(query)` — test ở `tests/settings-ui4.test.mjs`.

## Connected apps — màn hình riêng

Section Connected apps (M7) + Composio (v0.57) rời khỏi Settings:

- View mới `components/ConnectedAppsView.tsx`, route `'connected-apps'`
  trong `App.tsx`, nút `🧩 App đã kết nối` (`sidebar.connectedApps`)
  ở sidebar, và thẻ link trong tab Kết nối & Apps của Settings.
- Dữ liệu + IPC chuyển nguyên vẹn sang hook
  `components/settings/useConnectedApps.ts` (`apps:list`,
  `apps:disconnect`, `composio:*`, `auth:oauth-start`). Không đổi
  channel, handler hay key i18n nào.
- Một thay đổi nhỏ về vị trí (không đổi hành vi): ô nhập OAuth client
  id/secret của từng app trước đây nằm ở section Connectors trong
  Settings; giờ nằm ngay cạnh nút Connect của app đó trong view mới —
  vì view mới không còn ở cùng trang với Connectors.

## Cách tách code (không mất state khi chuyển tab)

- `SettingsView.tsx` (2.422 → ~1.512 dòng) vẫn giữ **toàn bộ** state,
  IPC, handler. Nó chỉ còn: load dữ liệu, header + tab bar + ô tìm
  kiếm, và render tab đang mở.
- Mỗi tab là component thuần render trong `components/Settings*Tab.tsx`,
  nhận một object `s: SettingsShared` duy nhất
  (`components/settings/settingsShared.ts`) và destructure đúng tên
  cũ — JSX của section chuyển verbatim, chỉ thêm `data-section` và
  cổng lọc `onlySections` (chế độ tìm kiếm). Tab không có `useState`
  hay `useEffect` riêng nên chuyển tab (unmount/remount JSX) không
  thể làm mất draft hay toggle — state nằm ở component cha.
- Metadata tab/tìm kiếm: `components/settings/settingsTabs.ts`
  (`SETTINGS_TABS`, `SECTION_TAB`, `SECTION_KEYWORDS`,
  `filterSections`). Tab bar: `components/SettingsTabBar.tsx`.
- `CONNECTOR_META`, `MODEL_FEATURES`, `WEBHOOK_EVENTS` trong
  `SettingsView.tsx` được export để tab dùng chung (trước đây là
  `const` nội bộ).
- Key i18n mới (đều có ở cả vi/en): `settings.tab.*` (5 tab),
  `settings.searchPlaceholder` / `settings.searchNoResults`,
  `settings.connectedAppsOpen` / `settings.connectedAppsHint`
  (3 key sau đã có sẵn từ trước do worker khác thêm),
  `sidebar.connectedApps`. CSS tab ở cuối `styles.css`
  (`.settings-tabs`, `.settings-tab.active`, `.settings-search`).

## Kiểm đếm không mất section

Tổng `<section>` sau UI-4 vẫn đủ 25 cũ + 1 section 1Password (v0.59,
thêm song song, thuộc tab Bảo mật & Vault theo đúng ghi chú của worker
đó) = **26**: Settings 24 (19 nhóm, providers = 6 card) + Connected
apps 2 (apps + Composio). Test `tests/settings-ui4.test.mjs` đếm bằng
marker `data-section` (provider card dùng
`data-section={`provider-${meta.id}`}`).

## Kiểm chứng

- `npm run typecheck --workspace=@open-bot/desktop` — pass.
- `npm run build --workspace=@open-bot/desktop` — pass
  (tsc + vite + main; chỉ cảnh báo chunk > 500 kB có sẵn từ trước).
- `node --test tests/settings-ui4.test.mjs` — 8/8 pass.
- `xvfb-run -a node --test tests/settings-ui4-smoke.test.mjs` — 1/1
  pass (Electron thật qua CDP: mở Settings, chuyển tab, tìm kiếm,
  giữ draft khi chuyển tab, mở Connected apps từ sidebar, Back về chat).
- `node --test tests/voice-v059.test.mjs` — 15/15 pass (gồm test
  1Password UI vốn đã chờ section nằm ở `SettingsSecurityTab`).

## Giới hạn / lưu ý cho điều phối viên

- Tìm kiếm chỉ **lọc** section, chưa highlight từ khớp trong nội dung
  section (task ghi "lọc/highlight" — phần highlight chưa làm).
- `tests/i18n.test.mjs` có 2 test fail do worker khác (không phải UI-4):
  `ToolsView.tsx:2` còn comment tiếng Việt, và key `chat.runStopped`
  (UI-2, dùng ở `App.tsx:506`) chưa có trong locale. 2 assertion về
  language trong file đó đã được cập nhật sang `SettingsGeneralTab`
  (language section chuyển nhà) — xem hunk dưới.
- Trong lúc làm, các worker UI-2/UI-3/UI-5 và 1Password cùng sửa
  `App.tsx` / `Sidebar.tsx` / `SettingsView.tsx` / locale (chưa commit).
  Có một lần build fail giữa chừng vì worker UI-5 đang sửa dở Sidebar
  Props (thiếu thread props ở App); chạy lại sau khi họ nối xong thì
  pass. Các hunk UI-4 dưới đây dùng edit exact-text nên không đè việc
  của họ; khi merge cần đối chiếu lại.
- Không commit, không push (theo nhiệm vụ).
