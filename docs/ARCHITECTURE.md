# Kiến trúc open-bot

## Tổng quan

open-bot là một ứng dụng desktop (Electron) chạy hoàn toàn trên máy người dùng — **local-first, không có backend cloud**. Người dùng mang API key của mình, app gọi trực tiếp tới provider AI mà họ chọn.

```
┌─────────────────────────────────────────────────────────────┐
│  apps/desktop (Electron)                                    │
│  ┌──────────────┐   IPC    ┌────────────────────────────┐  │
│  │ Renderer     │ ◄──────► │ Main process               │  │
│  │ (UI: chat,   │          │ - AgentRunner              │  │
│  │  settings,   │          │ - Quản lý cửa sổ / tray    │  │
│  │  approvals)  │          │ - Lưu API key (local)      │  │
│  └──────────────┘          └──────┬─────────────┬─────────┘  │
└──────────────────────────────────┼─────────────┼────────────┘
                                   │             │
                    ┌──────────────▼──┐  ┌──────▼─────────────┐
                    │ packages/core   │  │ packages/tools     │
                    │ - Agent loop    │  │ - Sandbox          │
                    │ - Provider      │  │ - Tools: shell,    │
                    │   abstraction   │  │   file, web, ...   │
                    │ - Memory SQLite │  │                    │
                    └──────┬──────────┘  └────────────────────┘
                           │
                    ┌──────▼──────────┐
                    │ Provider AI     │  (OpenAI / Anthropic /
                    │ (qua API key    │   Gemini / xAI Grok /
                    │  của người dùng)│   Ollama local, ...)
                    └─────────────────┘
```

## Các thành phần

### 1. `apps/desktop` — Electron app

- **Main process:** điểm vào của ứng dụng. Khởi tạo và sở hữu `AgentRunner`, quản lý cửa sổ, tray icon (chạy nền, luôn bật), và lưu trữ API key an toàn trên máy (OS keychain / file local, không gửi đi đâu khác).
- **Renderer process:** giao diện người dùng — khung chat, danh sách nhiệm vụ, màn hình Settings (chọn provider/model, nhập API key), và màn hình phê duyệt (approval).
- **IPC:** renderer và main trao đổi qua IPC với các kênh hẹp, có kiểm chứng (validated channel). Renderer không bao giờ cầm trực tiếp API key hay gọi thẳng provider.

### 2. `packages/core` — lõi agent

- **Agent loop:** nhận nhiệm vụ từ người dùng → gọi provider → nhận về tool call / text → thực thi tool (qua `packages/tools`) → đưa kết quả trở lại provider → lặp lại cho tới khi hoàn thành → trả lời người dùng.
- **Provider abstraction:** một interface chung (`Provider`) cho mọi nhà cung cấp. Mỗi provider (OpenAI, Anthropic, Gemini, xAI Grok, Ollama...) chỉ là một adapter triển khai interface này: cùng cách gửi messages, nhận streaming, gọi tool. Nhờ đó đổi provider/model không cần sửa agent loop.
- **Memory (SQLite):** lịch sử trò chuyện, ghi nhớ dài hạn và trạng thái nhiệm vụ lưu trong file SQLite local trên máy người dùng. Không có dữ liệu nào rời khỏi máy ngoài request tới provider mà người dùng đã chọn.

### 3. `packages/tools` — sandbox & tools

- **Sandbox:** mọi tool chạy trong môi trường giới hạn — giới hạn thư mục được phép truy cập, giới hạn lệnh shell, timeout, giới hạn tài nguyên. Tool không được chạy tùy ý ngoài sandbox.
- **Tools:** shell, đọc/ghi file, tìm kiếm web, ... Mỗi tool khai báo rõ schema đầu vào, mô tả, và mức độ rủi ro của nó.

## Luồng phê duyệt cho hành động nhạy cảm

Không phải hành động nào agent cũng được tự chạy. Các hành động nhạy cảm — ghi/sửa/xóa file, chạy lệnh shell, gửi request mạng, cài đặt phần mềm, truy cập dữ liệu ngoài thư mục làm việc — đều phải qua phê duyệt:

1. Agent đề xuất một tool call nhạy cảm → agent loop tạm dừng.
2. Main process gửi yêu cầu phê duyệt sang renderer, hiển thị đầy đủ: tool nào, tham số nào, tác động gì.
3. Người dùng **Cho phép / Từ chối** (có thể cho phép một lần, hoặc cho phép luôn cho loại hành động đó trong phiên).
4. Chỉ khi được phép, tool mới chạy trong sandbox; kết quả trả lại agent loop để tiếp tục.
5. Mọi lần phê duyệt / từ chối đều được ghi log local để người dùng kiểm tra lại.

Hành động chỉ đọc (đọc file trong thư mục làm việc, tra cứu memory) mặc định được phép; danh sách này có thể siết chặt trong Settings.

## Dữ liệu lưu local

| Dữ liệu | Vị trí | Ghi chú |
|---|---|---|
| API key | OS keychain / file `.env` local | Không commit, không gửi đi đâu ngoài provider đã chọn |
| Lịch sử chat, memory | SQLite local (`*.sqlite`, đã ignore khỏi git) | Chỉ đọc/ghi trên máy người dùng |
| Cấu hình app | Thư mục app data local | Provider/model mặc định, chính sách phê duyệt |
| Log | File log local | Có thể xóa bất cứ lúc nào |

Không có tài khoản người dùng, không có server trung tâm, không có telemetry mặc định. Request mạng duy nhất ra ngoài máy là request tới provider AI mà người dùng tự cấu hình (và các tool web mà người dùng phê duyệt, ví dụ tìm kiếm web).

## Nguyên tắc thiết kế

- **Local-first:** mất mạng tới provider thì app vẫn mở được, vẫn xem được lịch sử; chỉ không gọi được model mới.
- **Bring your own key:** open-bot không sở hữu model, không bán credit, không làm trung gian thu phí.
- **An toàn mặc định:** hành động nhạy cảm cần phê duyệt; sandbox giới hạn phạm vi tool.
- **Đổi provider dễ dàng:** thêm provider mới = thêm một adapter, không sửa agent loop hay UI chat.
