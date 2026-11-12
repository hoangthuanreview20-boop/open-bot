# Egress policy (P0-2)

> Kiến trúc lấy từ Grok Bot (§10 `docs/rea-grokbot-deep-dive.md`:
> egress tunnel + fail-closed + allowlist theo team + IP allowlist cho
> GitHub checkout + telemetry ẩn danh + phân loại lỗi), viết lại hoàn
> toàn bằng code gốc. Không sao chép code/text/tài sản xAI/Cursor.

## Vấn đề

Trước P0-2, open-bot giam file/shell theo workspace (SSRF check chỉ
cho `http_get`/`web_fetch`) nhưng agent trong box có thể gọi bất kỳ
host nào qua `curl`/`wget`/`git clone`/shell — không có egress control
nào (`grep egress` = 0). Đây là lỗ hổng lớn nhất khi chạy agent cho
team / chạy box phía server.

## Mô hình

Một `EgressPolicy` (`packages/core/src/egress/`, JSON-serializable):

```ts
{
  enabled: true,                 // false = tắt → mọi kiểm tra fail-closed
  mode: 'allowlist',             // 'allowlist' (mặc định) | 'allow-public'
  allowHosts: ['api.example.com', '*.example.com'],
  allowIpRanges: ['203.0.113.0/24'],
  allowPrivateDestinations: false, // LAN/localhost/metadata
  allowLocalServices: true,        // loopback cho context local-service
  githubEgressIps: ['140.82.112.0/20'],
  failClosed: true,
}
```

- **Fail-closed mặc định.** Không có policy (`undefined`/`null`) hoặc
  policy tắt → chặn với kind `unconfigured`. Mode `allowlist`: host/IP
  ngoài allowlist → chặn (`blocked`), không resolve DNS (không rò rỉ
  đích). Đích không xác minh được (DNS lỗi, không ra địa chỉ) → chặn
  (`unreachable` / `invalid_response`) khi `failClosed: true`.
  `failClosed: false` chỉ nới đúng trường hợp "không xác minh được" —
  thiếu policy vẫn luôn chặn.
- **Loopback là trường hợp cho phép rõ ràng.** Provider local (Ollama
  `127.0.0.1:11434`, mock provider) và Local API đi qua context
  `local-service` và được phép khi `allowLocalServices: true` (mặc định
  true) — không cần có trong allowlist. Agent (context `agent`) gọi
  `127.0.0.1`/`localhost` vẫn bị chặn trừ khi `allowPrivateDestinations:
  true`. Mock provider + Ollama local luôn đi qua được.
- **GitHub checkout.** Context `github-checkout`: khi `githubEgressIps`
  có giá trị, mọi IP mà `github.com` resolve ra phải nằm trong dải đó
  (Grok: org GitHub phải allowlist IP của egress tunnel). Khi rỗng thì
  dùng luật allowHosts thường.
- **Phân loại lỗi.** `EgressError` có `kind` + `code` ổn định:
  `unconfigured` / `unreachable` / `invalid_response` / `blocked`
  (code `egress_unconfigured`, `egress_unreachable`,
  `egress_invalid_response`, `egress_blocked`,
  `egress_private_destination`, `egress_not_allowlisted`,
  `egress_loopback_blocked`, `egress_invalid_target`). Daemon map sang
  mã `EGRESS_*` tương ứng.

## Áp ở đâu

| Đường | Cách áp |
|---|---|
| `checkEgress()` / `checkEgressSync()` (core) | Điểm kiểm tra duy nhất; `checkEgressSync` không DNS (dùng cho daemon flush) |
| `runShell()` (`packages/tools/src/sandbox.ts`) | Trích đích mạng trong lệnh (`extractNetworkTargets`) và kiểm tra TRƯỚC khi spawn. Lệnh không có đích mạng chạy như cũ. Không có policy → `egress_unconfigured`. Thứ tự policy: `opts.egressPolicy` > `opts.getEgressPolicy()` > policy module (`configureSandboxEgress()`); resolver `getEgressPolicy` thắng policy module — trả `undefined` thì fail-closed luôn, không rơi tiếp về module (xem § Team + shell tools). `opts.egressPolicy` / resolver trả `null` = tắt hẳn, chỉ cho test/caller cũ |
| `shell_exec` / `exec_task` / `shell_session_*` (shell tools) | Tự resolve team egress qua `ToolFactoryHost.getEgressPolicy` (coordinator truyền xuống lúc dựng tool — xem § Team + shell tools). Đường in-process đi qua `runShell` (resolver); đường daemon mang policy đã resolve theo từng request/session (daemon ưu tiên policy request hơn policy chung của nó; không resolve ra policy thì để daemon tự resolve/fail-closed). `shell_session_write` local (không daemon) chưa kiểm tra egress — xem Giới hạn |
| `http_get`/`web_fetch` (`ssrf.ts`) | `assertPublicUrl`/`fetchPublic` giữ hành vi SSRF cũ khi không truyền policy; truyền `opts.egressPolicy` (kể cả `null`) thì đi qua policy chung. Hàm mới `assertEgressUrl()` |
| Daemon (`packages/tools/src/daemon/`) | Chỉ khi bị giam (có workspaceDir hiệu lực): `exec`/`session_start` kiểm tra lệnh trước spawn; `session_write` kiểm tra từng dòng stdin đầy đủ (async, có DNS); flush fragment lúc đóng chỉ qua bản sync. Policy: request > daemon (option > env `OPENBOT_DAEMON_EGRESS_POLICY` JSON > `init`, chỉ đặt khi chưa cấu hình). Session không giam giữ hành vi cũ |
| Team (`packages/core/src/team/`) | `TeamConfig.egress` — field team đặt thắng policy chung, field không đặt lấy theo policy chung (`resolveTeamEgressPolicy()`); cả hai đều không có → `undefined` → caller fail-closed. Đặt/xoá bằng `setTeamEgress()`. Coordinator tự resolve cho shell tools — xem § Team + shell tools |

## Team + shell tools (v0.55)

Trước v0.55, `resolveTeamEgressPolicy()` và `TeamConfig.egress` đã có
nhưng shell tools do `defaultToolFactory`/`buildToolHost` dựng không
tự động dùng — caller phải nhớ cấu hình tay qua
`configureSandboxEgress()` (policy module, chung cho cả tiến trình,
không theo team, không đổi lúc chạy). Nay nối sẵn:

- **Nguồn policy của coordinator** (`AgentCoordinator`):
  policy chung lấy từ `CoordinatorOptions.egressPolicy`, nếu không
  đặt thì từ env `OPENBOT_EGRESS_POLICY` (JSON, sai thì bỏ qua =
  chưa cấu hình — cùng kiểu với `OPENBOT_DAEMON_EGRESS_POLICY` của
  daemon); đổi lúc chạy bằng `setEgressPolicy()` (bot đã tạo thấy
  ngay, không cần tạo lại).
- **Resolve hiệu lực** (`resolveBotEgressPolicy()`, gọi qua
  `ToolFactoryHost.getEgressPolicy`, resolve lười mỗi lần tool chạy):
  đọc live `team.json` dưới `dataDir` (userData — cùng file main
  đọc) rồi `resolveTeamEgressPolicy(team, global)`. Team không đọc
  được (không có `dataDir`/file hỏng) → trả policy chung nguyên
  vẹn. Team không đặt `egress` + policy chung là `null` (tắt) →
  `null`. Còn lại theo đúng luật `resolveTeamEgressPolicy`: field
  team thắng field chung, field không đặt lấy theo chung, cả hai
  không có → `undefined` → shell fail-closed.
- **Thứ tự trong `runShell()`**: `opts.egressPolicy` (override từng
  lần, giữ nguyên) > `opts.getEgressPolicy()` (resolver của
  coordinator) > policy module. Resolver là nguồn có thẩm quyền:
  nó trả `undefined` thì fail-closed ngay, không rơi tiếp về policy
  module — tránh policy module cũ (nới hơn) lấn át quyết định
  "không có policy" của team. `null` ở cả hai chỗ đều là tắt hẳn.
- **Đường daemon**: `shell_exec`/`exec_task` mang policy đã resolve
  theo từng request (`egressPolicy` trong params — daemon ưu tiên
  policy request), `shell_session_start` mang theo session (daemon
  đóng băng policy đó cho cả đời session). Không resolve ra policy
  thật (`undefined`/`null`) thì không mang theo gì — daemon tự
  resolve/fail-closed theo policy của nó (`null` không có dạng hợp
  lệ trên đường daemon, daemon coi là policy sai → BAD_REQUEST).
- **Main chưa gửi policy chung qua RPC**: coordinator con đọc
  `team.json` trực tiếp từ userData (env `OPENBOT_DATA_DIR` main
  đã truyền lúc spawn) nên team egress chạy ngay không cần đổi
  protocol; policy chung toàn cục muốn đặt từ Settings thì cần thêm
  field settings + tham số RPC (hoặc env `OPENBOT_EGRESS_POLICY`
  lúc spawn) — việc follow-up, chưa làm ở v0.55.

## Telemetry ẩn danh

`EgressTelemetry` (`packages/core/src/egress/telemetry.ts`, instance
global `defaultEgressTelemetry`): chỉ đếm theo kind
(`allowed`/`blocked`/`unconfigured`/`unreachable`/`invalid_response`)
+ context (`agent`/`local-service`/`github-checkout`). **Không bao giờ
ghi URL, host, path, query hay secret.** `snapshot()` trả về số đếm.

## Giới hạn đã biết

- `extractNetworkTargets` chỉ bắt URL có scheme rõ ràng
  (`http(s)://`, `ssh://`, `git://`, `ftp://`) và dạng git scp-like
  (`git@host:path`). `curl example.com` không scheme không bị bắt —
  vẫn còn denylist + approval chặn lệnh nguy hiểm, nhưng không phải là
  bảo đảm egress tuyệt đối cho lệnh viết tắt.
- Daemon flush fragment lúc đóng session dùng bản sync (không DNS):
  host ở mode `allow-public` không xác minh được thì fail-closed
  (fragment bị bỏ); host allowlist đã khớp thì cho qua mà không kiểm
  tra DNS rebinding ở đường này.
- Egress check không chặn được network qua process con đã spawn trước
  (vd agent mở socket từ chương trình đã chạy) hay qua tool MCP/
  plugin tự mở kết nối — chỉ chặn điểm vào đã nối (shell, fetch,
  daemon). Muốn chặn tuyệt đối cần egress proxy/tunnel ở tầng mạng
  (như Grok) — ngoài phạm vi P0-2.
- `failClosed: false` cho phép đích không xác minh được (DNS lỗi) đi
  qua — chỉ dùng khi host chấp nhận rủi ro đó.
- Policy lưu trong `team.json`/env là config local, không phải access
  control chống user thù địch trên cùng máy (giống giới hạn chung của
  team local).
- `shell_session_write` đường local (không daemon) ghi thẳng stdin
  của session, chưa kiểm tra egress từng dòng — đường daemon thì có
  (daemon kiểm tra từng dòng stdin đầy đủ). Lỗ này chỉ lộ khi chạy
  không daemon (test/CLI); desktop production luôn có daemon nên
  session đi qua daemon và được chặn. Git/code tools (`gitTools`,
  `codeTools`) gọi `runShell` trực tiếp, không truyền resolver team
  — chúng chỉ chạy lệnh git/tsc/node nội bộ (không có đích mạng trong
  lệnh) nên vẫn fail-closed theo policy module khi lệnh có đích mạng;
  muốn nối team egress cho chúng thì truyền `getEgressPolicy` như
  shell tools (follow-up, chưa làm ở v0.55).
