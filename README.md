# open-bot

## Tiếng Việt

**open-bot** là một agent AI luôn bật (always-on), local-first, chạy hoàn toàn trên máy cá nhân của bạn.

Lấy cảm hứng từ ý tưởng về một trợ lý AI luôn sẵn sàng giúp việc — nhưng khác ở chỗ open-bot **không cần model riêng, không cần backend cloud**. Bạn dùng API key của chính mình với bất kỳ provider nào bạn thích (OpenAI, Anthropic, Gemini, xAI Grok, Ollama local, ...), và mọi dữ liệu đều ở lại trên máy của bạn.

Tầm nhìn dài hạn: open-bot không dừng ở một app desktop đơn lẻ mà lớn lên thành một **platform** — hệ tool mở rộng không giới hạn qua plugin/MCP marketplace, **đa ngôn ngữ đầy đủ** (tiếng Việt + tiếng Anh từ đầu), **siêu mạnh mẽ** khi nhiều bot chạy song song — nhưng vẫn local-first.

### Tính năng chính

- **Agent AI luôn bật:** chạy nền trên máy, sẵn sàng nhận nhiệm vụ bất cứ lúc nào.
- **Local-first:** dữ liệu, lịch sử trò chuyện và bộ nhớ (memory) lưu local bằng SQLite — không gửi lên server của chúng tôi (vì không có server nào cả).
- **Hỗ trợ mọi provider qua API key:** đổi provider/model chỉ bằng cách đổi cấu hình, không cần cài lại hay đăng ký dịch vụ mới.
- **Không cần model riêng:** dùng model của provider bạn đã có key; hoặc chạy model local qua Ollama (đã kiểm chứng end-to-end với qwen2.5:0.5b local, xem docs/TESTING.md).
- **48 tool an toàn (v0.2):** file/code (glob, grep, diff, blame, diagnostics), shell, web/X search, git, plan/task/goal/todo/project, subagent, MCP — chạy trong sandbox qua một ToolRegistry, mọi hành động nhạy cảm đều cần bạn phê duyệt trước khi thực thi. Agent có thể hỏi lại bạn giữa chừng (ask_user) và giao việc cho agent con.
- **MCP client:** gọi tool/resource của MCP server (stdio + streamable HTTP) qua file cấu hình `.open-bot/mcp.json` của workspace.
- **Đa ngôn ngữ:** giao diện tiếng Việt + tiếng Anh đầy đủ, đổi trong Settings; thêm ngôn ngữ mới chỉ cần thêm một file locale.
- **Ứng dụng desktop:** giao diện Electron, chạy trên Windows / macOS / Linux.

### Cài đặt & chạy

Yêu cầu: Node.js 20+ và npm.

```bash
npm install
npm run dev
```

Xem hướng dẫn chi tiết trong [docs/SETUP.md](docs/SETUP.md).

### Cấu hình API key

1. Lấy API key từ provider bạn muốn dùng (xem [docs/SETUP.md](docs/SETUP.md)).
2. Tạo file `.env` ở thư mục gốc (xem `.env.example` nếu có) hoặc nhập key trong giao diện Settings của app.
3. Chọn provider và model mặc định, rồi bắt đầu trò chuyện.

API key chỉ được dùng để gọi trực tiếp tới provider bạn chọn.

### Lưu ý bảo mật

- **API key chỉ lưu local** trên máy của bạn (file `.env` hoặc kho lưu trữ an toàn của hệ điều hành). Không bao giờ commit file `.env` lên git — file này đã có trong `.gitignore`.
- Không chia sẻ API key của bạn cho người khác. Nếu key bị lộ, hãy thu hồi (revoke) ngay trên trang của provider và tạo key mới.
- Agent chỉ thực thi hành động nhạy cảm (ghi/xóa file, chạy lệnh, gửi request mạng, ...) sau khi bạn phê duyệt.
- open-bot không thu thập, không gửi dữ liệu của bạn đi đâu ngoài provider AI mà bạn tự chọn.

### Kiến trúc

Xem [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Giấy phép

MIT — xem [LICENSE](LICENSE).

### Tuyên bố

Dự án này được **viết mới hoàn toàn từ đầu**. open-bot không copy code, không sử dụng tài sản (assets), thương hiệu hay dữ liệu nào của xAI / Grok. Mọi tên gọi "Grok" trong tài liệu chỉ dùng để chỉ provider xAI Grok như một lựa chọn provider qua API công khai của họ, tương tự như OpenAI hay Anthropic.

---

## English

**open-bot** is an always-on, local-first AI agent that runs entirely on your own computer.

It is inspired by the idea of an AI assistant that is always ready to help — except open-bot **needs no model of its own and no cloud backend**. You bring your own API key for any provider you like (OpenAI, Anthropic, Gemini, xAI Grok, local Ollama, ...), and all your data stays on your machine.

Long-term vision: open-bot grows beyond a single desktop app into a **platform** — an unbounded tool system via a plugin/MCP marketplace, **fully multilingual** (Vietnamese + English from the start), and **high-performance** with many bots running in parallel — while staying local-first.

### Key features

- **Always-on AI agent:** runs in the background on your machine, ready whenever you need it.
- **Local-first:** data, chat history and memory are stored locally in SQLite — nothing is sent to our servers (there are none).
- **Any provider via API key:** switch provider/model by changing configuration, no reinstall or new subscription needed.
- **No own model required:** use a provider model you already have a key for, or run a local model via Ollama.
- **Safe tools:** the agent can run commands, read/write files, search the web, ... inside a sandbox, and every sensitive action requires your approval before it runs.
- **Desktop app:** Electron UI, runs on Windows / macOS / Linux.

### Install & run

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

See [docs/SETUP.md](docs/SETUP.md) for details.

### Configuring API keys

1. Get an API key from the provider you want to use (see [docs/SETUP.md](docs/SETUP.md)).
2. Create a `.env` file at the project root (see `.env.example` if present) or enter the key in the app's Settings UI.
3. Pick your default provider and model, then start chatting.

API keys are only used to call the provider you choose, directly from your machine.

### Security notes

- **API keys are stored locally only** on your machine (`.env` file or the OS secure storage). Never commit `.env` to git — it is already in `.gitignore`.
- Do not share your API keys with anyone. If a key leaks, revoke it immediately on the provider's site and create a new one.
- The agent only performs sensitive actions (writing/deleting files, running commands, making network requests, ...) after you approve them.
- open-bot does not collect or send your data anywhere except to the AI provider you choose yourself.

### Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### License

MIT — see [LICENSE](LICENSE).

### Disclaimer

This project is **written entirely from scratch**. open-bot does not copy code, assets, trademarks or data from xAI / Grok. Any mention of "Grok" in the docs only refers to xAI Grok as one provider option via their public API, just like OpenAI or Anthropic.
