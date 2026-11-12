# M8 — Approval card trong chat + group chat bot-bot + headless CLI (v0.50)

Mốc mở rộng quy mô cuối cùng của M1–M8. Học kiến trúc từ
`docs/research-openmausbot.md` §9 (approval cards, group chat,
headless CLI của OpenMausBot) và `docs/rea-grokbot-deep-dive.md`
(approval flow của Grok Bot) — chỉ học kiến trúc, không sao chép.

## 1. Thẻ duyệt trong chat (Approval card)

Khi agent cần duyệt một tool call, chat hiện thẻ Allow/Deny thay cho
dialog (component `ApprovalCard.tsx`, question card `AskUserCard.tsx`
đã có từ trước cho tool `ask_user`):

- Thẻ hiện: tên bot + tên tool, **lý do** cần duyệt, **tham số rút gọn**
  (tối đa ~500 ký tự). Secret trong args bị redact thành `<redacted>`
  ở coordinator (`approval/selfRead.ts` — `summarizeArgsForCard`,
  theo key `apiKey/token/secret/password/…` và theo hình dạng giá trị
  `Bearer …`, `sk-…`, `xai-…`) trước khi rời tiến trình con — renderer
  không bao giờ tự xử lý secret thật.
- Nút: **Cho phép 1 lần** · **Cho phép luôn** · **Từ chối**. "Cho phép
  luôn" tạo rule auto-approve **phạm vi bot, chỉ tool này**
  (`kind: 'tool'`, `scope: 'bot'`) — ghi rõ phạm vi ngay dưới nút;
  tắt được trong Cài đặt → rule auto-approve. Lỗi tạo rule thì vẫn
  trả lời allow-once, không chặn run.
- **Sửa tham số** (JSON) giấu sau nút gập (progressive disclosure) —
  thẻ mặc định thoáng; duyệt với args đã sửa thì loop re-check
  denylist với args mới (hành vi interrupt_before cũ).
- Hết 10 phút không trả lời thì coordinator tự từ chối (ghi rõ trên thẻ).
- Thẻ của **mọi bot** đều hiện (trước đây thẻ của bot không được chọn
  bị rơi im lặng trong khi run của nó vẫn chờ tới hết timeout).

Quyết định đi qua approval flow + `PermissionBroker` đã có (không viết
flow mới). Timeout broker 120s → từ chối.

### Thẻ permission từ CLI engine (follow-up M5 còn nợ)

`PermissionCard.tsx`: Codex/ACP xin phép qua harness broker thì hiện
thẻ Allow/Deny trong chat (engine, method, detail). Method không có
đường cho phép an toàn (`allowable: false`, vd Codex) thì chỉ có nút
từ chối.

**Nối broker vào desktop — cách làm thực tế:** desktop main không thể
truyền object `LocalHarness` qua NDJSON-RPC cho tiến trình coordinator
con, nên harness được dựng **trong stdio entry của coordinator**
(`runCoordinatorStdio`, dataDir từ env `OPENBOT_DATA_DIR` mà main đã
truyền khi spawn). `permissionUiHandler` của harness emit event
`harness.permission-needed` về main → renderer mở thẻ → trả lời qua
IPC `chat:harness-permission-response` → RPC `harnessDecidePermission`.
Promise UI handler không tự resolve (nó chỉ emit rồi chờ) — harness
bọc nó và `onDecision` của broker resolve khi có quyết định/timeout,
nên không treo/rò rỉ (`harness/harness.ts`). Không có UI (headless)
thì broker từ chối fail-closed như cũ.

Sửa kèm (bug tìm thấy khi làm CLI): `onApprovalNeeded`/`onAskUser`
trong coordinator emit event **trước** khi đăng ký pending — handler
emit trả lời đồng bộ (CLI từ chối ngay trong emit) thì
`respondApproval` thấy `found: false` và run treo tới hết timeout
10 phút (thậm chí process thoát vì event loop cạn). Nay đăng ký
pending **trước** khi emit.

## 2. Mức approval theo từng bot

Mỗi bot có một mức riêng (`BotConfig.approvalLevel`, chọn trong
BotForm, lưu cùng settings.json của bot):

| Mức | Hành vi |
| --- | --- |
| `ask-always` | Hỏi mọi tool call, kể cả tool chỉ-đọc. |
| `ask-for-writes` (mặc định) | Chỉ hỏi tool ghi/thực thi — hành vi cũ. |
| `auto-approve-safe` | Tự chạy tool chỉ-đọc (kể cả khi policy nói `ask`), chỉ hỏi tool ghi. |

Mức chỉ quyết định **có hiện thẻ hay không**, không quyết định có
được phép hay không: denylist, hook PreToolUse, guardrail và policy
`deny` vẫn chạy trước/sau như cũ. Mức lạ/thiếu → `ask-for-writes`.
Tái dùng rule auto-approve v0.35 cho "Allow always" — không viết cơ
chế thứ hai. Logic ở `approval/levels.ts` (`shouldAskForCall`,
được loop gọi trong `executeCallInner`).

## 3. Quy tắc "bot đọc file của chính nó không bao giờ hỏi"

Rule tường minh trong `approval/selfRead.ts` (`isSelfReadCall`),
loop kiểm tra trước cả hai nhánh hỏi duyệt:

- Chỉ áp cho thao tác **đọc**: tool chỉ-đọc có đường dẫn
  (`read_file`, `list_files`, `glob_files`, `grep_search`,
  `code_diagnostics`, … — kể cả qua dispatcher gom nhóm
  `file/read_file`), hoặc lệnh shell đọc đơn giản
  (`cat/head/tail/grep/rg/sed -n/ls/wc/nl/stat/file/less/more`).
- Mọi đường dẫn phải nằm **trong workspace của bot** (resolve tuyệt
  đối + chặn `..` thoát ra ngoài). Một đường dẫn ngoài workspace →
  hỏi như thường theo mức.
- Lệnh shell chỉ miễn khi **đơn** (không `&&`/`||`/`;`/`|`/redirect/
  substitution) và có **ít nhất một toán hạng đường dẫn tường minh**;
  lệnh đọc trần như `ls`/`cat` không file (đọc cwd/stdin không rõ) →
  không miễn, hỏi như thường (fail-closed). `sed` chỉ miễn với `-n`,
  `sed -i` là ghi → hỏi.
- Tool **ghi không bao giờ được miễn**, kể cả trong workspace.
- Không rõ workspace → không miễn (fail-closed).

## 4. Group chat bot-bot

`packages/core/src/groupchat/` + RPC coordinator + `GroupView.tsx`:

- Tạo nhóm, thêm/bỏ bot, xoá nhóm. Mỗi message ghi rõ bot nào nói
  (tên bot + giờ), message của người dùng ghi "Bạn".
- **@mention gọi bot cụ thể**: `@TênBot`/`@bot-id` trong message
  được parse (`parseGroupMentions` — khớp tên nhiều từ, không phân
  biệt hoa/thường). Bot được mention chạy một **silent run** với nội
  dung message (tái dùng `run()` đã có — không viết delegation mới),
  câu trả lời của nó được thêm vào nhóm như message `delegated` của
  bot đó. **Một hop duy nhất** — câu trả lời không parse mention
  tiếp, chống vòng lặp bot-bot.
- Lịch sử **bền vững**: file `<dataDir>/group-chats.json` (ghi atomic,
  mode 0600, tối đa 1000 message/nhóm), mở lại app vẫn đủ.
- `@files`/`@docs` là mention file (v0.16), không phải mention bot.

## 5. Headless CLI (`apps/cli/`, lệnh `open-bot`)

```sh
open-bot run --bot <id|name> --prompt "..." [--json] [--export out.json]
open-bot run --provider mock --model mock --prompt "..." [--json]
open-bot team apply team.json [--json]
open-bot --help
```

- Tái dùng `AgentCoordinator` in-process (không viết agent loop mới).
- Bot lấy từ `<dataDir>/bots.json` (mảng `{bot, provider}` — provider
  có thể kèm `mockResponses` để chạy thử không cần key). Provider
  API-key lấy từ env `OPENBOT_<PROVIDER>_API_KEY`
  (vd `OPENBOT_GEMINI_API_KEY`); CLI không đọc Vault của desktop.
  `dataDir` mặc định: env `OPENBOT_DATA_DIR`, nếu không thì `~/.open-bot`.
- `team apply` validate bằng `validateTeamConfig` rồi ghi
  `<dataDir>/team.json` (ghi đè).
- **Approval headless mặc định TỪ CHỐI fail-closed** (không có UI để
  hiện thẻ): tool call cần duyệt bị từ chối ngay, run trả text
  `đã hủy` + exit code 3. Chỉ cờ tường minh `--auto-approve` mới tự
  duyệt (cảnh báo ra stderr). Permission từ CLI engine cũng từ chối
  vì CLI không gắn UI handler cho harness.
- Exit code: 0 xong · 1 lỗi dùng/config · 2 run lỗi · 3 approval bị
  từ chối. `--json` in JSON máy đọc được
  (`{botId, botName, text, stopped, runId, approvalDenied}`);
  `--export FILE` ghi JSON đó ra file.

## 6. Test

- `tests/approval-m8.test.mjs` (17): mức approval, self-read
  (trong/ngoài workspace, shell, dispatcher), redact args, loop
  (hỏi đúng lúc, Allow → chạy, Deny → `đã hủy`, 3 mức), coordinator
  (reason + argsSummary, Allow always → không hiện thẻ nữa), broker
  (timeout → từ chối, không UI → từ chối ngay), harness (uiHandler
  treo + `decide()` → resolve).
- `tests/groupchat-m8.test.mjs` (6): parse mention, store bền vững,
  coordinator delegation + history, persistence qua restart, lỗi rõ.
- `tests/headless-cli-m8.test.mjs` (6): `--help`, run mock JSON,
  `--bot` + `--export`, bot không có, `team apply` đúng/hỏng,
  approval headless từ chối (exit 3, file không tạo) vs
  `--auto-approve` (exit 0, file được tạo).
- Xác minh 2026-11-09 (sau sửa lỗi envelope, xem §7): `npm run build`
  (root) + `npm run typecheck` (root) sạch; test liên quan
  (approval-m8, groupchat-m8, headless-cli-m8, i18n, harness-m5,
  auto-approve-v035, coordinator, loop-wiring) **113/113 pass**;
  subagent/team **63/63 pass**; full suite
  `xvfb-run -a node --test` **1622 test — 1620 pass, 0 fail,
  0 cancelled, 2 skipped**.

## 7. Chưa kiểm chứng + lỗi tìm thấy khi smoke Electron (đã sửa)

- Thẻ duyệt với **CLI thật** (Codex/ACP xin phép thật qua broker):
  chỉ kiểm bằng harness giả + broker trực tiếp; chưa có CLI nào đăng
  nhập trên máy này để chạy thật.
- Group chat với **nhiều bot thật** (provider API-key thật): chỉ kiểm
  bằng mock provider; delegation qua run thật với model thật chưa chạy.
- Headless CLI trên **máy thật ngoài VM** (userData khác, bot thật):
  chỉ kiểm bằng mock provider + thư mục tạm.
- **Smoke Electron thật qua CDP (đã chạy 2026-11-09, user-data tạm,
  `--no-sandbox` vì chạy dưới root):** renderer mount tốt
  (`#root` 1 child, load ~350ms); bấm nút "💬 Nhóm chat" → GroupView
  render ("Nhóm chat bot-bot / Tạo nhóm / Chưa có nhóm nào");
  luồng đầy đủ qua UI thật: tạo nhóm "Nhóm smoke" → hiện trong danh
  sách → gửi "xin chào nhóm" → hiện trong thread, **0 uncaught
  exception**, `group-chats.json` trên đĩa chứa đúng nhóm + message
  (bền vững). Thẻ approval thật trong app chưa bấm được qua CDP (cần
  run thật với provider có key — không có key trong user-data tạm).
- **Bug tìm thấy khi smoke (đã sửa):** `listGroupChats`/`listGroupMessages`
  của coordinator trả envelope `{groups}`/`{messages}`, nhưng main
  forward nguyên envelope cho renderer trong khi GroupView nhận như
  array → `TypeError: m.find is not a function`, React unmount, màn
  hình trắng sau khi bấm "Nhóm chat". Sửa: `main.ts` unwrap
  `.groups`/`.messages` ở IPC `group:list`/`group:list-messages`;
  `preload.ts` siết type sang `GroupChat[]`/`GroupMessage[]` (từ core);
  `GroupView.tsx` thêm guard `Array.isArray` để payload sai shape
  chỉ hiện lỗi tải, không bao giờ trắng màn hình nữa. Smoke lại sau
  sửa: GroupView render đúng, luồng nhóm đầy đủ chạy được (xem trên).
- **Lỗi CSP worker (có từ trước, không do M8):** lúc load app luôn có
  1 Log error `Refused to load the script 'blob:file://…' ... script-src
  'self'` (nguồn worker) — xuất hiện cả khi không chạm gì, không file
  M8 nào tạo worker; app vẫn chạy bình thường. Cần sóng sau xem lại
  CSP worker-src.
- **Cảnh báo harness (benign, follow-up):** log main mỗi lần mở app:
  `harness: không đăng ký được bot "…" — đã có instance sống`. App
  gọi `createBot` 2 lần cho cùng bot lúc khởi động (hành vi có sẵn);
  từ khi M8 nối harness vào coordinator con thì lần thứ hai bị
  `attachToProvider` từ chối (chống spawn trùng). Không crash, không
  ảnh hưởng luồng; sóng sau nên cho main unregister/reuse thay vì
  tạo lại, hoặc cho harness chịu re-attach.
