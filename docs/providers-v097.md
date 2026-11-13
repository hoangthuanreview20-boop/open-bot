# Providers + tools mới — v0.97 (Team T6)

Base: main `4113714`. Branch: `v097-providers`.

## 1. 7 provider API mới (OpenAI-compatible)

Mỗi provider là một file riêng trong `packages/core/src/providers/`,
theo đúng pattern của `xai.ts`: kế thừa `OpenAICompatibleProvider`
(transport `fetch` tới `/chat/completions`, không SDK), chỉ khác
base URL + model mặc định + danh sách model fallback. Không có key
nào trong code — key do user nhập trong Settings, lưu trong Vault
namespace `'provider'`, key = provider id (hàm `providerConfigFor`
trong `apps/desktop/src/main/main.ts` resolve chung cho mọi provider).

| Provider id | Label | Base URL | Default model |
|---|---|---|---|
| `deepseek` | DeepSeek | `https://api.deepseek.com/v1` | `deepseek-v4-flash` |
| `moonshot` | Moonshot (Kimi) | `https://api.moonshot.ai/v1` | `kimi-k3` |
| `qwen` | Qwen (Alibaba) | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| `mistral` | Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| `together` | Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `cohere` | Cohere | `https://api.cohere.ai/compatibility/v1` | `command-a-03-2025` |

Base URL + model mặc định đã đối chiếu với docs chính thức của từng
provider ngày 2026-11-13 (xem ghi chú trong từng file provider).
Danh sách model fallback (`*_KNOWN_MODELS`) chỉ dùng khi endpoint
không trả về `/models` — khi endpoint trả về, `listModels()` dùng
danh sách live.

Đăng ký ở: `PROVIDERS` + `createProvider` trong
`packages/core/src/providers/index.ts`; model catalogue + fallback
rẻ hơn trong `packages/core/src/models/registry.ts`; Settings UI
(`PROVIDER_META` trong `SettingsView.tsx`, key field + base URL +
default model + nút Test) và i18n `settings.provider.*` 6 locale.

### Thay đổi preset (`packages/core/src/models/presets.ts`)

- Thêm preset `moonshot` và `cohere` cho provider generic
  `openai-compatible` (người dùng cũ vẫn dùng preset được).
- Sửa default của preset `deepseek`: `deepseek-chat` →
  `deepseek-v4-flash` — hai alias cũ `deepseek-chat` /
  `deepseek-reasoner` đã bị DeepSeek gỡ ngày 2026-07-24.

### Lưu ý từng provider

- **DeepSeek**: V4 (04/2026) có `deepseek-v4-flash` (rẻ, 1M context)
  và `deepseek-v4-pro` (mạnh nhất). Alias cũ không còn dùng được.
- **Moonshot**: endpoint quốc tế `api.moonshot.ai`; tài khoản Trung
  Quốc dùng `https://api.moonshot.cn/v1` (key theo vùng — user tự sửa
  baseUrl trong Settings). `kimi-k3` là flagship (1M context, vision);
  họ `moonshot-v1-*` và `kimi-k2.5` đã gỡ ngày 2026-08-31.
- **Qwen**: endpoint quốc tế `dashscope-intl`; tài khoản Bắc Kinh dùng
  `https://dashscope.aliyuncs.com/compatible-mode/v1` (key theo vùng).
- **Mistral**: họ `magistral-*` đã deprecated — không có trong danh
  sách. API xử lý dữ liệu ở EU theo mặc định.
- **Groq**: free tier giới hạn theo model (RPM/RPD/TPM/TPD) và
  catalogue xoay thường xuyên — `listModels()` live là nguồn đúng
  nhất. Groq từ chối vài tham số OpenAI (`logprobs`, `logit_bias`,
  `n` khác 1) mà transport này không bao giờ gửi.
- **Together**: 200+ model open-weight, id dạng `<org>/<model>`.
- **Cohere**: dùng Compatibility API (`api.cohere.ai`, không phải
  `.com`); chỉ `reasoning_effort` `none`/`high` được hỗ trợ. Key trial
  giới hạn 1.000 calls/tháng, chỉ để đánh giá.
- **Vision**: cả 7 provider kế thừa `supportsVision() → true` của
  `OpenAICompatibleProvider` (giống xAI/OpenAI hiện tại) — độ chính
  xác theo từng model (vd `command-a-vision-07-2025` có vision,
  `command-a-03-2025` không) chưa được phân biệt; nếu API trả lỗi vì
  `image_url`, turn đó fail với lỗi provider rõ ràng chứ không im lặng.

## 2. Tool mới

Đăng ký trong coordinator (`defaultToolFactory`, guarded như
memory/A2A factories). Registry: 187 → **196 tool** (5 new git workflow tools — `git_blame` already existed in codeTools.ts and was extended with a line range instead of being duplicated — + 1 deep file search + 3 browser automation).

### Git workflow — `packages/tools/src/gitWorkflowTools.ts` (6 tool)

`git_log`, `git_branch` (list), `git_branch_create`,
`git_branch_delete`, `git_show` (commit hoặc staged diff),
`git_blame`. Chạy git CLI qua `runShell` sandboxed trong workspace;
mọi ref (branch/revision/start point) validate bằng regex chặt
(không `..`, không `-` đầu, không shell metacharacter, không `@{`);
đường dẫn file confined bằng `resolveWithin`. Đọc không cần duyệt;
tạo/xóa branch cần duyệt. `git_status` / `git_diff` / `git_commit`
đã có trong `tools.ts` và `set_active_branch` (checkout) trong
`gitTools.ts` — không trùng.

### File search sâu — `packages/tools/src/fileSearchTools.ts` (1 tool)

`search_files_deep`: tìm nội dung/regex (so với `grep_search` cũ:
thêm glob include/exclude, context lines 0–5, whole-word, hỗ trợ
`.gitignore`, giới hạn `max_results`/`max_files` và **time budget**
mặc định 10s — hết giờ trả kết quả partial thay vì treo turn).
Bỏ qua `.git`, `node_modules`, file binary, file > 1 MB. Read-only.

### Browser automation mở rộng — `packages/tools/src/browserAutomation.ts` (+3 tool)

`browser_status` (URL/title hiện tại, không bao giờ launch browser),
`browser_reload` (vào lại URL hiện tại, cần duyệt),
`browser_wait_for` (poll tới khi selector xuất hiện và/hoặc text có
trong trang, timeout tối đa 60s). Dùng chung session Chromium với 5
tool cũ. `BrowserPageDriver.innerText` thêm tham số `timeout` tùy
chọn để mỗi lần poll không ăn hết budget. 5 → **8 browser tool**.

## 3. i18n

+7 key `settings.provider.*` / locale (1930 key/locale, 6/6):
DeepSeek, Moonshot (Kimi), Qwen (Alibaba), Mistral, Groq,
Together AI, Cohere — tên thương hiệu giữ nguyên mọi locale.

## 4. Kiểm thử

Mock-only, không gọi API thật, không cần key:

- `tests/providers-v097.test.mjs` — hằng số từng provider (base URL /
  default model / known models), chat POST đúng URL + Bearer key +
  model qua fetch giả, `listModels()` fallback khi `/models` lỗi,
  `PROVIDERS` meta, `createProvider` dispatch, preset moonshot/cohere
  + sửa default deepseek, model registry có đủ 7 provider.
- `tests/git-workflow-v097.test.mjs` — repo fixture thật (git init +
  commit trong tmpdir): log/branch/create/delete/show/blame, ref xấu
  bị từ chối, đường dẫn ngoài workspace bị chặn, repo không phải git
  báo lỗi rõ.
- `tests/file-search-v097.test.mjs` — literal/regex/whole-word,
  include/exclude glob, `.gitignore`, context lines, max_results,
  timeout (partial results), binary skip.
- `tests/browser-automation-v097.test.mjs` — fake driver: status khi
  chưa mở / đã mở, reload, wait_for (selector có ngay / text xuất
  hiện sau / timeout), không launch browser cho status.

Chạy: build core + tools rồi `node --test tests/providers-v097.test.mjs
tests/git-workflow-v097.test.mjs tests/file-search-v097.test.mjs
tests/browser-automation-v097.test.mjs`.
