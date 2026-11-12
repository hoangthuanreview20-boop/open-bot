# Nghiên cứu — Detected CLI Providers (dùng model/tài khoản có sẵn trên máy user)

> **Phạm vi:** Chỉ nghiên cứu cơ chế công khai (docs chính thức, repo
> public) để thiết kế tính năng "detected CLI provider" cho open-bot.
> **Không** sao chép code/text/tài sản của ai; chỉ ghi kiến trúc/cơ chế
> bằng lời của mình, trích tên lệnh/đường dẫn/file tối thiểu đủ để đối
> chiếu. **Không** đọc/đụng tới tài khoản hay credential thật của ai —
> máy nghiên cứu này không có các CLI dưới đây đăng nhập; mọi kết luận
> về session đều từ docs/code công khai, chưa kiểm chứng trên máy thật
> có CLI đó.
>
> **Ngày nghiên cứu:** 2026-11-09. **Nguồn chính cho thiết kế:**
> `docs/research-openmausbot.md` (OpenMausBot là mẫu triển khai của đúng
> hướng này — đọc trước). Doc này ghi cơ chế của từng CLI gốc để đối
> chiếu và làm detector.
>
> **Quy ước mức tin cậy:** **Chắc chắn** = docs chính thức hoặc code
> public đã đọc; **Suy đoán** = suy ra từ tên file/cấu trúc, cần kiểm
> chứng; **Chưa xác minh** = cần máy thật có CLI đó đăng nhập.

## 1. Tóm tắt điều hành

| CLI | Binary | Phát hiện đăng nhập bằng gì | Gọi model bằng gì | Độ tin cậy |
|---|---|---|---|---|
| Codex (OpenAI) | `codex` | Hỏi Codex tự báo tài khoản hiệu lực (keyring cũng tính); file `~/.codex/auth.json` (hoặc `$CODEX_HOME/auth.json`) chỉ là nơi lưu, đừng đọc trực tiếp; `codex login status` | `codex app-server` (JSON-RPC NDJSON trên stdio, long-lived — nên dùng) hoặc `codex exec --json` (một lần rồi thoát) | Chắc chắn (docs OpenAI + code OpenMausBot) |
| Claude Code (Anthropic) | `claude` | `claude auth status --json` (từ v2.1.318 có `loginExpiresAt`); token ở macOS Keychain (`Claude Code-credentials`) hoặc `~/.claude/.credentials.json` (Linux/Windows, mode 0600); nhãn tài khoản ở `~/.claude.json` (`oauthAccount`) | `claude -p` / `--print` + `--output-format stream-json --verbose` (prompt qua stdin, một process sống mỗi thread) | Chắc chắn (docs Anthropic + code OpenMausBot) |
| OpenCode | `opencode` | `opencode auth list` (liệt kê provider đã lưu, không in secret); credential ở `~/.local/share/opencode/auth.json` (0600) — lưu ý OpenCode 2 dùng credential store riêng, không đọc `auth.json` nữa | `opencode run` (một lần, `--format json`) hoặc `opencode serve` (HTTP server :4096, OpenAPI + SSE) hoặc `opencode acp` (ACP stdio) | Chắc chắn (docs + nhiều nguồn độc lập); riêng OpenCode 2 là lưu ý mới, cần kiểm chứng |
| Gemini CLI (Google) | `gemini` | File `~/.gemini/oauth_creds.json` (0600) + `~/.gemini/google_accounts.json` (chỉ email, không token); có chế độ keychain (`gemini-cli-oauth`/`main-account` khi bật `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE`); `GEMINI_CLI_HOME` dời cả thư mục | Chạy `gemini` (TUI) — chưa có chế độ headless chuẩn dạng `claude -p`; gọi qua ACP (OpenMausBot có driver `acp/gemini.ts`) hoặc API Gemini bằng key | Chắc chắn về nơi lưu; **chưa xác minh** cách gọi headless tốt nhất |
| Grok CLI (xAI) | `grok` | File `~/.grok/auth.json` (hoặc `$GROK_HOME/auth.json`) có tồn tại không; **không có lệnh status**; login `grok login --device-auth` | `grok --permission-mode … agent [-m model] stdio` (ACP stdio) | Chắc chắn (code OpenMausBot, đã kiểm chứng với grok 1.0.0/1.0.25/1.0.41) |
| Aider | `aider` | **Không có login riêng** — chỉ dùng API key qua biến môi trường (`OPENAI_API_KEY`…) hoặc `.aider.conf.yml` (`~/.aider.conf.yml` hoặc `./.aider.conf.yml`); không có subscription để "mượn" | `aider --model openai/<model>` (TUI/interactive; không có headless chuẩn như `claude -p`) | Chắc chắn (docs Aider) |
| Cursor CLI | `cursor-agent` (alias `agent`) | `agent login` (browser) / `agent status` / `whoami` (hiện tài khoản); key lưu ở keychain hệ điều hành (macOS); hoặc `CURSOR_API_KEY` env | `cursor-agent -p --output-format stream-json` (prompt qua stdin — argv bị cắt ở newline trên Windows cmd); `agent acp` (ACP JSON-RPC stdio) | Chắc chắn (docs Cursor + tài liệu tích hợp độc lập) |
| Continue (`cn`) | `cn` (CLI) / extension VS Code/JetBrains | **Không có login riêng** — key khai trong `~/.continue/config.yaml` (`apiKey`, hỗ trợ `${{ secrets.X }}` từ `.env`); không có subscription để "mượn" | Không phải agent CLI độc lập để spawn làm engine — nó là extension/CLI cấu hình model; dùng như **nguồn phát hiện key đã cấu hình** thì hợp lý hơn là driver | Chắc chắn (docs Continue) |

**Kết luận nhanh:** chỉ 5 CLI có "subscription/login để mượn" thật sự:
**Claude Code, Codex, Grok CLI, Gemini CLI, Cursor CLI** (mỗi cái một
cách kiểm tra đăng nhập khác nhau — xem §2). **Aider và Continue không
có login riêng** — chúng chỉ đọc API key từ env/file, nên với chúng
detector chỉ nên phát hiện "đã cấu hình key cho provider X" chứ không
phải "đăng nhập tài khoản X". **OpenCode** nằm giữa: nó có OAuth riêng
cho từng provider (Anthropic Pro/Max, GitHub Copilot…) lưu trong
`auth.json` của nó, nên mượn được theo từng provider.

## 2. Từng CLI

### 2.1. Codex CLI (OpenAI) — `openai/codex`

**Binary & cài đặt:** `codex` (npm `@openai/codex`, Homebrew, hoặc
installer standalone). Biến `CODEX_HOME` dời toàn bộ thư mục trạng thái
(mặc định `~/.codex`).

**Session lưu ở đâu (chắc chắn — docs OpenAI + nhiều nguồn độc lập):**

- `~/.codex/auth.json` (mặc định, chế độ file): chứa credential đăng
  nhập (ChatGPT OAuth token hoặc API key). **Docs cảnh báo: coi file
  này như mật khẩu** — chứa access token; chỉ user đọc được (nên đặt
  `chmod 700 ~/.codex`, `chmod 600 ~/.codex/auth.json`).
- `~/.codex/config.toml`: sandbox, approval policy, MCP server
  (`[mcp_servers.*]`), provider, plugin, skill. `/etc/codex/config.toml`
  cho mặc định toàn hệ thống; `.codex/config.toml` trong repo (chỉ khi
  project được trust).
- `~/.codex/sessions/`: transcript theo ngày; `~/.codex/history.jsonl`;
  `~/.codex/memories_v2/` (hoặc `memories/` cũ); `~/.codex/skills/`,
  `~/.codex/prompts/`.
- **Nơi lưu credential chọn được** bằng `cli_auth_credentials_store`
  trong `config.toml`: `file` (mặc định, `auth.json`), `keyring`
  (macOS Keychain / Windows Credential Manager / Linux Secret Service;
  lỗi nếu keyring không có), `auto` (keyring nếu có, không thì file),
  `ephemeral` (chỉ trong bộ nhớ của process hiện tại).
- **Nguyên tắc cho detector (theo code OpenMausBot
  `server/drivers/codex-identity.ts`): đừng đọc `auth.json` trực tiếp
  để đoán tài khoản** — Codex tự biết tài khoản hiệu lực của nó kể cả
  khi token ở keyring; đọc file có thể gán nhãn sai.

**Gọi model bằng gì (chắc chắn):**

- **Nên dùng: `codex app-server`** — JSON-RPC (NDJSON) trên stdio,
  process sống lâu, có API thread đầy đủ (`thread/start`,
  `thread/resume`, `thread/list`, `thread/read`, `turn/start`…),
  `item/agentMessage/delta` cho streaming text thật sự, approval hiện
  dạng server→client request để host trả lời được. Đây là bề mặt mà
  IDE extension và SDK dùng; OpenMausBot cũng dùng nó
  (`server/drivers/codex.ts`: "completion is `turn/completed`…
  resumeCursor is the codex thread id").
- **Một lần rồi thoát: `codex exec [--json] "<prompt>"`** (alias
  `codex e`): prompt qua argv hoặc stdin (`codex exec -`, pipe vào);
  stdout chỉ có message cuối (hoặc JSONL event khi `--json`:
  `thread.started`, `turn.started`, `item.completed`,
  `turn.completed`); stderr là tiến trình/cảnh báo. Có
  `--output-last-message <file>`, `--output-schema <file>` (ràng buộc
  JSON Schema cho đáp án cuối), `--ephemeral` (không ghi session),
  `-s` (sandbox), `-a` (approval: `never`/`on-request`…),
  `-c key=value` (ghi đè config). **Approval mặc định trong exec là
  `Never`** — tool cần duyệt sẽ bị từ chối, không hỏi được giữa chừng.
  Resume: `codex exec resume <session_id>`.
- **`codex mcp-server`**: Codex *đóng vai* MCP server (stdio JSON-RPC)
  với tool `codex-reply` — hướng ngược lại (cho MCP client gọi Codex),
  không phải hướng open-bot cần.

**Cách kiểm tra đăng nhập (chắc chắn):**

- `codex login status` — hiện phương thức đang dùng; `codex doctor`
  cũng xác nhận. `codex login` (mở browser; ChatGPT Plus/Pro/Business/
  Edu/Enterprise) hoặc `codex login --with-api-key` (đọc key từ stdin,
  ví dụ `printenv OPENAI_API_KEY | codex login --with-api-key`) hoặc
  `codex login --device-auth` (device code, cho máy không browser).
  `codex logout` xoá credential.
- Lưu ý: **Codex Cloud task chỉ dùng được với ChatGPT auth, không
  dùng API key.** Env liên quan: `CODEX_API_KEY`, `OPENAI_API_KEY`,
  `CODEX_HOME`.

**Lưu ý bảo mật:** không bao giờ copy/đọc nội dung `auth.json`; chỉ
spawn `codex` và để nó tự dùng session của nó. Token refresh do Codex
tự làm. Không dùng chung một `auth.json` giữa 2 máy (refresh ở máy này
có thể làm hỏng máy kia — theo docs OpenAI).

### 2.2. Claude Code (Anthropic) — `anthropics/claude-code`

**Binary:** `claude` (npm/installer chính thức).

**Session lưu ở đâu (chắc chắn — docs Anthropic + nhiều nguồn độc lập):**

- **macOS:** OAuth access + refresh token trong **macOS Keychain**,
  item tên `Claude Code-credentials`. Nếu Keychain từ chối ghi (ví dụ
  SSH session bị khoá), fallback về `~/.claude/.credentials.json`
  (mode 0600).
- **Linux/Windows:** `~/.claude/.credentials.json` (mode 0600).
- **Nhãn tài khoản** (email, tổ chức, plan) nằm trong khối
  `oauthAccount` của **`~/.claude.json`** — đây là thứ `/status` hiện,
  **không phải token**. `~/.claude.json` còn chứa MCP server cá nhân
  và trạng thái.
- `~/.claude/projects/`: lịch sử hội thoại theo thư mục đã chạy (không
  gắn với tài khoản — đổi login rồi `claude -c` trong cùng thư mục vẫn
  tiếp tục hội thoại cũ, chỉ đổi bên trả tiền).
- `~/.claude/settings.json`: settings (có thể có `apiKeyHelper` cho
  chế độ API key); `~/.claude/accounts/`: mỗi tài khoản một file JSON
  (khi dùng nhiều tài khoản). Biến `CLAUDE_CONFIG_DIR` dời toàn bộ
  thư mục cấu hình (settings, session, plugin, `.credentials.json` —
  và trên macOS thì keychain entry cũng gắn theo thư mục đó).
- **Setup token:** `claude setup-token` mở browser OAuth như `/login`
  nhưng **in token 1 năm ra màn hình, không lưu đâu cả** — user tự đặt
  vào `CLAUDE_CODE_OAUTH_TOKEN` (dùng cho máy không browser).

**Gọi model bằng gì (chắc chắn):**

- **Nên dùng: `claude -p` / `--print`** (headless, một request/agent
  loop rồi thoát): prompt qua argv hoặc stdin (stdin pipe tối đa
  **10 MB**, hơn thì exit 1 + lỗi rõ trên stderr). `--output-format`
  có 3 giá trị: `text` (mặc định), `json` (một object cuối: `result`,
  `session_id`, `total_cost_usd` + breakdown theo model — ước tính
  phía client), `stream-json` (NDJSON: mỗi event một dòng, **dòng cuối
  là envelope `result` giống `json`** — vừa streaming vừa có tổng kết).
  Với `stream-json` cần thêm `--verbose` (bắt buộc để thấy đủ event)
  và `--include-partial-messages` (thêm `stream_event` token delta).
  `--input-format stream-json` nhận nhiều user message NDJSON trên
  stdin trong một lần gọi. `--json-schema <schema>` bắt đáp án theo
  JSON Schema (thêm field `structured_output`).
- **Quyền khi headless:** mặc định `-p` vẫn hỏi duyệt khi tool cần
  (không có ai trả lời thì kẹt) — cần `--permission-mode` hoặc
  `--dangerously-skip-permissions` hoặc file policy cho chạy không
  người. `--allowedTools` giới hạn tool. `--bare` bỏ qua hook/skill/
  plugin/MCP/`CLAUDE.md` (Anthropic khuyên cho script; sẽ thành mặc
  định cho `-p`).
- **Tương đương SDK:** Claude Agent SDK (TypeScript/Python) chạy cùng
  engine với object native — cân nhắc khi cần điều khiển mịn hơn spawn
  CLI (xem §6).
- **Giữ process sống:** OpenMausBot không gọi `-p` mỗi message mà giữ
  **một CLI process sống mỗi thread** với `--input-format stream-json`
  + `--output-format stream-json` + stdin mở suốt turn (§4.2 doc
  OpenMausBot). Đây là khác biệt quan trọng: `-p` một lần rồi thoát
  (rẻ để làm mẫu), retained process (tốt cho chat dài, giữ context
  + prompt-cache).

**Cách kiểm tra đăng nhập (chắc chắn):**

- Trong session: `/status` (phương thức login, tổ chức, email).
  Ngoài session: **`claude auth status`** — từ v2.1.318 (04/11/2026)
  hiện ngày hết hạn login dưới dạng `loginExpiresAt`; `claude -p`
  với `--output-format json` trả `credential_expires_at` trong kết
  quả; `claude -p` dạng text in cảnh báo trên stderr **10 ngày trước
  khi hết**. Login subscription có hạn (interactive cảnh báo trước
  3 ngày: "Your login expires in 3 days · run /login to renew", sau
  đó `/status` hiện "Expired — log in again").
- Login: `/login` trong CLI hoặc `claude auth login` (browser OAuth).
  Setup-token thì `loginExpiresAt` là `null` (CLI không biết hạn).

**Lưu ý bảo mật:** token ở Keychain/`credentials.json` — detector chỉ
đọc **nhãn** (`oauthAccount` trong `~/.claude.json`, hoặc output của
`claude auth status`), không đọc token. Token do Claude Code tự
refresh. Đổi tài khoản = đổi cả Keychain entry + `~/.claude.json`
(không chỉ một chỗ).

### 2.3. OpenCode — `anomalyco/opencode`

**Binary:** `opencode` (Bun runtime; cài bằng script `opencode.ai/
install`, npm `opencode-ai`, hoặc Homebrew).

**Session lưu ở đâu (chắc chắn — docs + nhiều nguồn độc lập):**

- **OpenCode 1:** credential ở **`~/.local/share/opencode/auth.json`**
  (mode `0600`), dạng map từ provider ID sang credential object
  (`{type: "oauth"|"api", key: …}`).
- **OpenCode 2 (lưu ý quan trọng):** giữ API key trong **credential
  store riêng**; chỉ đọc `auth.json` **một lần** khi mở database do
  OpenCode 1 tạo, sau đó bỏ qua mọi thay đổi của file. Cài mới
  OpenCode 2 thì **không bao giờ đọc `auth.json`**. Có lệnh
  `opencode auth switch <provider>` chọn credential đang dùng.
  → Detector **không được** giả định sửa `auth.json` là đủ trên
  OpenCode 2; phải kiểm tra bằng `opencode auth list` và kiểm tra
  version (`opencode --version`). (Chưa xác minh trực tiếp — suy ra từ
  docs tích hợp NanoGPT + hướng dẫn OpenCode 2.)
- Config: `~/.config/opencode/opencode.json` (hoặc `.jsonc`).
  Env: `<PROVIDER>_API_KEY` cũng được đọc (key đã lưu được ưu tiên
  hơn env).
- OAuth theo provider: Anthropic (Claude Pro/Max OAuth PKCE qua
  browser, hoặc tạo API key qua OAuth, hoặc key tay), GitHub Copilot
  (device flow), các provider khác (key tay). Zen (managed models):
  `opencode.ai/auth`.

**Gọi model bằng gì (chắc chắn):**

- **`opencode run "<prompt>"`** — non-interactive, chạy xong thoát;
  cờ: `--model provider/model`, `--format json` (NDJSON event ra
  stdout), `--dangerously-skip-permissions` (tự duyệt — cần cho
  headless), `--dir`, `--session`/`--continue`, `--file`, `--agent`,
  `--attach <url>`. Không có `--attach` thì `run` tự tạo server
  in-process. Chế độ non-interactive **tự từ chối** `question` /
  `plan_enter` / `plan_exit`.
- **`opencode serve`** — headless HTTP server (mặc định cổng **4096**,
  `127.0.0.1`), OpenAPI 3.1 tại `http://localhost:4096/doc`, SSE cho
  event realtime; auth bằng `OPENCODE_SERVER_PASSWORD`
  (basic auth `opencode:<password>`); header `x-opencode-directory`
  chọn thư mục làm việc theo request. `opencode run --attach
  http://localhost:4096 "…"` để chạy qua server ấm (tránh cold-start
  MCP). `opencode web` (web UI) và `opencode attach <url>` là bề mặt
  khác.
- **`opencode acp`** — Agent Client Protocol trên stdin/stdout (cho
  IDE tích hợp). Đây là hướng OpenMausBot dùng cho các CLI ACP khác.
- TUI: chạy `opencode` không tham số mở terminal UI — **không dùng
  cho programmatic**.

**Cách kiểm tra đăng nhập (chắc chắn):**

- `opencode auth list` (alias `auth ls`): hiện 2 mục — Credentials
  (từ `auth.json`: ví dụ "Anthropic (oauth)", "GitHub Copilot
  (oauth)", "OpenAI (api)") và Environment (ví dụ "Google
  (GOOGLE_API_KEY)"). **Không in secret.** `opencode auth login`
  (wizard tương tác theo provider), `opencode auth logout` (chọn
  credential để xoá). Trong TUI: `/connect`.

**Lưu ý:** OpenCode là **multi-provider** (75+ provider, qua models.dev)
— mượn OpenCode nghĩa là mượn **từng provider bên trong nó**, không
phải một tài khoản OpenCode duy nhất. Detector nên liệt kê theo
provider (giống `auth list`).

### 2.4. Gemini CLI (Google) — `google-gemini/gemini-cli`

**Binary:** `gemini` (Node 18+, npm).

**Session lưu ở đâu (chắc chắn — code `google-gemini/gemini-cli` đã
được kiểm tra bởi nghiên cứu độc lập, commit `571851b`, 2026-08-18):**

- Thư mục global: **`~/.gemini`** (`GEMINI_DIR = '.gemini'` trong
  `packages/core/src/utils/paths.ts`); biến `GEMINI_CLI_HOME` dời cả
  thư mục.
- **`~/.gemini/oauth_creds.json`** — token OAuth của login Google
  (một object `Credentials` của google-auth-library, ghi bằng
  `JSON.stringify(…, null, 2)`, mode `0600`); **chỉ một bộ token**.
- **`~/.gemini/google_accounts.json`** — email đang dùng + email cũ
  (**không phải token** — đây là nơi đọc nhãn tài khoản an toàn).
- `~/.gemini/mcp-oauth-tokens.json` / `mcp-oauth-tokens-v2.json` —
  token OAuth của MCP, không phải login CLI. `~/.gemini/a2a-oauth-
  tokens.json` — token A2A.
- **Chế độ mã hoá:** khi `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`,
  login Google lưu trong **keychain** (service `gemini-cli-oauth`,
  key `main-account`) thay vì ghi `oauth_creds.json`. Có bật mặc định
  trên hệ điều hành nào không thì **chưa rõ**.
- `$GOOGLE_APPLICATION_CREDENTIALS` là file credential phụ (thử sau
  `oauth_creds.json`). `~/.gemini/settings.json` (global + theo
  project), `~/.gemini/projects.json`.
- Auth có 4 cách (theo `authType`): OAuth2 Google (chính), API key
  (`GEMINI_API_KEY`), Vertex AI, và Cloud Code Assist. Sau login, CLI
  lấy user info từ `https://www.googleapis.com/oauth2/v2/userinfo`.

**Gọi model bằng gì (chưa xác minh đầy đủ):**

- Cách chính là chạy `gemini` tương tác (TUI) và chọn "Sign in with
  Google" lần đầu (`gemini auth login` mở browser). **Chưa tìm thấy
  chế độ headless chuẩn dạng `claude -p` / `codex exec`** trong docs
  đã đọc — đây là điểm yếu nhất của Gemini CLI cho detected-provider.
- Hướng khả thi: qua **ACP** (OpenMausBot có driver
  `server/drivers/acp/gemini.ts` — chưa đọc sâu, suy đoán là spawn
  Gemini CLI ở chế độ ACP/stdin-stdout) hoặc qua **API Gemini bằng
  key** (đã có provider Gemini trong open-bot). Cần kiểm chứng bằng
  `--help` của `gemini` trên máy thật trước khi chọn.
- MCP: Gemini CLI hỗ trợ MCP server trực tiếp (từ Q1 2026).

**Cách kiểm tra đăng nhập (suy đoán cần kiểm chứng):** sự tồn tại +
đọc được của `oauth_creds.json` (chỉ kiểm tra tồn tại/hạn, không đọc
token) hoặc `google_accounts.json` (email). Lưu ý trên thực tế có máy
chỉ có `projects.json` trong `~/.gemini` (chưa đăng nhập hoặc login
nằm ở keychain) — detector phải xử lý cả trường hợp keychain.

### 2.5. Aider — `Aider-AI/aider`

**Binary:** `aider` (Python, `pip install aider-chat`).

**"Session" lưu ở đâu:** Aider **không có login/subscription riêng**
(chắc chắn — docs Aider + nhiều nguồn độc lập). Nó chỉ là client gọi
API:

- Key qua biến môi trường: `OPENAI_API_KEY` (chính),
  `ANTHROPIC_API_KEY`, `AZURE_API_KEY`…; base URL qua
  `OPENAI_API_BASE` (mặc định OpenAI, đổi được sang bất kỳ endpoint
  OpenAI-compatible nào: LiteLLM, Ollama local, vLLM…).
- Config file: **`.aider.conf.yml`** — thứ tự ưu tiên: cờ CLI >
  biến môi trường (`AIDER_*`) > `./.aider.conf.yml` (project) >
  `~/.aider.conf.yml` (home) > mặc định. Có thể ghi key trong YAML
  (`openai-api-key: …`) nhưng **docs khuyên không làm** — để key ở
  env hoặc file `.env` (mode 0600, `--env-file`), không commit YAML
  chứa key vào repo.
- Model: `--model openai/<model-id>` (prefix `openai/` nghĩa là dùng
  OpenAI-compatible protocol + base URL đã đặt); `AIDER_MODEL` env.

**Gọi model bằng gì:** `aider --model …` mở TUI pair-programming
(git-aware, tự commit). **Không có chế độ headless chuẩn** như
`claude -p`; không có MCP native (tính đến 05/2026, theo tài liệu
tham khảo — các issue #3314, #2672, #4506).

**Kết luận cho detector:** với Aider, detector chỉ nên báo "đã cấu
hình key cho provider X (qua env/file)" — **không có tài khoản để
hiển thị**. Giá trị thực của Aider cho open-bot là thấp (nó không
mang subscription nào mà open-bot chưa có qua API key); chỉ nên làm
sau 5 CLI chính, hoặc bỏ qua.

### 2.6. Cursor CLI — `cursor-agent` / `agent`

**Binary:** `cursor-agent` (cài bằng `curl https://cursor.com/install
| bash`, vào `~/.local/bin/cursor-agent`); một số bản phân phối tạo
thêm shim `cursor` hoặc lệnh `agent`. (Chắc chắn — docs Cursor +
nhiều nguồn độc lập, kiểm tra với binary `v2026.10.01-e373342`.)

**Session lưu ở đâu (chắc chắn ở mức docs, suy đoán ở chi tiết file):**

- `agent login` (browser flow) lưu credential **local**; trên macOS
  dùng **login keychain** (keychain khoá thì headless thất bại — cần
  `security unlock-keychain ~/Library/Keychains/login.keychain-db`
  hoặc fallback). `agent logout` xoá credential đã lưu.
- Hoặc dùng API key: tạo trong Cursor Dashboard → API Keys, đặt
  `CURSOR_API_KEY` (khuyến nghị cho script/CI) hoặc cờ `--api-key`;
  `--auth-token` / `CURSOR_AUTH_TOKEN` cho ACP client.
- Config: `.cursor/rules`, `AGENTS.md`, `mcp.json` (project và
  `~/.cursor/mcp.json`) — CLI đọc chung với editor.
- **Lưu ý quan trọng từ tài liệu tích hợp độc lập (Omniscio):** trong
  một số triển khai, `cursor-agent login` **không xác thực được các
  turn headless** — cần API key thật. Cần kiểm chứng trên máy thật
  trước khi hứa hẹn "mượn login Cursor".

**Gọi model bằng gì (chắc chắn):**

- **Nên dùng: `cursor-agent -p --output-format stream-json`** (hoặc
  `--print`): non-interactive, prompt **qua stdin** (không qua argv —
  `cmd.exe` cắt argv nhiều dòng ở newline đầu tiên, và một triển khai
  độc lập đã xác minh: prompt qua stdin đi nguyên vẹn qua chuỗi
  `cmd.exe → powershell → agent`). `--force` tự duyệt chạy lệnh,
  `--trust` qua cổng Workspace-Trust riêng của headless (không có thì
  in "Workspace Trust Required" và exit code 1, không ra event nào).
  `--resume <id>` để tiếp tục session; `session_id` là ID session.
  Một process mỗi turn (không có process sống lâu như Claude).
- **`agent acp`**: ACP server — JSON-RPC 2.0 trên stdio, một message
  NDJSON mỗi dòng; luồng: `initialize` → `authenticate` (methodId
  `"cursor_login"`) → `session/new` hoặc `session/load` →
  `session/prompt` → nhận `session/update`.
- Tương tác: `agent` (không tham số mở session), `agent "<prompt>"`,
  `agent ls` (liệt kê session), `agent resume`, `agent status`
  (alias `whoami`), `agent mcp login <identifier>`,
  `agent --list-models` (model theo plan; reasoning nằm trong tên
  model, ví dụ `claude-opus-5-5-high`, `gpt-5.3-codex-low`).
- Session lưu bền, resume được.

**Cách kiểm tra đăng nhập:** `agent status` (alias `whoami`, có
`--format json`) — hiện đã đăng nhập chưa, tài khoản nào, endpoint
nào. `agent about` (version + account info).

### 2.7. Continue — `continuedev/continue` (`cn`)

**Binary/ứng dụng:** extension VS Code/JetBrains + CLI `cn`.
**Không có login/subscription riêng** (chắc chắn — docs Continue).

- Model khai trong **`~/.continue/config.yaml`** (thay cho
  `config.json` cũ đã deprecated): mỗi model một mục `provider`,
  `model`, `apiBase`, `apiKey` (hỗ trợ `${{ secrets.X }}` — tra trong
  `.env` ở workspace root, `.continue/.env`, rồi `~/.continue/.env`),
  `roles: [chat, edit, apply]`. Provider `anthropic` dùng protocol
  Anthropic (`/v1/messages`), `openai` dùng OpenAI-compatible
  (`/v1/chat/completions`); `apiBase` của Anthropic **phải gồm `/v1`**.
- Key lấy từ provider key trực tiếp (BYOK) hoặc hub secret; không có
  OAuth subscription kiểu Claude Pro/ChatGPT để mượn.

**Kết luận cho detector:** giống Aider — chỉ phát hiện "đã cấu hình
model/key cho provider X trong `config.yaml`". Continue **không phải
engine để spawn** (nó là IDE extension, không có agent loop headless
độc lập); giá trị cho detected-provider là thấp. Nên để ở cuối danh
sách, hoặc chỉ đọc `config.yaml` để gợi ý provider đã có key.

### 2.8. Grok CLI (xAI) — `grok` (bổ sung từ OpenMausBot)

Đã nghiên cứu kỹ trong `docs/research-openmausbot.md` §4.4; tóm tắt
lại ở đây để đủ bộ detector (chắc chắn — code OMB đã kiểm chứng với
grok 1.0.0/1.0.25/1.0.41):

- **Binary:** `grok` (cài bằng `curl -fsSL https://x.ai/cli/install.sh
  | bash` — POSIX shell, không có one-liner Windows).
- **Session:** `$GROK_HOME` hoặc `~/.grok`; **`auth.json` là bằng
  chứng đăng nhập** (tồn tại = đã đăng nhập; không đọc nội dung);
  `config.toml` chứa `[models]`/`[model.<slug>]` (slug local cho
  `grok -m <slug>`). **Không có lệnh status.**
- **Gọi model:** `grok --permission-mode <mode> agent [-m <model>]
  [--reasoning-effort <level>] stdio` (ACP stdio; `-m`/`--effort`
  phải đặt giữa `agent` và `stdio`). Model mặc định `grok-4.7`
  (context 500.000).
- **Login:** `grok login --device-auth` / `grok logout`; lỗi login
  được phân loại chi tiết (CLI cũ, tài khoản không hỗ trợ device code,
  code hết hạn, bị từ chối).
- **Bảo mật:** xoá `XAI_API_KEY` khỏi env của turn (rò rỉ key sẽ âm
  thầm chuyển subscription grok.com sang pay-as-you-go).

## 3. OpenManus — repo tham khảo PHỤ (ngắn gọn theo đính chính)

> Theo đính chính ngày 2026-11-09, OpenManus **không phải** repo chính
> của hướng này (không có repo nào tên "OpenManusBot"; OpenMausBot mới
> là repo chính). Mục này chỉ ghi ngắn gọn pattern đáng học.

**Repo:** https://github.com/FoundationAgents/OpenManus — **58.867 sao**,
10.229 fork, MIT, Python 3.12, tạo 2025-03-06, 535 commit
(xem ngày 2026-11-09). Nhóm MetaGPT (tác giả chính Xinbing Liang,
Jinyu Xiang). Prototype làm trong 3 giờ theo cảm hứng Manus.im.

**Cấu trúc (chắc chắn — README + phân tích độc lập đã đọc):**

```
main.py            # 29 dòng: tạo Manus agent, chạy prompt, dọn dẹp
run_flow.py        # chạy multi-agent flow
run_mcp.py / run_mcp_server.py   # MCP client / server
sandbox_main.py    # entry sandbox
app/agent/         # BaseAgent + ReActAgent + ToolCallAgent + Manus + SWE + DataAnalysis + Browser + Sandbox + MCP
app/flow/          # BaseFlow + PlanningFlow + FlowFactory
app/tool/          # PythonExecute, BrowserUseTool, StrReplaceEditor, AskHuman, Terminate, MCP, ...
app/sandbox/       # Docker-based sandbox (client.py + core/)
app/mcp/           # MCP server
protocol/a2a/      # Agent-to-Agent
config/config.toml # LLM: model/base_url/api_key/max_tokens/temperature; [llm.vision]; [runflow]
```

**Pattern đáng lấy (bảng đối chiếu open-bot):**

| Pattern OpenManus | Ý tưởng | Open-bot |
|---|---|---|
| Agent = state machine + loop + tool (BaseAgent → ReActAgent → ToolCallAgent → Manus) | Tách 3 tầng: trạng thái (idle/running/finished/error + memory + step counter + stuck detector), vòng think/act, rồi mới tool-call parsing. Agent chuyên hoá bằng subclass (SWE, DataAnalysis, Browser). | ◐ open-bot đã có agent core + 5-role subagents, nhưng chưa tách rõ tầng state-machine/think-act; stuck detector là ý hay chưa có |
| Tool collection = "named bag of tools" | Agent cầm một túi tool có tên; Manus mặc định: PythonExecute + BrowserUseTool + StrReplaceEditor + AskHuman + Terminate + MCP client | ✅ open-bot đã có ToolRegistry + 131 tool; túi tool theo bot là ý đã có ở mức cơ bản |
| PlanningFlow (flow/) | Phân rã prompt thành các bước có theo dõi, gán cho agent khác nhau; FlowFactory dựng flow; Manager-To-Employee: agent quản lý chia việc cho agent nhân viên chạy song song, mỗi nhân viên chỉ thấy tool/hướng dẫn của subtask | ◐ open-bot có plan_create + delegate_task + subagents; chưa có flow orchestrator riêng với step tracking + M2E |
| Sandbox Docker (app/sandbox/) + Daytona | Code chạy trong container dùng một lần, không chạm host filesystem/network/env trừ khi cấu hình rõ | ◐ open-bot có session box + sandbox allowlist; chưa có Docker sandbox dùng một lần |
| LLM client thống nhất | Một interface async cho mọi provider OpenAI-shape (Anthropic, Bedrock, Azure, Ollama); config TOML một file | ✅ open-bot đã có 6 provider + OpenAI-compatible |
| MCP 2 chiều | `run_mcp.py` (client) + `run_mcp_server.py` (server); Browser Use chạy dạng MCP server mặc định (`uvx browser-use --cli-mcp`) | ✅ open-bot đã có MCP client + server |
| Giới hạn | CLI Python đơn process, đơn user, không UI server, không multi-tenant, không câu chuyện deploy production | — open-bot đã vượt ở mặt này (Electron + team + Local API) |

**Kết luận:** OpenManus đáng học nhất ở **tầng agent/flow** (state
machine, stuck detector, PlanningFlow, M2E) — không phải ở hướng
detected-provider (nó không mượn login CLI nào; nó dùng API key trong
`config.toml`). Đừng dành thêm công sức cho nó ở wave sau.

## 4. grok-bot-0.18-reconstructed — đối chiếu với phân tích 0.79.3

**Repo:** https://github.com/b-nnett/grok-bot-0.18-reconstructed —
~3,5k sao (3.499 theo ghi nhận 2026-09-14), TypeScript, **không có
giấy phép** (GitHub báo license: None — chỉ đọc tham khảo, không lấy
code). Tạo 2026-08-23, commit hiện tại `a9f633e` (2026-08-23).
Tự mô tả: "unofficial source-oriented reconstruction" của Grok Bot
0.18.0 macOS đã phát hành công khai; "hacking and research project,
not Anysphere's original monorepo and not an official Grok Bot
release". Giữ bản installer gốc 0.18.0 qua Git LFS (macOS arm64 DMG
SHA-256 `a253ccd8…`, Windows x64 Setup.exe `464079a1…`).

**Quy mô đo được:** `source/` có **1.722 file TS, 441.230 dòng**
(chưa tính test) — runtime + control-plane được tái dựng thành
TypeScript đọc được; **renderer giữ nguyên bản shipped** (đã minify,
không có source gốc) rồi vá thêm UI Router settings bằng transform
xác định (deterministic), hash chunk gốc và chunk đã vá đều được ghi
lại để kiểm chứng. Frontend tái dựng một phần nằm ở `frontend/` (chỉ
để hiểu contract UI, không phải bản thay thế pixel-perfect).

### 4.1. Giống với 0.79.3 (khớp phân tích đã có)

| Điểm | 0.18 (reconstructed) | 0.79.3 (phân tích tĩnh) |
|---|---|---|
| Nền tảng | Electron 42.1.0 / Chromium ~140, tên nội bộ `sand`, nhà Anysphere/Cursor | Electron 42.11.16 / Chromium 148, tên gói `sand` |
| Tiến trình | Electron main + preload + host + node-agent-coordinator + local-exec-daemon | Main 2 giai đoạn + renderer + local-exec-daemon + node-agent-coordinator |
| Backend | ConnectRPC/Protobuf tới `api2.cursor.sh` | Cùng backend + RPC nhị phân |
| Box | Agent chạy trong box Linux (container/pod), desktop app là "tay" trên máy user; host gateway `127.0.0.1` trong box: `/health`, `/events` (SSE), `/api/<method>`, `/local-exec/requests\|responses`, `/webauthn/requests\|responses`, `/avatars/…` | Cùng mô hình box/session-box; chưa đào tới chi tiết gateway trong box |
| Kênh ngược | Box → Mac qua local-exec channel: `ExternalShell`, `ExternalRead`, `AwaitExternalShell` | Có `GrokBotUserComputerLocalToolCall` + daemon phone tools; chưa nêu tên `ExternalShell` |
| MCP/plugin/secrets | MCP runtime, OAuth bắt ở `openExternal`, secret store | Cùng: `mcp-auth.json`, vault, 1Password broker |
| VNC/desktop | Desktop trong box (X11 + noVNC + Chrome), clipboard mirror qua VNC | Có preload VNC + desktop-mount, `sand-window-capture` |

### 4.2. Khác / mới so với 0.79.3 (phần đáng học)

| Điểm | 0.18 có, 0.79.3 chưa thấy (hoặc khác) | Ý nghĩa cho open-bot |
|---|---|---|
| **Inference Router** (Settings → Router) | Chọn backend cho turn mới: **Cursor** (session Grok Bot/Cursor sẵn có, tool/plugin native) / **Claude Code** (login Claude Code sẵn có, Grok Bot MCP tools được route qua) / **Codex** (login ChatGPT/Codex local, Direct Responses transport với Grok Bot tools) / **OpenRouter** (API key qua secrets bridge, tool-execution loop riêng). **Claude Code và Codex không cần API key riêng khi client local đã đăng nhập.** Giữ streaming, thinking state, reaction, rich plugin mention, MCP tool execution khi route. Code: `source/node-agent-coordinator/inference-router.ts`, `source/shared/inference-router.ts`, `source/host/extensions/inference/` | **Đây là tiền lệ trực tiếp của detected-provider**: Grok Bot 0.18 cộng đồng đã làm đúng ý Huy muốn (mượn login CLI sẵn có) trước cả OpenMausBot. Đáng học: bảng router (provider/auth/tool support), "Usage & Billing" ghi request/token local (ghi rõ chỉ là activity record, không phải hoá đơn chính thức) |
| **Local Docker sandbox** (toggle "Use local Docker VM") | Chạy box host + execution daemon trong container local do user sở hữu thay vì box remote: chỉ bind cổng loopback, mount artifact host/daemon chỉ-đọc dạng content-addressed, tái dùng auth provider sẵn có, validate trước khi coordinator nối, dừng/thay qua cùng lifecycle settings. Cần Docker Desktop. Remote vẫn là mặc định | Mẫu cho mốc sandbox local của open-bot (M6): loopback-only + mount chỉ-đọc + tái dùng auth + validate trước khi nối |
| **box-exec-daemon** | Thư mục `source/box-exec-daemon/` riêng (daemon thực thi trong box), tách khỏi `local-exec-daemon` (daemon trên máy user) | 0.79.3 không nêu tên này — có thể là phần trong box mà phân tích 0.79.3 chưa tách ra. Gợi ý open-bot tách rõ daemon-trong-box vs daemon-trên-máy |
| Cấu trúc electron-main đọc được | Các module đặt tên rõ: `account/ adapters/ attachments/ auth/ box/ coordinator/ deep-link/ dev/ downloads/ experiments/ feedback/ generated/ local-exec/ mcp/ media/ models/ notifications/ onepassword/ prefs/ process-metrics/ secrets/ startup/ telemetry/ update/ vnc/` | Dùng làm checklist đối chiếu module main process của open-bot (xem thiếu gì: process-metrics, deep-link, experiments…) |
| Tài liệu "How Grok Bot 0.18.0 Works" (shadown.github.io, độc lập) | Mô tả cơ chế đã kiểm chứng trên bundle: host gateway, box, reverse tool channel, desktop-bridge (WebAuthn qua proxy, clipboard mirror, browser, secrets) | Bổ sung cho phân tích 0.79.3 ở phần box gateway + reverse channel |

### 4.3. Cái 0.79.3 có mà 0.18 không thấy (hoặc 0.18 chưa tới)

- 0.79.3 có **76 tool call** (proto) + ~392 RPC GrokBotService; 0.18
  tái dựng chưa chắc đủ số đó (tài liệu 0.18 không đếm tool; cần đếm
  trong `source/` nếu muốn so chính xác — **chưa làm ở wave này**).
- 0.79.3 có voice-call realtime (`wss://api.x.ai/`, voice toolset
  riêng, surface register); 0.18 không nhấn mạnh voice trong README.
- 0.79.3 có automations/dream phía server, Statsig flags, egress
  tunnel flags; 0.18 là bản cũ hơn ~3 tháng (0.18.0 tháng 8/2026,
  0.79.3 build 2026-11-06) nên nhiều tính năng chưa có là bình thường.
- **Kết luận:** 0.18 là "bản cũ hơn nhưng đọc được" (source TypeScript
  rõ ràng), 0.79.3 là "bản mới hơn nhưng chỉ phân tích tĩnh được"
  (bundle minify). Hai nguồn bổ sung cho nhau; phần router + Docker
  sandbox của 0.18 là mới và đáng lấy nhất.

## 5. Awesome lists + grok-bot-cli + GrokBotDev + groki-bot

### 5.1. RongleCat/awesome-grok-bot và majiayu000/awesome-grok-bot

Hai repo cùng tên, vai trò khác nhau (chắc chắn — đã đọc README +
commit):

- **RongleCat/awesome-grok-bot**: danh sách tài nguyên Grok Bot đã
  curated (docs chính thức, lịch meetup, tài nguyên cộng đồng).
  README ~568 KB (3 ngôn ngữ: en/ja/zh), kèm `EVENTS.md` (~60 KB).
  Là nơi "gốc" mà majiayu000 trỏ tới cho docs chính thức + meetup.
- **majiayu000/awesome-grok-bot**: **catalog các live share
  `x.ai/bot`** — **6.656 share còn sống** (kiểm tra HTTP ngày
  27/10/2026: 6.649/6.688 trả 200, 39 share cũ 404), có thể preview và
  Add; **không phải prompt dump**. Một share là **recipe, không phải
  clone**: copy tên, skill, routine, workflow memory liên quan, plugin
  first-party — **không copy** computer, file, login, MCP/script tuỳ
  chỉnh, API key, memory cá nhân/nội bộ. Có `catalog.json` (5,1 MB,
  đọc được bằng máy) + site tìm kiếm (lọc theo category + shelf).
  Maintainer quét X/GitHub/grokbot.dev/writeup công khai hằng ngày để
  thêm share/field case/docs/gotcha/tool mới; chỉ có một GitHub Action
  lint. **0/6.656 share được maintainer verify** (verify = import bot
  và xong một task đầu tiên an toàn) — cảnh báo rõ: "Community shares
  are untrusted. Read the profile, connect one plugin, try a read-only
  task, then enable writes. Do not paste API keys into SETUP."
- **Field case đáng chú ý** (từ các bản ghi usage.incidental.site dẫn
  tới 2 list này): Polymarket daily settlement brief; 13-bot household
  swarm; 5-bot hackathon kit (orchestrator→reviewer, research→PRD→
  public repo); market-research desk; Fiverr sourcing bot; 11 jobs của
  Matthew Berman (email scoring, DoorDash, dọn disk 90 GB, Telegram
  bridge…); 3-bot lab từ ảnh cấu trúc → mô phỏng vật lý → báo cáo
  LaTeX → file STL in 3D.
- **Gotcha đáng ghi:** bot share một cloud Linux computer (tối đa 50
  bot/tài khoản), không phải app trên laptop; không có app Linux
  desktop chính thức; share không mang theo login/MCP/key.

**Đáng lấy cho open-bot:**

1. **Định dạng "share = recipe"** (copy skill/routine/memory liên quan,
   không copy secret/computer) — dùng cho tính năng export/import bot
   và template marketplace của open-bot (đã có `agent_export/import`,
   `skill_marketplace_*`; cần thêm quy tắc "không bao giờ export
   secret" dạng tường minh).
2. **Catalog đọc được bằng máy** (`catalog.json` + lint bằng
   `node scripts/lint.mjs`) — mẫu cho marketplace/skill catalog của
   open-bot.
3. **Cảnh báo "untrusted share" + quy trình thử an toàn** (đọc profile
   → nối 1 plugin → task chỉ-đọc → mới bật ghi) — đáng đưa vào UI
   import template của open-bot.
4. **Field case** làm nguồn ý tưởng use case (đặc biệt multi-bot swarm
   và market desk) — không cần nghiên cứu thêm ở wave này.

### 5.2. ScriptedAlchemy/grok-bot-cli (`gbot`)

**Repo:** https://github.com/ScriptedAlchemy/grok-bot-cli — MIT,
npm `grok-bot-cli` (v0.12.5), ~115 sao, Node 22.19+. Lệnh `gbot`.

**Cách tổ chức lệnh (chắc chắn — README + npm):**

```
gbot bots list
gbot bots create --name Researcher
gbot bots update Researcher --description "..."
gbot groups create --name Launch --member Researcher --member Writer --description "..."
gbot groups update Launch --title "..."
gbot groups delete Launch
gbot send Researcher "..."            # nhắn bot
gbot thread Researcher                # đọc thread
gbot thread Researcher --after <last-entry-id> --json
gbot skills add ./skills/poteto-mode  # quản lý skill library qua gateway
gbot skills                          # (quản lý skill library theo tài khoản, một library mỗi account)
```

- **Cơ chế auth:** cần Grok Bot desktop app đã đăng nhập một lần;
  `gbot` **tự dùng encrypted session + routing credential của app**
  (hoặc `GROK_BOT_GATEWAY_URL` + `GROK_BOT_GATEWAY_TOKEN`, hoặc
  `CURSOR_ACCESS_TOKEN`). Không phải API công khai — Cursor forum xác
  nhận **không có public API/SDK** cho Grok Bot; `gbot` đi qua session
  của app desktop + gateway nội bộ (theo forum 08/2026: gateway HTTP
  riêng trên máy của Bot, thường cổng 1340, bearer token, các call
  `POST /api/listAgents`, `POST /api/sendPrompt`). **Có thể vỡ sau mỗi
  lần app cập nhật** — rủi ro này cần ghi rõ nếu open-bot học theo.
- **Thread API:** `gbot thread --after ID` lọc đuôi (bounded tail)
  ở local, trả entry sau ID mờ đó; JSON gồm `cursor`, `entryCount`,
  `gapReset`; `gbot_thread` trả receipt nhỏ mặc định (summary xác
  định, cursor mờ, entryCount, gapReset).
- **Agent Bundle plugin:** cùng repo ship plugin cho Codex/Claude
  Code/Cursor: MCP server `grok-bot` với tool `gbot_send`,
  `gbot_thread` (nói chuyện Grok) + `codex_threads`, `codex_send`,
  `codex_new`, `codex_wait`, `codex_watch` (nói chuyện Codex) + skill
  `talk-to-grok-bot` (dạy agent khi nào ping bot và viết message ra
  sao: dòng đầu nêu mình là ai + cần gì, rồi mới đọc reply bằng
  `gbot_thread`). Cài bằng `codex plugin marketplace add
  ScriptedAlchemy/grok-bot-cli` / `claude plugin marketplace add …`.
  Có cả "Messaging a live Claude Code session" và cầu nối Codex thread
  ↔ Grok Bot (trả lời tự động 2 chiều Grok ↔ Codex).
- **Đáng lấy cho open-bot:** (1) **ngữ pháp lệnh** `bots/groups/
  send/thread/skills` — mẫu cho headless CLI của open-bot (mốc M8
  doc OpenMausBot); (2) **thread cursor mờ + receipt** (`cursor`,
  `entryCount`, `gapReset`) — mẫu cho API đọc thread; (3) **plugin
  MCP 2 chiều** (MCP server + skill hướng dẫn agent cách nói chuyện
  với bot khác) — mẫu cho A2A của open-bot; (4) **cảnh báo**: dựa vào
  session/gateway nội bộ không có tài liệu thì giòn — open-bot nên làm
  Local API có tài liệu + version thay vì bắt chước đường này.

### 5.3. ZeroPointRepo/GrokBotDev (grokbot.dev)

**Repo:** https://github.com/ZeroPointRepo/GrokBotDev — thư mục
`content/plugins/` (**60 file**), `content/use-cases/` (**138 file**),
`content/collections/`, `content/news/`, `content/templates/`. Site
grokbot.dev.

**Mô hình nội dung (chắc chắn — CONTRIBUTING.md):**

- **Không database:** mỗi plugin/use case/collection là **một file
  Markdown**, tên file = slug (kebab-case, khớp field `slug`); build
  kiểm tra schema chặt (`src/content.config.ts`) — thiếu/sai field là
  build fail, không có gì hỏng được ship. Nộp bằng PR + `npm run
  validate` (schema, slug, vocab). Trang submit chỉ hỏi một field:
  link share `https://x.ai/bot/…` (không cần account/GitHub/login).
- **Quy tắc vàng G1–G8**, trong đó **G3 Prompt provenance:** prompt
  của tác giả phải **byte-identical** và ghi `prompt_provenance:
  author`; nếu dựng lại từ mô tả thì là `curator` và trang phải nói
  rõ. **Không bao giờ để API key/token/password/cookie trong prompt
  hay field.**
- **Awesome Score:** use case được xếp hạng theo thang điểm (hook,
  summary, category, nguồn…); mỗi card: score eyebrow · hook ·
  summary · categories · source.
- **Plugin tiêu biểu (đọc từ commit gần đây):** AgentMail (cho bot
  inbox email riêng, 24 tool, OAuth không cần key — prompt dặn bot
  chỉ gửi từ inbox đó, trước khi gửi phải hiện đủ recipient/subject/
  body và xin duyệt; không gửi bulk khi chưa duyệt cả danh sách),
  Bland (số điện thoại thật + voice AI gọi điện, ~$15/số; quy tắc:
  trước khi quay số phải hiện người gọi/số/mục tiêu/kịch bản và chờ
  duyệt; luôn nói mình là AI; không clone giọng trừ giọng của chính
  user khi được yêu cầu rõ; không gọi emergency; tôn trọng do-not-call),
  Composio, Postiz, Gojiberry AI (warm B2B lead từ 15+ buying signal;
  quy tắc: không bịa lead/signal/field; gửi/sync CRM phải duyệt trước),
  Mentions.so (theo dõi brand trong câu trả lời của ChatGPT/Perplexity/
  Grok…), Tiiny Host, Zernio, iMessage, BulkPublish, ContentDrips…
- **Use case tiêu biểu:** "Be Happier · Weekly Wellbeing Coach"
  (Lenny), "Give your Grok Bot a phone number", "Give your Grok Bot
  its own email inbox".

**Đáng lấy cho open-bot:**

1. **Định dạng 1 file Markdown = 1 plugin/use case + validate schema
   ở build** — mẫu cho skill/plugin marketplace của open-bot (đã có
   skill YAML 3-tier; nên thêm schema validate + slug = tên file).
2. **Prompt provenance** (author byte-identical vs curator) — đáng đưa
   vào skill marketplace: ghi rõ prompt nào là gốc, prompt nào dựng
   lại.
3. **Quy tắc an toàn gắn trong prompt** (hiện đủ nội dung trước khi
   gửi/gọi, chờ duyệt; không bịa field) — mẫu cho "skill an toàn" của
   open-bot; đặc biệt mẫu Bland/AgentMail cho các tool gửi tin/gọi
   điện (open-bot đã có `email_*`, `imessage_draft` — nên thêm quy tắc
   tương tự vào mô tả tool).
4. **Catalog plugin theo category/subcategory** (sales/calls, email…)
   — mẫu phân loại cho MCP marketplace.

### 5.4. JosssphZhou/groki-bot — robot desktop + voice + MCP gateway

**Repo:** https://github.com/JosssphZhou/groki-bot — BSL-1.0
(firmware), gateway MIT riêng; tạo 2026-09-23; ESP-IDF 5.5, C++20;
board M5Stack CoreS3 + đế Stack-chan; còn build cho StopWatch,
AtomS3R, AtomS3.

**Kiến trúc (chắc chắn — README + CLAUDE.md + gateway README):**

```
Robot (M5Stack CoreS3, XiaoZhi client)
  ← XiaoZhi WebSocket :8765 →
Gateway (Python, gateway/, MIT)
  ← MCP (stdio) → Claude Code / Claude Desktop / MCP client
  ← voice → Gemini Live (mặc định) / Grok login voice
  ← Grok voice → localhost:18771 login helper → native Grok Bot
  ← Gemini ask_grokbot → localhost:18770 → gbot CLI → Grok Bot
```

- **Gateway** (`gateway/`, Python, `pyproject.toml`, `uv.lock`):
  voice conversation (Gemini Live mặc định, hoặc Grok login voice
  dùng login sẵn của app Grok Bot trên Mac, **không cần key voice
  xAI riêng**), wake word **"Hi Grok"** (nhận diện local trên máy
  tính — chỉ forward audio mic lên backend sau khi gọi), MCP server
  (tool `speak`, `get_status` cho Claude Code/Desktop hoặc MCP client
  bắt robot nói/đọc trạng thái), face tracking trên Mac có camera
  (robot quay đầu theo mặt — không qua MCP mà qua message `head` của
  XiaoZhi), voice control Mac, tool `ask_claude` (chỉ hiện khi CLI
  `claude` đã cài — giao câu khó cho Claude CLI), tool `ask_grokbot`
  (chỉ Gemini — giao việc cho agent trong app Grok Bot qua `gbot`
  rồi đọc đáp án thành tiếng).
- **Firmware:** ESP-IDF 5.5, C++20; component `conversation`
  (OpenAI Realtime, Gemini Live, XiaoZhi client), `groki_motion`
  (đầu springs, touch, IMU); flash web một click + OTA qua Wi-Fi;
  có `GBOT_VOICE_VALIDATION.md`, `VOICE_LATENCY_BENCHMARK.md`.
- **Lưu ý:** firmware XiaoZhi báo `features.mcp=false` nên tool MCP
  điều khiển phần cứng (`move_head`, `set_led`, `set_avatar`,
  `take_photo`…) trả lỗi với firmware này; chỉ `speak`/`get_status`
  hoạt động. Các tool voice-device chung (`STACKCHAN_GEMINI_DEVICE_
  TOOLS=1`) không cần MCP: `move_head` gửi dạng message `head`
  (firmware >v0.2.1), `set_avatar` dạng emotion, `set_all_leds` dạng
  message `led`. Tính năng tuỳ chọn (Mac control, device tools,
  Grok Bot hand-off qua `STACKCHAN_TOOL_BOT`) **mặc định tắt**.
- Cùng tác giả còn có **poki** (MCP server + agent điều khiển iPhone
  thật trên macOS, không jailbreak) — cùng họ "MCP bridge ra thiết bị
  thật".

**Đáng lấy cho open-bot:**

1. **Mẫu "gateway local nối voice + MCP + app desktop"**: một service
   Python nhỏ trên máy user, wake word local (chỉ forward audio sau
   khi gọi), MCP server để agent khác bắt thiết bị nói/làm, hand-off
   qua CLI (`gbot`, `claude`) bằng cổng loopback riêng (18770/18771).
   Open-bot có thể dùng mẫu này cho voice companion / thiết bị ngoại
   vi sau này — nhưng **không phải mốc ưu tiên** (cần phần cứng).
2. **Nguyên tắc "optional off by default"**: mọi tính năng chạm tới
   máy/thiết bị (Mac control, hand-off) mặc định tắt — đúng triết lý
   opt-in của detected-provider.
3. **Tách license theo thư mục** (firmware BSL-1.0, gateway MIT) —
   nhắc open-bot giữ license rõ khi tích hợp code bên ngoài.

## 6. Đề xuất tích hợp cho tính năng "detected CLI provider"

(Chi tiết mốc + ước lượng quy mô xem `docs/research-openmausbot.md`
§13, mốc M1–M5. Mục này ghi **thiết kế detector registry** và gợi ý
UI, lấy OpenMausBot làm nguồn chính, các CLI gốc làm nguồn phụ.)

### 6.1. Detector registry — thiết kế đề xuất

Mỗi CLI là một **detector** khai báo (không phải code riêng rẽ):

| Trường detector | Ví dụ (Claude Code) | Ví dụ (Codex) | Ví dụ (Grok CLI) |
|---|---|---|---|
| `binary` (tên + đường dẫn tuỳ chỉnh) | `claude` | `codex` | `grok` |
| `versionProbe` | `claude --version` + version tối thiểu | `codex --version` | `grok --version` |
| `signInCheck` | `claude auth status --json` | hỏi Codex tự báo (không đọc `auth.json`) | file `~/.grok/auth.json` tồn tại (không có lệnh status) |
| `accountLabel` (chỉ nhãn, không token) | `oauthAccount` trong `~/.claude.json` / output status | tài khoản hiệu lực do Codex báo | (không có — chỉ biết đã đăng nhập) |
| `loginCommand` (hướng dẫn user) | `claude auth login` | `codex login` / `--device-auth` | `grok login --device-auth` |
| `invoke` (cách gọi model) | retained process, stream-JSON 2 chiều, stdin | `codex app-server` (JSON-RPC NDJSON stdio) | `grok --permission-mode … agent stdio` (ACP) |
| `unavailableReason` | "chưa cài / chưa đăng nhập / login hết hạn (ngày…)" | tương tự | tương tự |
| `envScrub` (dọn env của turn) | — | — | xoá `XAI_API_KEY` khỏi env |

**Quy tắc bắt buộc (rút từ cả 3 nguồn chính):**

1. **Opt-in rõ ràng:** detector chỉ *phát hiện*; dùng CLI nào phải
   được user bật (mặc định: hỏi lần đầu, không tự bật). Tắt được từng
   nguồn; tắt thì provider biến mất khỏi picker, turn đang chạy được
   dừng an toàn.
2. **Không copy/gửi credential đi đâu:** chỉ spawn CLI gốc trên máy
   user và để nó tự dùng session của nó. Không đọc nội dung file
   credential (`auth.json`, `oauth_creds.json`,
   `.credentials.json`…); chỉ kiểm tra tồn tại hoặc đọc **nhãn**
   (`oauthAccount`, `google_accounts.json`, output của lệnh status).
   Không log token (theo bài học Grok Bot 0.79.3: redact `Bearer …`).
3. **Hỏi chính CLI, đừng đoán từ file:** thứ tự tin cậy —
   lệnh status của CLI > hỏi qua protocol > kiểm tra file tồn tại.
   File tồn tại có thể là credential đã cũ (stale).
4. **Driver lạ/hỏng thì "unavailable", không crash:** snapshot trạng
   thái có deadline + tái dùng (theo OMB registry); mọi lỗi spawn đều
   có lý do hiển thị được.
5. **Dọn môi trường con:** xoá key lạ khỏi env khi spawn CLI (bài học
   Grok CLI: rò rỉ `XAI_API_KEY` đổi ngầm subscription sang trả theo
   dùng). Env allow-list cho turn trong sandbox.
6. **Prompt không lên argv:** đưa prompt qua stdin (giới hạn dòng lệnh
   Windows + prompt nhạy cảm), theo cách OpenMausBot làm với Claude.
7. **Một process sống mỗi thread** (Claude) / **app-server sống**
   (Codex) thay vì spawn mới mỗi message — giữ context + prompt-cache
   + resume được.
8. **Approval là của provider, truyền qua:** mức approval của bot map
   sang permission mode của CLI (`default`/`acceptEdits`/`auto`/
   `bypassPermissions`…); yêu cầu quyền giữa chừng hiện về UI để user
   duyệt (theo mẫu permission broker của OMB).
9. **API-key provider vẫn là fallback:** khi không có CLI nào, hoặc
   CLI chưa đăng nhập, hoặc user tắt hết, model picker quay về provider
   API key (Grok/OpenAI/Anthropic/Gemini/Ollama) như hiện tại. Không
   bao giờ chặn user vì "chưa có CLI".
10. **Version floor + chống lừa:** probe `--version`, từ chối binary
    trả version của chương trình khác (đường dẫn dán nhầm lệnh cài
    đặt), báo rõ "cần cập nhật CLI" khi quá cũ (theo
    `acp/version-probe.ts` của OMB).

### 6.2. Thứ tự ưu tiên làm detector

| Ưu tiên | CLI | Vì sao |
|---|---|---|
| P0 | Claude Code | Có lệnh status chuẩn (`auth status --json` + hạn login), headless chuẩn (`-p` stream-json), OMB đã kiểm chứng kỹ nhất; user trả phí Claude Pro/Max nhiều |
| P0 | Codex | Có app-server JSON-RPC chuẩn cho embedding; `login status`; user ChatGPT Plus/Pro nhiều |
| P1 | Grok CLI | ACP stdio rõ ràng, đã kiểm chứng grok 1.0.x; nhưng không có lệnh status (chỉ xem file) và user Grok CLI ít hơn 2 cái trên |
| P1 | OpenCode | Multi-provider (mượn theo từng provider bên trong); có `serve` HTTP + `acp`; lưu ý OpenCode 2 đổi credential store |
| P2 | Cursor CLI | Có ACP + `-p` stream-json; nhưng lưu ý headless có thể cần API key thật thay vì login (cần kiểm chứng) |
| P2 | Gemini CLI | Login Google phổ biến (free tier); nhưng chưa rõ headless chuẩn — cần kiểm chứng `--help` trước khi làm driver |
| P3 | Aider / Continue | Không có login riêng — chỉ phát hiện "đã cấu hình key cho provider X"; làm cuối hoặc bỏ qua |

### 6.3. Gợi ý UI (hiển thị model đang chạy qua tài khoản nào)

Lấy từ OpenMausBot (§8 doc chính) + yêu cầu của Huy (UI quen thuộc
với Grok Bot, không quá dày, tính năng nâng cao sau panel/menu):

- **Model picker có provider rail 3 nhóm:** subscription (CLI đã
  đăng nhập) / api (key) / custom; provider chưa dùng được thì **mờ
  đi kèm lý do** ("chưa cài Claude Code", "chưa đăng nhập Codex",
  "login hết hạn ngày …", "cần cập nhật Grok CLI").
- **Hiển thị nguồn trong chat:** mỗi bot/message ghi rõ model đang
  chạy qua tài khoản nào, ví dụ nhãn "Claude · Sonnet · qua tài khoản
  user@example.com (Claude Pro)" — chỉ nhãn, không token. Khi đổi
  model giữa chừng, nhãn đổi theo, thread giữ nguyên.
- **Settings → Engines:** danh sách engine đã phát hiện (binary, version,
  trạng thái, tài khoản, mức dùng), nút Sign in (mở login của chính
  CLI), "Set CLI…" (trỏ binary tuỳ chỉnh), Re-detect, bật/tắt từng
  nguồn, trạng thái "chưa có engine nào" có hướng dẫn cài.
- **Approval card:** yêu cầu quyền của CLI hiện thành thẻ Allow/Deny
  trong chat (theo mẫu OMB), không phải dialog chặn; bot đọc file của
  chính nó thì không hỏi (quy tắc OMB §9 doc chính).
- **Onboarding lần đầu:** khi phát hiện CLI mới, hiện một lần (không
  spam): "Phát hiện Claude Code đã đăng nhập (user@example.com) — dùng
  làm model cho bot mới?" [Dùng] [Không, để sau] — mặc định không tự
  bật.

## 7. Giới hạn & chưa xác minh

- **Không có CLI thật trên máy nghiên cứu:** mọi cơ chế session/lệnh
  đều từ docs/code công khai; chưa chạy `claude auth status`,
  `codex login status`, `opencode auth list`, `agent status` thật.
  **Bắt buộc kiểm chứng trên máy thật có CLI đăng nhập trước khi viết
  detector** (đặc biệt: Gemini CLI headless, Cursor headless có cần
  API key không, OpenCode 2 credential store, Codex `auth.json` vs
  keyring).
- **Version trôi nhanh:** cờ CLI đổi theo release (ví dụ Claude Code
  2.1.318 mới thêm `loginExpiresAt`; Grok CLI 1.0.x đổi giữa các bản
  nhỏ). Mọi tên cờ trong doc này cần kiểm tra lại bằng `--help` khi
  làm mốc.
- **OpenManus chỉ đọc README + phân tích độc lập**, không clone —
  theo đính chính nó chỉ là tham khảo phụ.
- **grok-bot-0.18-reconstructed không có giấy phép** — chỉ đọc để đối
  chiếu, không lấy code; số tool/RPC của 0.18 chưa đếm lại ở wave này.
- **Awesome lists:** số share (6.656) và trạng thái verify (0) lấy
  từ README/catalog ngày 27/10/2026 — có thể đã đổi.
- **grok-bot-cli dựa vào gateway nội bộ không có tài liệu** của Grok
  Bot — có thể vỡ sau cập nhật app; chỉ học ngữ pháp lệnh + mẫu
  thread cursor, không dựa vào gateway đó cho open-bot.

## Nguồn

- OpenMausBot (mẫu triển khai chính): `docs/research-openmausbot.md`
  (§4 engines, §8 model picker); clone
  `~/workspace/.research-clones/openmausbot` (commit `1de1164`).
- Codex: docs OpenAI (Authentication, Configuration reference;
  qua search); `openai/codex` (repo public); nghiên cứu độc lập
  triumvirate `031-codex-cli-deep-dive.md`, podium `codex.md`,
  DeepWiki `openai/codex/4-user-interfaces`.
- Claude Code: docs Anthropic `code.claude.com/docs/en/headless`;
  nghiên cứu độc lập `aishell/docs/research/claude-code-headless-cli.md`
  (claude 2.1.211, 2026-07-16), `camelai.com/blog/claude-code-headless-docker`,
  `sessionboxer.talayolabs.com/blog/claude-code-login-expired-auth-status/`
  (claude 2.1.318, 2026-11-04), `ankush.one/blogs/oof-claude-code-account-switcher/`,
  `aq.dev/guides/run-multiple-claude-code-accounts/`.
- OpenCode: `opencode.ai/docs/` (qua các tài liệu tích hợp độc lập:
  `mikeng-io/agent-skills/.../bridge-opencode/cli-reference.md`,
  `kenhuangus/agent-memory-harness/.../04-build-run-architecture.md`,
  `docs.nano-gpt.com/integrations/opencode` (OpenCode 1 vs 2),
  DeepWiki `leamiko/opencode/4.3.1-authentication-system`).
- Gemini CLI: nghiên cứu code `google-gemini/gemini-cli` tại
  `meta-develop/multi-agent_coding_orchestrator/.../gemini-cli.md`
  (commit `571851b`, 2026-08-18); `eugene1g/agent-safehouse/...
  /gemini-cli.md` (2026-02-12).
- Aider: docs Aider (qua `crossmodel.ai/integrations/aider`,
  `docs.bettertoken.ai/en/ai-tools/aider`,
  `connected-mate/corporate-launcher/.../cli-aider.md`).
- Cursor CLI: docs Cursor (qua `docs.arantic.com/cursor/cli`,
  `aftergradient.com/guides/cursor-cli`,
  `agentscli.com/foundations/cheatsheets/cursor/`,
  `docs.omniscio.com/library/cursor-provider-part-2.html`,
  `elijahmuraoka/skills/.../transport-reference.md`).
- Continue: `docs.continue.dev` (self-host a model);
  `ccsub.net/en/integrations/continue` (config.yaml).
- Grok CLI: code OpenMausBot `server/drivers/acp/grok.ts`,
  `server/drivers/grok.ts` (đã kiểm chứng grok 1.0.0/1.0.25/1.0.41).
- OpenManus: https://github.com/FoundationAgents/OpenManus
  (58.867 sao, README đọc ngày 2026-11-09) + phân tích độc lập
  (pyshine.com, solosoft.dev, spring-ai-ascend).
- grok-bot-0.18-reconstructed: clone
  `~/workspace/.research-clones/grok018` (commit `a9f633e`,
  2026-08-23); README + `source/` (1.722 file TS, 441.230 dòng);
  `shadown.github.io/blog/posts/2026-09-03_grok_bot_how-it-works/`.
- Awesome lists: clone `~/workspace/.research-clones/awesome-rongle`
  và `awesome-majiayu` (README + `catalog.json` 5,1 MB, 6.656 share).
- grok-bot-cli: https://github.com/ScriptedAlchemy/grok-bot-cli
  (npm `grok-bot-cli` 0.12.5); clone
  `~/workspace/.research-clones/grok-bot-cli`.
- GrokBotDev: https://github.com/ZeroPointRepo/GrokBotDev
  (60 plugin, 138 use case); clone
  `~/workspace/.research-clones/grokbotdev`.
- groki-bot: https://github.com/JosssphZhou/groki-bot
  (gateway Python + MCP); clone
  `~/workspace/.research-clones/groki-bot`.
- Đối chiếu Grok Bot 0.79.3: `docs/GROK-BOT-ANALYSIS.md`,
  `docs/rea-grokbot-deep-dive.md`.
