# Máy tính riêng cho từng bot — `packages/core/src/compute/`

Sóng B (đội platform). Mỗi bot có một máy tính riêng: app dò cấu hình
máy thật của người dùng, rồi chia tài nguyên cho từng bot — luôn chừa
headroom cho host, không ảnh hưởng việc người dùng dùng máy.

## Ba module tách riêng

| Module | Vai trò | I/O? |
| --- | --- | --- |
| `probe.ts` | Dò cấu hình máy thật (CPU/RAM/đĩa/OS/ảo hoá/GPU/mạng) | Có (os + lệnh chỉ-đọc) |
| `planner.ts` | Chia tài nguyên cho các yêu cầu (thuần) | Không |
| `scheduler.ts` (v0.90c) | Hàng đợi chờ + thử lại khi rảnh + chọn máy tự giảm tải | Không (thuần) |
| `runtime.ts` | Vòng đời máy-tính-bot + backend + QEMU boot + giảm tải | Có (fs/spawn) |

## Probe (`probeMachine`)

- Linux/Windows/macOS. Dùng `node:os` + lệnh chỉ-đọc (`df`, `sysctl`,
  `powershell`, `lspci`, `system_profiler`).
- Mọi lần đo đều best-effort: đo không được thì ghi vào
  `MachineProfile.warnings`, KHÔNG throw, KHÔNG bịa số.
- Test dùng dữ liệu giả qua `ProbeDeps` (xem
  `tests/computers-b-platform.test.mjs`) — không phụ thuộc máy chạy test.

## Planner (`planComputers`)

Nguyên tắc an toàn — KHÔNG ẢNH HƯỞNG NGƯỜI DÙNG (yêu cầu cứng):

- CPU: chừa cho host `max(reserveCpuCores=2, 25% tổng core)`, nhưng
  luôn để lại ít nhất 1 core cho bot (máy 2 core vẫn chạy được box).
- RAM: tính trên RAM TRỐNG hiện tại, trừ `max(2GB, 25% tổng RAM)`,
  nhưng không chừa quá 50% RAM trống (máy ít RAM vẫn chạy được box —
  host luôn giữ ít nhất nửa RAM trống còn lại).
- Đĩa: chừa 5GB trên ổ hệ thống.
- Hết ngân sách thì yêu cầu sau bị từ chối kèm lý do rõ ràng
  (`insufficient-resources` / `too-many-computers`) — không cấp quá.
- Mức cách ly chọn theo sức máy: `auto` thử VM → container → box.
  Mức tường minh không khả thi thì HẠ MỨC, ghi `downgradedFrom` +
  warning — không bịa là đã cấp mức cao.
- `isHostBusy`: tải/core > 0.8 hoặc RAM trống < 15%.
- `suggestShedOrder`: ưu tiên thấp trước, hoà thì RAM lớn trước.

Mức tối thiểu mỗi máy: box 0.5 core / 512MB / 1GB; container 1 core /
1GB / 2GB; VM 2 core / 4GB / 10GB.

## Scheduler — hàng đợi + tự giảm tải (`scheduler.ts`, v0.90c)

Planner là one-shot: hết ngân sách thì yêu cầu bị từ chối và mất.
Scheduler giữ các yêu cầu chưa đủ chỗ trong HÀNG ĐỢI:

- Mỗi bot có priority 0..100 (mặc định 50); thử lại theo priority
  giảm dần, FIFO trong cùng priority (theo `enqueuedAt` — mốc này
  được ép tăng đơn điệu +1ms khi 2 entry vào cùng 1 mili-giây, nếu
  không FIFO sẽ rơi về thứ tự botId). Một bot tối đa 1 entry (enqueue
  lại thì cập nhật request/priority, giữ `enqueuedAt` cũ). Trần 32
  entry — đầy thì enqueue throw lỗi rõ.
- Thử lại (`tryPromoteQueue`): chạy `planComputers` với các request
  đã nhận + ứng viên; ứng viên chỉ được promote khi plan mới VẪN cấp
  đủ cho mọi entry đã nhận (tránh ứng viên cùng priority nhưng botId
  nhỏ hơn chen lên làm vỡ ngân sách). Host bận thì KHÔNG promote gì.
  Runtime truyền tài nguyên đã cấp cho máy ĐÃ TỒN TẠI
  (`alreadyAllocated`) để tick không cấp vượt.
- Tick (`BotComputerRuntime.tickScheduler`, main gọi trong handler
  `computers:list` — UI poll 5s): host rảnh + có entry chờ thì
  promote (tạo bản ghi máy, trạng thái `stopped` — user bấm start khi
  sẵn sàng, không tự chạy); host bận + auto-shed đang bật thì tạm
  dừng tối đa 1 máy đang chạy có priority thấp nhất, ghi lý do vào
  `lastPauseReason` + gọi `onAutoShed` (main nối vào audit log
  `team/audit.ts`, action `computer.auto-shed`).
- **Auto-shed là OPT-IN, mặc định TẮT** (`autoShed: false`): tự dừng
  máy của bot có thể gây bất ngờ nên chỉ bật khi user tick checkbox
  trong ComputersView (hoặc IPC `computers:set-auto-shed`). Tắt thì
  `tickScheduler` không bao giờ tự dừng máy nào.
- Bền vững: hàng đợi + cờ auto-shed lưu trong `computers.json`
  (version 2: `queue` + `autoShed`); file cũ version 1 đọc thành
  state rỗng; entry hỏng bị bỏ qua lặng lẽ (xem `parseSchedulerState`).
  Entry nào trỏ tới bot đã có máy thì bị bỏ khi nạp lại.
- IPC: `computers:queue` (xem hàng đợi), `computers:set-priority`
  (đổi priority — máy đã có thì đổi priority máy, đang chờ thì đổi
  entry, chưa có gì thì tạo entry chờ mới với request mặc định),
  `computers:set-auto-shed` (bật/tắt). `computers:create` đưa bot bị
  planner từ chối vào hàng đợi thay vì mất.

**Giới hạn thật:** `computers:create` vẫn lập kế hoạch chỉ từ các bot
mới (không trừ tài nguyên máy đã tồn tại) — tick scheduler đã trừ
(`alreadyAllocated`) nên hàng đợi không cấp vượt, nhưng lần tạo đầu
tiên có thể cấp vượt so với máy đã có. Sửa ở sóng sau bằng cách đưa
máy hiện có vào `planComputers` ở `computers:create`.

## Runtime (`BotComputerRuntime`)

Thang cách ly (theo sức máy):

- `box` — thư mục riêng + env allow-list (`BotBoxManager`). Luôn có.
- `container` — box chạy trong namespace thật (bwrap/unshare). Máy
  không có bwrap/unshare thì mức container HẠ XUỐNG box và ghi cảnh
  báo rõ trong `statusView` — không bao giờ báo đã cách ly khi chỉ
  là box thường.
- `vm` — VM local thật (QEMU/KVM). Cần disk image do người dùng cung
  cấp (opt-in); chưa có image thì `startComputer()` trả state `error`
  kèm lý do rõ ràng, không giả vờ đã boot. Backend Windows/macOS
  (WSL2/Hyper-V/Virtualization.framework) hiện chỉ dò có mặt/không —
  boot chưa implement (follow-up).

Vòng đời: `stopped -> running -> paused -> running -> stopped`.

- `pause`: VM có pid thì SIGSTOP thật (đóng băng VM); box/container
  chỉ đánh dấu paused — chặn lệnh mới, không có tiến trình thường trú
  để đóng băng.
- `resume`: VM đã thoát hẳn thì phải `start` lại để boot (throw lỗi
  rõ ràng nếu gọi resume).
- `stop`: VM thì SIGTERM process group QEMU; box/container thì dừng
  egress gate.
- `runInComputer`: chỉ khi đang `running`; VM chạy lệnh qua guest
  agent (v0.78, M3 — xem mục Guest agent dưới); VM chưa cài guest
  thì throw lỗi rõ kèm hướng dẫn cài, thay vì chạy lệnh trên host
  rồi báo là "chạy trong VM".

Tài nguyên đã cấp được enforce ở mức box bằng prlimit (Linux) qua
`BotBoxManager`: `cpuSeconds = cpuCores * timeout` (không đốt CPU quá
số core đã cấp), `maxMemoryBytes = ramBytes`, `maxProcesses = 256`.
Xem `../sandbox/box.ts` (`wrapWithPrlimit`).

## Enforce RAM vật lý — cgroup v2 (`cgroup.ts`, v0.78)

prlimit `--as` chỉ giới hạn không gian địa chỉ ẢO (floor 4GB vì Node
cần >= 4GB ảo) — RAM vật lý thật được enforce bằng cgroup v2
`memory.max` (`CgroupMemoryLimiter`, một cgroup `open-bot-<botId>`
cho mỗi máy-tính-bot mức box/container). `BotComputerRuntime` probe
cgroup một lần lúc tạo (`probeCgroupMemory`: controllers có `memory`
+ tạo được cgroup + ghi được `memory.max`); khả dụng thì tạo limiter
khi `createComputer`/`startComputer` và đưa PID của process box vào
`cgroup.procs` ngay sau spawn (hook `onSpawn`/`setSpawnHook` của
`BotBoxManager` — cả spawn chính lẫn fallback; process con kế thừa
cgroup nên toàn bộ cây đều bị giới hạn). `statusView` báo
`memoryEnforcement: 'cgroup-v2' | 'prlimit-only'` + lý do +
`memoryUsageBytes` (đọc `memory.current`). VM không dùng cgroup — RAM
của VM đã bị chặn bởi QEMU `-m`. **Giới hạn thật, kiểm chứng trên máy
dev này:** kernel cgroup v2 có mount nhưng userns không delegate
controller nào (`cgroup.controllers` rỗng) nên probe trả unavailable
và runtime giữ prlimit — logic kiểm chứng bằng cgroup root GIẢ
(xem `tests/computers-cgroup-v078.test.mjs`), chưa từng chạy trên
cgroup thật. Trên máy có delegate `memory` (vd Linux thật, root hoặc
systemd delegate) thì enforce thật.

Mạng ra ngoài của box/container đi qua `EgressGate` riêng từng máy
(policy resolve từ team — caller truyền vào khi tạo). Mạng của VM
(v0.78, M2): mặc định `-nic none` (`BotComputer.vmNetwork` không đặt
hoặc `'none'`) — VM hoàn toàn không ra mạng; chọn `'nat'`
(`runtime.setVmNetwork`, IPC `computers:set-vm-network`, chọn trong
ComputersView) thì QEMU dùng user-mode NAT (`-nic user`) và **egress
policy KHÔNG enforce được trong VM** (mạng ra ngoài đi thẳng qua
QEMU, không qua EgressGate); `statusView.vmNetworkWarning` báo rõ
điều này trong UI. Thay đổi hành vi so với trước v0.78: bản ghi cũ
không có `vmNetwork` trước đây boot với `-nic user`, nay boot với
`-nic none` — an toàn hơn, nhưng VM cũ từng có mạng sẽ mất mạng cho
tới khi chủ động chọn NAT.

## Guest agent — chạy lệnh trong VM (`guestAgent.ts` + `guest-agent.mjs`, v0.78)

Boot VM luôn kèm chardev guest agent (`buildQemuBootArgs` thêm
`-chardev socket,path=<rootDir>/<botId>.agent.sock,server=on,wait=off,id=agent0`
+ `virtio-serial-pci` + `virtserialport ... name=org.open-bot.guest-agent`).
Host (`GuestAgentClient`) kết nối tới socket đó và nói NDJSON với
guest: `{"id":n,"type":"exec","command","args","timeoutMs","cwd"}` →
`{"id":n,"type":"result","code","stdout","stderr"}` hoặc
`{"id":n,"type":"error","message"}`. `runInComputer` cho VM kết nối
lười (lazy) khi chưa có client; timeout trả kết quả `timedOut: true`
(như box); lệnh lỗi protocol / socket ngắt thì throw rõ.
`statusView.guestAgentConnected` báo trạng thái kết nối (chỉ mức VM);
`stop` / QEMU thoát thì ngắt client. Output mỗi chiều cap 4MB.

**Health check (v0.90c):** thêm lệnh `ping`/`info` cả hai phía
(`guest-agent.mjs` trả `pong`/`info` kèm `version: '0.90c'` +
`uptimeSeconds` + `node`/`platform`/`arch`). `GuestAgentClient.ping()`
trả `{status:'ok', version, uptimeSeconds, rttMs}` hoặc
`{status:'unknown'}` khi guest CŨ (trước v0.90c) trả lỗi cho ping hoặc
timeout — không throw, không crash; `info()` trả object hoặc `null`
khi guest không hỗ trợ. Reply `pong`/`info` tới muộn (sau timeout)
được bỏ qua lặng lẽ thay vì coi là lỗi protocol (tránh đóng socket
chỉ vì health check tới muộn). `reconnect()` thử lại tối đa 3 lần,
cách nhau 500ms, trả boolean (không vòng lặp vô hạn).
`BotComputerRuntime.checkGuestHealth(botId)` ping thật và trả
`'ok' | 'missing' | 'unhealthy' | 'unknown'` (+ hint cài guest khi
missing/unhealthy, hint cập nhật guest khi unknown); socket đứt giữa
chừng thì reconnect tối đa 3 lần rồi ping lại. `refreshGuestHealth`
throttle tối đa 1 lần / 15s / bot (main gọi fire-and-forget trong
handler `computers:list` nên UI poll 5s sẽ thấy kết quả ở lần sau);
`statusView.guestAgentHealth` đọc cache (VM chưa kiểm tra lần nào →
`'unknown'`). IPC `computers:guest-health` kiểm tra thật ngay (bypass
throttle — nút Kiểm tra trong UI).

**Cài guest trong VM (user tự làm — image là của user):**

1. Copy file `packages/core/src/compute/guest-agent.mjs` vào VM
   (vd `/opt/open-bot/guest-agent.mjs`). Script Node thuần, không
   dependency, cần Node >= 18 trong VM.
2. Chạy: `node /opt/open-bot/guest-agent.mjs /dev/virtio-ports/org.open-bot.guest-agent`
   — hoặc bền vững hơn bằng systemd unit:
   ```ini
   [Unit]
   Description=open-bot guest agent
   After=network.target
   [Service]
   ExecStart=/usr/bin/node /opt/open-bot/guest-agent.mjs /dev/virtio-ports/org.open-bot.guest-agent
   Restart=always
   [Install]
   WantedBy=multi-user.target
   ```
   rồi `systemctl enable --now open-bot-guest-agent`.
3. Khởi động lại VM trong open-bot rồi chạy lệnh — lần chạy đầu sẽ
   tự kết nối guest agent.

**Giới hạn thật:** chưa từng chạy trên VM thật (máy này không có
QEMU/image qcow2) — client + script guest + nối dây runtime chỉ
kiểm chứng bằng Unix socket giả (fake guest + script guest thật
chạy trên host, xem `tests/computers-guest-agent-v078.test.mjs`).
Guest không tự kiểm tra lệnh nguy hiểm — VM đã là biên cách ly;
host chỉ gửi lệnh khi user/bot được phép chạy trong máy đó.

Bền vững: `computers.json` dưới `rootDir` (ghi atomic tmp + rename).
Máy đang `running`/`paused` lúc app tắt thì lần mở sau về `stopped`
(không bịa là đang chạy khi tiến trình đã chết theo app).

## UI

`apps/desktop/src/renderer/components/ComputersView.tsx` + IPC
`computers:*` trong `apps/desktop/src/main/main.ts` (probe cache 30s)
+ preload + `global.d.ts` + key i18n `computers.*` (vi+en) + mục
sidebar/palette "Máy tính của bot". Xem `docs/team-b-platform.md`.

**Trạng thái trực tiếp (v0.90c):** ComputersView poll
`computers:list` mỗi 5 giây khi đang mở (kèm `computers:queue`) và
`computers:probe` mỗi 30 giây (khớp cache probe phía main) — tạm dừng
poll khi tab ẩn (`visibilitychange`, refresh ngay khi hiện lại), dọn
interval khi unmount, chống gọi chồng nhau khi IPC chậm, và chỉ
`setState` khi JSON trả về khác lần trước (không render lại vô ích
khi không có máy mới / trạng thái không đổi). Màn hình hiện trạng thái
host bận, lý do tạm dừng của từng máy (`lastPauseReason`), mục Hàng
đợi (đổi priority 0..100 + lý do chờ), checkbox auto-shed opt-in, và
trạng thái guest của máy VM (ok/missing/unhealthy/unknown +
version/uptime + hint + nút Kiểm tra).
