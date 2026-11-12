# Đội B — nền tảng & engines (ghi chú đội)

Branch `parallel/b-platform`, worktree `~/workspace/open-bot-platform`,
off v0.71 (def7cf6). Chỉ commit local, không push. Ghi chú này là của
đội B — KHÔNG sửa `docs/BEYOND-ROADMAP.md` để tránh xung đột merge.

## Đã xong

### M1 — 5 detector CLI mới (commit bcdd890)

Aider, Continue, GitHub Copilot CLI, Amazon Q CLI, Windsurf.
`AuthCheck` thêm: `'env-present'` (Aider — chỉ kiểm tra TÊN biến env,
không đọc giá trị key), `'command'` + `binary` (Copilot hỏi
`gh auth status`), `'file-exists'` + `method` (Continue config.yaml).
Windsurf dùng `'none'` → trạng thái `'unknown'` (không bịa là đã đăng
nhập). `KNOWN_ENGINE_KINDS` 6 → 11. 9 test mới, fake binary + home giả
+ env giả. Driver cho 5 CLI này CHƯA có (chỉ detect + opt-in ở
Settings → Engines) — follow-up riêng.

### M2 — Máy tính riêng cho từng bot (commit 0b07421 + UI)

Hướng mới của Huy (2026-11-10): mỗi bot có một máy tính riêng, như
Grok Bot. Máy người dùng được dò cấu hình rồi AI chia thành nhiều
máy-tính-bot, không ảnh hưởng việc người dùng dùng máy.

- `packages/core/src/compute/` — probe + planner + runtime (xem
  `packages/core/src/compute/README.md`).
- Sandbox: `BoxResourceLimits` thêm cpuSeconds/maxMemoryBytes/
  maxProcesses, enforce bằng prlimit trên Linux; `ResolvedBoxLimits`
  (Required<> lột `| undefined` — đã kiểm chứng bằng repro).
- Sửa race thật trong `runInBox`: tiến trình cũ đóng lại sau khi đã
  fallback không được finish sớm bằng stdout rỗng (đã làm 1 test
  flaky); có test hồi quy.
- UI: `ComputersView` (probe + backend + kế hoạch + bảng máy-tính-bot
  + start/pause/resume/stop + gắn disk image VM + giảm tải khi host
  bận), IPC `computers:*` (probe cache 30s), preload, `global.d.ts`,
  key i18n `computers.*` (vi+en, 69 key), mục sidebar + palette.

## Giới hạn còn lại (trung thực)

- VM thật: chỉ QEMU/KVM trên Linux có boot thật (cần disk image qcow2
  do người dùng cung cấp, opt-in). WSL2/Hyper-V/Virtualization.
  framework hiện chỉ dò có mặt/không — boot chưa implement.
- Chạy lệnh trong VM: v0.78 có guest agent (xem `compute/README.md`
  — mục Guest agent): host nói NDJSON với guest qua virtio-serial;
  VM chưa cài guest thì `runInComputer` throw lỗi rõ kèm hướng dẫn
  cài, không chạy lệnh trên host.
- Giới hạn RAM vật lý thật: v0.78 dùng cgroup v2 (`memory.max`, xem
  `packages/core/src/compute/cgroup.ts` + `compute/README.md`) — khi
  máy delegate controller `memory` thì enforce thật (limiter
  `open-bot-<botId>`, hook spawn đưa process vào cgroup);
  khi không delegate (như máy dev này: `cgroup.controllers` rỗng)
  thì probe trả unavailable và runtime giữ prlimit, báo rõ trong
  `statusView.memoryEnforcement` — chưa từng chạy trên cgroup thật,
  logic chỉ kiểm chứng bằng cgroup root giả.
- Mạng của VM mặc định không có NIC (`vmNetwork: 'none'`, v0.78 —
  fail-closed); chọn `'nat'` thì QEMU dùng user-mode NAT và egress
  policy KHÔNG enforce được trong VM (chỉ box/container có EgressGate
  riêng từng máy); UI hiện cảnh báo rõ khi VM dùng NAT.
- Driver cho 5 CLI mới (Aider/Continue/Copilot/Amazon Q/Windsurf) chưa
  có — mới chỉ detect + opt-in.
- VM image chưa có sẵn trong app — người dùng phải tự cung cấp file
  qcow2 (vd từ bản cài OS). Chưa có bước tạo image tự động.
- Probe GPU trên Linux cần `lspci` (thiếu thì warnings, không lỗi).

## Đã xong (tiếp) — M3 + M4

### M3 — Providers (commit bbc7394, verify: test mới pass trong batch 115/115)

- Presets OpenAI-compatible thêm 4: Cerebras
  (`https://api.cerebras.ai/v1`, mặc định `gpt-oss-120b` —
  llama-3.3-70b đã bị gỡ khỏi endpoint công khai của Cerebras trong
  2026, KHÔNG dùng làm mặc định), Fireworks
  (`https://api.fireworks.ai/inference/v1`, mặc định
  `accounts/fireworks/models/llama-v3p3-70b-instruct`), SambaNova
  (`https://api.sambanova.ai/v1`, mặc định
  `Meta-Llama-3.3-70B-Instruct`; gói miễn phí hiện yêu cầu phương thức
  thanh toán trước khi gọi lần đầu), Google AI Studio OpenAI-compatible
  (`https://generativelanguage.googleapis.com/v1beta/openai`, mặc định
  `gemini-2.5-flash`; project mới chưa dùng 2.5 có thể cần model 3.x).
  KHÔNG thêm Perplexity (Sonar Chat Completions ngừng hỗ trợ
  2026-09-27) hay Hugging Face router (chưa kiểm chứng). Model mặc
  định đã kiểm chứng qua web search ngày 2026-11-10 (xem ghi chú
  từng preset trong `models/presets.ts`).
- Ollama: `listLocalModelInfo()` (name, size, modifiedAt,
  parameterSize, quantizationLevel, family — field nào Ollama không
  trả thì `undefined`, không đoán) + `listLocalModels()` nay đi qua
  cùng một nguồn; `OLLAMA_KNOWN_MODELS` thêm qwen3, llama3.3.
- `ModelRegistry.setDiscoveredModels(providerId, modelIds)` — model
  phát hiện được gộp vào catalogue TRONG BỘ NHỚ, nhãn "(local)", gọi
  lại thay thế (không cộng dồn); `save()` chỉ ghi `overrides` nên
  discovered KHÔNG vào models.json; `load()` không xoá discovered.
  IPC `models:ollama-list` trong main gọi setDiscoveredModels sau mỗi
  lần liệt kê, để picker/rail hiện model local đã pull ngay.
- Test: `tests/providers-b-platform.test.mjs` (fake fetch /api/tags,
  registry với file models.json thật trong thư mục tạm).

### M4 — Team (commit 709eedd, verify: test mới pass trong batch 115/115)

- `team/audit.ts`: append JSONL `audit.jsonl` + chuỗi hash SHA-256
  (canonical JSON, key sắp xếp), `verifyAuditLog` (kiểm tra seq +
  prevHash + hash, báo dòng hỏng đầu tiên), `listAuditEvents` lọc
  theo actor/action/target/since/until. Giới hạn thật: log LOCAL cho
  máy tin cậy — chuỗi hash phát hiện hỏng/sửa lén không tính lại
  hash, KHÔNG chống được người có quyền sửa file tính lại chuỗi;
  giả định một writer duy nhất (main process).
- `team/workspaces.ts`: registry workspace có tên (id `ws-<uuid>`,
  name, rootDir TUYỆT ĐỐI, createdBy, createdAt; CRUD thuần +
  `workspaces.json` ghi atomic tmp+rename; trùng id/rootDir → throw).
  Chỉ là registry tên → đường dẫn, không tạo/kiểm tra thư mục.
- `team/store.ts`: TeamStore bọc load/save team + workspaces, mỗi
  mutation (addMember/removeMember/setRole/shareBot/unshareBot/
  setTeamEgress/setWorkspaceDir/createWorkspace/removeWorkspace/
  renameWorkspace) lưu state trước rồi ghi audit sau (thứ tự có chủ
  ý — ghi chú trong file). Service account KHÔNG trong store (tạo
  token + Vault là việc của main); main gọi `store.audit(...)` trực
  tiếp sau khi tạo/xoá. IPC/renderer cho audit/workspaces là
  follow-up (không đụng đội A/C).
- Export mới qua `packages/core/src/index.ts` (audit + workspaces +
  TeamStore). Test: `tests/team-b-platform.test.mjs` (audit thật trên
  thư mục tạm, sửa/xoá dòng để kiểm tra verify, TeamStore end-to-end).

### Fix full suite đỏ (commit 6f7d676)

Full suite lần 2 (sau M2b) đỏ 17/2313 — điều tra ra 4 lỗi thật + flake do tải:
- **bwrap lỗi setup lúc tải nặng (lỗi thật, nghiêm trọng nhất):**
  bwrap ĐÃ CÓ trên máy (recovery script cài lại) nhưng lúc tải nặng
  không tạo được namespace (`Creating new namespace failed: Resource
  temporarily unavailable`, exit 1, stdout rỗng). Spawn thành công
  nên đường fallback spawn-lỗi không kích hoạt. Fix trong `runInBox`:
  nhận ra lỗi setup qua stderr (chỉ khớp dòng đặc trưng của backend),
  thử lại cùng backend 1 lần sau 300ms, rồi fallback chạy thường +
  ghi rõ isolation. Tái hiện 30/30 fail dưới tải (4x `yes`) rồi 0/30
  sau fix. Test hồi quy fake-bwrap mới; assert `enforced` trong
  lifecycle test nay có điều kiện theo fallback (không assert mù).
- **i18n:** comment tiếng Việt trong ComputersView.tsx:6 +
  Sidebar.tsx:20 và chuỗi `core vật lý` hard-code — chuyển sang key
  `computers.physicalCores` (vi+en, 1152 key, 2 locale đồng bộ).
  Lưu ý: test i18n chỉ quét App/main + components/*.tsx (không quét
  .ts, types.ts, global.d.ts) — nên comment tiếng Việt trong .ts vẫn
  qua, nhưng file .tsx mới phải sạch.
- **UI-13:** nav có thêm `computers` (M2b) nên kỳ vọng 10 → 11 destinations.
- **CLI dist chưa từng build trong worktree** → 6 test headless-cli-m8
  fail MODULE_NOT_FOUND (`apps/cli/dist/cli.js` không tồn tại) — đã
  build (dist là gitignored, không vào commit).
- **Flake do tải (không sửa code):** plugin-sandbox-v014 timeout test
  fail 2 lần dưới tải rồi pass 11/11 x2 khi máy nhẹ + pass 11/11 ở
  main tree; vision/UI-8/renderer CDP/Ollama e2e timeout — cùng họ
  (máy chỉ còn 143MB free lúc suite chạy, 3 đội + main coordinator
  cùng chạy suite). Batch test liên quan sau fix: **115/115 pass**;
  typecheck xanh 4 workspace. Full suite chạy lại sau 3 commit này
  (log `~/workspace/fullsuite-b-platform-m3m4.log`).

## Nghiên cứu OpenMausBot (đã giao 2026-11-10 ~23:13)

Subagent nghiên cứu kiến trúc OpenMausBot (milind-soni/OpenMausBot, ~20.422 sao,
TypeScript/React 19/Electron; chỉ học ý tưởng, không copy code). Kết quả khớp
nhiều quyết định đã làm ở M1–M4 — ghi lại để đối chiếu, không đổi code:

- **Harness tách khỏi UI:** UI chỉ gửi lệnh + fold 1 luồng SSE; harness
  (127.0.0.1:8799) sở hữu agent process, chuẩn hoá mọi provider về 1 event
  log NDJSON theo thread. Open-bot đã có hướng này (run history/transcript);
  computer runtime (M2) giữ cùng nguyên tắc: runtime sở hữu process, UI chỉ
  hiển thị trạng thái.
- **Engine = adapter trên CLI gốc, không đụng credential:** probe trạng thái
  rồi mới hiện trong provider rail (kèm lý do khi unavailable); driver lỗi
  chỉ degrade, không sập hệ thống. Đúng thiết kế M1 (detector → 'unavailable'
  + reason) và rail đã có (`models/rail.ts`); M3 `setDiscoveredModels` nối
  tiếp vào rail này. OpenMausBot cho trỏ engine tới binary tuỳ chỉnh trong
  Settings → Engines + hỗ trợ ACP — open-bot đã có custom ACP.
- **Computer là abstraction 3 mode + broker phê duyệt chung:** cloud Linux
  desktop / Local VM / máy người dùng, mọi hành động rủi ro qua permission
  broker (Allow/Deny trong chat), fail-closed theo nền tảng (vd Ubuntu
  Wayland bị vô hiệu hoá có chủ đích). M2 làm nửa local của mô hình này
  (box → container → VM + headroom + shed); mode cloud ngoài phạm vi
  local-first. Host control dùng Cua Driver được ghim + hash — follow-up:
  nếu open-bot điều khiển máy host trực tiếp thì runtime điều khiển cũng
  phải ghim version + kiểm hash tương tự, không tải driver lạ lúc chạy.
- **Đa người dùng tách lớp:** core OpenMausBot single-user, local-first;
  đa người dùng thật nằm ở lớp fleet/enterprise riêng (mỗi workspace 1 OS
  user + service + port loopback + thư mục dữ liệu riêng, no-new-privileges,
  read-only system, nftables theo user; roles admin/member/`--chat-only`;
  audit `/var/log/openmausbot/fleet.jsonl` + decision log + usage ledger).
  M4 làm đúng tầng core-level (audit JSONL + TeamStore cho 1 máy tin cậy,
  đã ghi rõ giới hạn không chống giả mạo) — **đa người dùng thật với cô lập
  cấp OS user là follow-up tầng fleet, không phải mở rộng M4 trong core**.
  MCP server của họ cố tình không expose duyệt phê duyệt/xoá/credential/
  vòng đời computer — nguyên tắc tương tự nên giữ khi mở MCP server sau này.
- **Bảo mật loopback-trust:** ai chạm được 127.0.0.1:8799 là toàn quyền nên
  không bao giờ expose port harness; self-host phải qua pairing/Tailscale/
  tunnel. Open-bot giữ nguyên tắc này cho harness/computer runtime (chỉ
  loopback, không mở port ra ngoài).
