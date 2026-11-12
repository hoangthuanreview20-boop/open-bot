# Tầng fleet đa người dùng (đội D)

> Core của open-bot là **single-user**. Đa người dùng thật nằm ở **tầng
> fleet riêng** đặt trên core — không mở rộng core thành multi-user.
> Kết luận này lấy từ nghiên cứu OpenMausBot (xem `docs/team-b-platform.md`):
> core single-user, đa người dùng thật ở tầng fleet riêng.

## Mô hình

Một **fleet workspace** = một người dùng trong fleet:

| Thành phần | Ý nghĩa |
| --- | --- |
| 1 OS user riêng (`osUser`) | Cô lập ở mức hệ điều hành khi chạy đặc quyền (xem § Cô lập) |
| 1 service riêng | Process node chạy `serviceWorker.js`, chỉ trả lời `GET /health` |
| 1 port loopback riêng | Cấp tự động trong dải 18000–18999, kiểm tra thật là trống trước khi dùng |
| 1 thư mục riêng | `<fleetRoot>/workspaces/<id>/`, tạo với mode 0700 |
| 1 vault namespace riêng | `fleet:<workspaceId>` — secret không lẫn giữa workspace |

Fleet root mặc định: `<userData>/fleet` (desktop) hoặc `<dataDir>/fleet`
(CLI, `--data-dir` / `OPENBOT_DATA_DIR` / `~/.open-bot`).

## File layout

```
<root>/
  fleet.json        # registry workspace (ghi atomic tmp+rename, mode 0600)
  fleet.jsonl       # audit log — chuỗi hash SHA-256 (xem § Audit)
  decisions.jsonl   # decision log — chuỗi hash SHA-256
  usage.jsonl       # usage ledger (tối đa 1000 mẫu/workspace)
  workspaces/
    <id>/           # thư mục dữ liệu riêng từng workspace
```

## Thành phần (`packages/core/src/fleet/`)

- **`types.ts`** — `FleetWorkspace`, `FleetMember`, `FleetRole`
  (`admin` / `member` / `chat-only`), `FleetStatusView`, `FleetUsageSummary`,
  `FleetCapacityCheck`, `FleetDecision`. Mọi chuỗi hiển thị với người dùng
  viết tiếng Việt trước, kèm key i18n.
- **`registry.ts`** — CRUD thuần trên `fleet.json`: validate (osUser regex,
  serviceName regex, port 1024–65535 duy nhất, rootDir tuyệt đối duy nhất,
  CPU ≥ 0.5, RAM ≥ 128 MB, đĩa ≥ 1 GB), `pickFreePort` (18000–18999).
- **`audit.ts`** — chuỗi hash SHA-256 tái dùng từ `team/audit`: mỗi event
  có `seq`, `prevHash`, `hash` trên canonical JSON. `decision`/`reason`
  nằm TRONG `detail` để chuỗi hash bao phủ chúng. `verifyFleetAuditLog` /
  `verifyFleetDecisionLog` trả `{ ok, checked }` hoặc `{ ok: false, badLine, reason }`.
- **`capacity.ts`** — tái dùng `probeMachine` + `resolvePlannerPolicy` +
  `isHostBusy` của `compute`: cùng công thức reserve với `planComputers`
  (CPU chừa `min(max(total-1,0), max(2, ceil(total*0.25)))` core; RAM chừa
  `max(2 GB, 25% tổng)` nhưng không quá nửa RAM trống; đĩa chừa 5 GB).
  Từ chối kèm lý do (`not-enough-cpu` / `not-enough-ram` /
  `not-enough-disk` / `too-many-workspaces`, mặc định tối đa 8 workspace).
  Workspace `suspended` không tính vào ngân sách đã cấp.
- **`isolation.ts`** — `resolveFleetWorkspacePath` (chống `..` và symlink
  trỏ ra ngoài bằng `realpath`, fail-closed), `readWorkspaceFile` /
  `writeWorkspaceFile` (ghi atomic), `assertWorkspaceRootInsideFleet`,
  `fleetVaultNamespace` / `fleetVaultKey`, `probeOsUser` (`id -u`),
  `getOsUserUid`, `resolveIsolationLevel`.
- **`service.ts` + `serviceWorker.ts`** — vòng đời service: spawn
  `process.execPath` + worker (detached process group trên POSIX, env chỉ
  `PATH` + token, `uid` khi ở mức `os-user`); chờ ready bằng poll
  `/health` tối đa 10s; stop SIGTERM cả group, chờ 5s rồi SIGKILL
  (Windows: `taskkill /T /F`); restart = stop + start (token mới);
  tự restart khi service đang chạy chết bất ngờ (backoff 200ms/1s/3s,
  **tối đa 3 lần tính từ lần chạy đầu**, rồi state `error`).
- **`usage.ts`** — đo thật: CPU/RSS từ `/proc/<pid>/stat` và
  `/proc/<pid>/status` (chỉ Linux, còn không thì `null`); đĩa bằng cộng
  dồn file (không theo symlink, giới hạn 20.000 file, vượt thì `null`).
  Prune lười khi > 5000 dòng.
- **`manager.ts`** — `FleetManager` điều phối toàn bộ: create (kiểm tra
  sức chứa trước — không đủ thì ghi decision `deny` + throw, không tạo
  gì; cấp port tự động + kiểm tra port thật sự trống; tạo thư mục 0700),
  rename/remove (service phải dừng trước; `deleteData` chỉ xoá khi thư
  mục nằm trong fleet root), suspend/activate, members (add/remove/
  set-role), start/stop/restart/health (cập nhật registry pid/state),
  getStatus/listFleet (kiểm tra liveness của pid đã lưu — không báo
  chạy khi process đã chết), usage, verify/list audit + decisions,
  read/write file qua isolation (vi phạm bị chặn thì ghi audit
  `file.read-denied` / `file.write-denied`).

## Cô lập — mức nào là thật?

| Mức | Điều kiện | Ý nghĩa |
| --- | --- | --- |
| `os-user` | Không phải Windows + **đang chạy đặc quyền (root)** + OS user tồn tại | Service spawn với `uid` của OS user đó |
| `directory` | Còn lại | Thư mục riêng + port riêng + vault namespace riêng (không cách ly UID) |

**Không bao giờ báo cao hơn thực tế**: `resolveIsolationLevel` trả mức
thật kèm lý do (vd "chưa chạy đặc quyền"). Trên máy dev chạy không
phải root, mọi workspace đều ở mức `directory` — đó là trạng thái đúng,
không phải lỗi. Windows: chưa hỗ trợ kiểm tra/spawn với OS user khác.

Đọc chéo giữa workspace bị chặn ở tầng đường dẫn (test chứng minh:
`../`, đường dẫn tuyệt đối của workspace khác, symlink trỏ ra ngoài
đều throw). Vault tách theo namespace `fleet:<id>`.

## Bảo mật

- **Loopback-trust**: service chỉ bind `127.0.0.1`, không bao giờ
  expose port ra ngoài. Health check cần `Authorization: Bearer <token>`
  (token 32 byte ngẫu nhiên, tạo lúc start, chỉ giữ trong bộ nhớ);
  không token → 401, token sai → 401, route khác → 404.
- **Token không bao giờ ghi ra đĩa.** Hệ quả: process khác (vd CLI)
  không health-check được service do desktop start — dùng
  `fleet status` (kiểm tra pid còn sống) thay thế. Sau khi app khởi
  động lại, service được coi là `stopped` cho tới khi start lại
  (registry chỉ giữ trạng thái đã persist).
- **Audit chỉ phát hiện sửa lén không tính lại hash** — không chống
  được người có quyền sửa file tính lại toàn bộ chuỗi. Giả định một
  writer duy nhất (main process).
- **MCP server sau này KHÔNG expose** duyệt/xoá/credential/vòng đời
  computer (nguyên tắc từ nghiên cứu OpenMausBot).
- Secret không bao giờ copy toàn bộ `process.env` của host; env của
  service chỉ có `PATH` + token.

## Dùng qua UI

Sidebar → **Fleet** (🚢). Màn hình liệt kê workspace (trạng thái
service, port, OS user, mức cô lập, CPU/RAM/đĩa đã cấp, mức dùng đo
được, thành viên), tạo mới (kèm nút kiểm tra sức chứa trước), start /
stop / restart, suspend / activate, xoá (tuỳ chọn xoá cả thư mục dữ
liệu), đo mức dùng, và dòng trạng thái verify audit + decision log.
Key i18n `fleet.*` + `sidebar.fleet` ở cả 6 locale (vi/en/zh/ja/es/fr).

## Dùng qua CLI

```sh
open-bot fleet list [--json]
open-bot fleet create --name alice --os-user alice [--cpu 1] [--ram-gb 1] [--disk-gb 10] [--json]
open-bot fleet status <id> [--json]
open-bot fleet start|stop|restart|suspend|activate <id> [--json]
open-bot fleet remove <id> [--delete-data] [--json]
open-bot fleet capacity [--cpu 1] [--ram-gb 1] [--disk-gb 10] [--json]
open-bot fleet audit [--json]        # verify + 20 sự kiện gần nhất
open-bot fleet decisions [--json]    # verify + 20 quyết định gần nhất
open-bot fleet usage <id> [--json]   # đo + ghi 1 mẫu mức dùng
open-bot fleet add-member <id> --user <userId> --role <admin|member|chat-only> [--json]
open-bot fleet remove-member <id> --user <userId> [--json]
open-bot fleet set-role <id> --user <userId> --role <admin|member|chat-only> [--json]
```

`start`/`restart` để service chạy tiếp sau khi CLI thoát (spawn
detached). `stop` dùng pid đã lưu trong registry nên dừng được service
do desktop start (cross-process, có test). Exit code: 0 = xong,
1 = lỗi / không đủ sức chứa / audit verify lỗi.

## IPC (`fleet:*`, desktop)

`fleet:list`, `fleet:status`, `fleet:create`, `fleet:remove`,
`fleet:rename`, `fleet:suspend`, `fleet:activate`, `fleet:start`,
`fleet:stop`, `fleet:restart`, `fleet:health`, `fleet:capacity`,
`fleet:audit`, `fleet:audit-verify`, `fleet:decisions`,
`fleet:decisions-verify`, `fleet:usage`, `fleet:record-usage`,
`fleet:add-member`, `fleet:remove-member`, `fleet:set-member-role`.
Preload expose cả kênh `fleet:*` lẫn alias camelCase (`listFleet`,
`createFleetWorkspace`, …). Actor ghi audit = OS user đang chạy app.
Service dừng toàn bộ ở `before-quit`.

## Giới hạn còn lại (trung thực)

- OS-user isolation cần chạy đặc quyền; trên máy user thường chỉ có
  mức `directory` (đúng thiết kế, không phải bug).
- Windows: spawn với `uid` khác chưa hỗ trợ; đo CPU/RSS chỉ có trên
  Linux (còn không thì `null`, chỉ còn đĩa).
- CLI không health-check được service do process khác start (token
  chỉ trong bộ nhớ của process đã start) — dùng `fleet status`.
- Audit chain không chống được kẻ sửa file rồi tính lại hash; giả
  định một writer duy nhất.
- Chưa có: tạo OS user tự động (cần quyền admin, phải làm tay),
  giới hạn tài nguyên thật theo workspace (cgroup — mới chỉ có ở tầng
  máy-tính-bot), quota đĩa enforce, UI quản lý thành viên (IPC + CLI
  đã có `add-member` / `remove-member` / `set-role`, UI sẽ thêm sau).
- VM thật cho workspace: chưa có — fleet hiện dùng service process
  trên host (box → container → VM là thang của tầng máy-tính-bot,
  xem `docs/team-b-platform.md`).
