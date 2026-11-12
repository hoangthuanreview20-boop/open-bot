# Detected CLI engines — M1 + M3 (custom ACP CLI) + sóng B (đội platform: +5 CLI)

Registry phát hiện các CLI agent đã cài trên máy người dùng để open-bot
mượn model/tài khoản đăng nhập sẵn của chúng (theo mẫu OpenMausBot —
xem `docs/research-openmausbot.md` §4 và
`docs/research-detected-cli-providers.md`).

M3 thêm CLI ACP tuỳ chỉnh (xem `custom.ts`): user khai báo trong
Settings → Engines ("Set CLI…") — tên hiển thị + đường dẫn tuyệt đối
tới binary + argv ACP + (tuỳ chọn) lệnh kiểm tra đăng nhập; registry
đăng ký một detector cho mỗi CLI với kind `custom-acp:<slug>`, cấu
hình lưu bền vững trong `detected-engines.json` (cùng file opt-in).
Không có lệnh kiểm tra đăng nhập → trạng thái 'unknown' (không rõ —
không bịa là đã đăng nhập); provider vẫn dùng được khi user bật nguồn
(xem `visibility.ts`: `isEngineUsableAllowingUnknown`).

## Cách dùng

```ts
import { DetectedEngineRegistry } from '@open-bot/core';

const registry = new DetectedEngineRegistry({
  stateFilePath: '<userData>/detected-engines.json',
});
const snapshot = await registry.detect(); // quét PATH + probe + auth check
registry.setEnabled('claude', true); // user bật trong Settings → Engines
```

## Cơ chế từng CLI

| CLI | Phát hiện đăng nhập bằng gì |
| --- | --- |
| Claude Code | `claude auth status --json` (lệnh của chính CLI) |
| Codex | `codex login status` (hỏi Codex tự báo; không đọc `auth.json`) |
| Grok CLI | File `~/.grok/auth.json` (hoặc `$GROK_HOME`) **có tồn tại** không — chỉ kiểm tra tồn tại, không đọc nội dung |
| OpenCode | `opencode auth list` |
| Gemini CLI | Nhãn từ `~/.gemini/google_accounts.json` (chỉ email, không token); `oauth_creds.json` chỉ kiểm tra tồn tại |
| Cursor CLI | `cursor-agent status --format json` |
| Aider (sóng B) | Không có tài khoản đăng nhập — chỉ kiểm tra TÊN biến môi trường API key có tồn tại không (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …); giá trị key không bao giờ được đọc |
| Continue (sóng B) | File `~/.continue/config.yaml` **có tồn tại** không — chỉ kiểm tra tồn tại, không đọc nội dung (file có thể chứa key) |
| GitHub Copilot CLI (sóng B) | Chính CLI không có lệnh status — hỏi `gh auth status` (GitHub CLI) và lấy username từ dòng `Logged in to github.com as X` |
| Amazon Q CLI (sóng B) | `q whoami` (hiện trạng thái đăng nhập + user) |
| Kiro CLI (v0.76) | `kiro-cli whoami --format json` (docs kiro.dev; shape JSON chưa được docs ghi rõ nên parser phòng thủ nhiều lớp). Chỉ dò binary `kiro-cli` — bí danh `kiro` có thể mở Kiro IDE qua command router nên không dò |
| Windsurf (sóng B) | Không có lệnh status — CLI thừa hưởng đăng nhập trong editor → trạng thái 'unknown' (không bịa là đã đăng nhập). Driver M4 dùng Devin CLI (`devin`, dò trước `windsurf`/`devin-desktop`) qua ACP `devin acp` |
| Custom ACP CLI (M3) | Lệnh kiểm tra do user khai (`statusArgs`), hoặc không kiểm tra → trạng thái 'unknown' |

## Bảo mật

- Snapshot chỉ chứa nhãn (tên, version, trạng thái, nhãn tài khoản, lý
  do) — **không bao giờ chứa token/secret**. File trạng thái opt-in
  (`detected-engines.json`) chỉ chứa kind + boolean.
- Kiểu kiểm tra 'env-present' (Aider) chỉ hỏi TÊN biến môi trường có
  tồn tại không — giá trị key không bao giờ được đọc, ghi log hay đưa
  vào snapshot; nhãn chỉ nêu họ key (vd 'OpenAI API key').
- Opt-in mặc định **TẮT** (fail-closed): nguồn chưa bật thì provider
  CLI tương ứng không hiện trong picker và không được dùng.
- Detector lỗi/chưa cài chỉ thành `unavailable` kèm lý do — không crash app.

## Giới hạn CHƯA KIỂM CHỨNG (bắt buộc đọc trước khi coi M1 là xong)

Trên máy phát triển M1 **không có CLI nào đăng nhập thật** (chỉ có
binary `codex` 0.164.0-alpha.9 chưa đăng nhập đi kèm VM image), nên:

1. **Chưa chạy detector trên máy thật có CLI đăng nhập.** Các lệnh
   status, shape JSON output (`claude auth status --json`,
   `cursor-agent status --format json`), và output text
   (`codex login status`, `opencode auth list`) đều từ docs/code công
   khai — parser đã viết phòng thủ (field thiếu/lạ thì trả "đã đăng
   nhập, không rõ nhãn"), nhưng shape thật có thể khác.
2. **Chưa chạy driver Claude trên máy thật.** Xem thêm
   `packages/core/src/providers/cli/README.md`.
3. **Chưa kiểm chứng trên Windows/macOS** — chỉ Linux (PATH search có
   xử lý hậu tố `.exe`/`.cmd`, nhưng chưa chạy thật).

Follow-up bắt buộc trước khi coi M1 là xong: chạy detector + một turn
Claude trên máy thật có Claude Code đăng nhập, đối chiếu snapshot
(trạng thái, version, nhãn tài khoản) và sửa parser nếu shape thật khác.
