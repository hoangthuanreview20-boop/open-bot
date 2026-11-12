# Đánh giá Composio — phương án (b) cho lớp connected apps (chỉ nghiên cứu, KHÔNG tích hợp)

- **Ngày:** 2026-11-09 (đánh giá gốc); **cập nhật 2026-11-09 20:xx — TRẠNG THÁI MỚI:
  ĐANG TÍCH HỢP TỐI THIỂU (v0.57).** Huy đã phê duyệt tích hợp Composio
  ngày 2026-11-09 20:09 — bỏ giới hạn "chỉ nghiên cứu" của tài liệu này.
  Tiến độ v0.57 xem `docs/composio-integration.md` (core + catalog 4
  toolkit + mock test xong; live test thật + nối IPC main chưa làm).
  Phần dưới đây giữ nguyên làm hồ sơ đánh giá/so sánh/chi phí/rủi ro;
  riêng §5 mục 2 đã cập nhật lại tình trạng sau sự cố 05/2026 từ nguồn
  chính thức (xem "Cập nhật 2026-11-09" trong mục đó).
- **Nguồn chính:** trang pricing chính thức của Composio (đọc trực tiếp ngày 2026-11-09),
  blog/docs chính thức của Composio, `docs/research-openmausbot.md` §7 (Composio qua
  OpenMausBot), `docs/mcp-sdk-evaluation.md` (đối chiếu MCP), và code M7 thật
  (`packages/core/src/apps/`, `apps/desktop/src/renderer/components/SettingsView.tsx`).
  Giá và tính năng lấy theo trang chính thức; số liệu bên thứ ba chỉ dùng khi ghi rõ nguồn.

## 1. Composio là gì

Composio là một **nền tảng tích hợp app cho AI agent** (“action infrastructure”): thay vì
mỗi agent tự viết wrapper cho từng API (Gmail, Slack, GitHub, Notion, Linear…), Composio
cung cấp sẵn catalog toolkit + OAuth được quản lý + thực thi tool qua một đầu mối duy
nhất, và agent gọi tool qua MCP hoặc SDK.

Các khối chính (theo docs/blog chính thức, đọc 2026-11-09):

- **Catalog toolkit:** trang pricing chính thức ghi **1.500+ toolkit**; các bài so sánh
  bên thứ ba ghi 1.600+ toolkit / 20.000+ tool (con số khác nhau theo cách đếm — lấy
  1.500+ của trang chính thức làm mốc). OpenMausBot dùng Composio cho “500+ app”.
- **Managed OAuth:** user xác thực một lần qua Composio (Connect Link); Composio giữ
  token, tự refresh; agent không bao giờ cầm token. Có thể dùng OAuth app của mình
  (own app) hoặc app do Composio quản lý (managed app — dùng chung giới hạn của provider).
- **Tool Router (GA):** tạo MCP session URL theo từng user (presigned), chỉ lộ các tool
  liên quan tới task qua meta-tool tìm kiếm (`COMPOSIO_SEARCH_TOOLS` → xác thực →
  `COMPOSIO_MULTI_EXECUTE_TOOL`) thay vì nhồi hàng nghìn tool definition vào context.
  Đây chính là lời giải cho bài toán tool-filter mà open-bot đã tự giải ở v0.10/v0.29.
- **MCP servers theo toolkit:** tạo MCP server riêng cho từng app (vd chỉ Gmail), chỉ
  expose đúng tool đã chọn — qua Streamable HTTP, một URL duy nhất thay cho một server
  process mỗi app.
- **Triggers:** webhook/polling theo sự kiện app (vd email mới, tin Slack) — tương đương
  phần trigger của automations open-bot, nhưng chạy phía Composio.
- **Proxy Execute:** gọi endpoint bất kỳ của app đã kết nối mà không cần cầm token —
  Composio gắn credential phía server rồi trả response về.
- **SDK mã nguồn mở (MIT):** repo `ComposioHQ/composio`, ~29.700 GitHub stars (tháng
  8/2026, theo nguồn bên thứ ba). SDK mở không đồng nghĩa dịch vụ mở: catalog, OAuth
 托管 và thực thi chạy trên cloud của Composio.
- **Bảo mật theo công bố:** SOC 2 Type II + ISO 27001; token mã hoá AES-256-GCM envelope
  encryption, key trong AWS KMS; API key của Composio chỉ lưu hash; execution runtime
  chỉ giải mã credential trong lúc gọi rồi không giữ lại; log thực thi mặc định chứa
  **đầy đủ request/response payload và giữ tới 1 năm** (xem §5 — điểm này quan trọng
  với local-first); có self-hosted và customer-managed KMS ở tier Enterprise.
- **Sự cố bảo mật tháng 5/2026 (do chính Composio công bố):** kẻ tấn công truy cập hệ
  thống nội bộ và xâm phạm credential khách hàng — khoảng 0,3% connection đang hoạt
  động, trong đó có 5.001 connection GitHub; kẻ tấn công còn đăng ký tool definition
  độc hại để leo thang quyền. Composio đã công bố tái cấu trúc (envelope encryption,
  hash API key, Proxy Execute, customer-managed KMS, IP allowlist, AppSecure
  verification) trong bài viết tháng 9/2026. Ghi nhận ở đây vì nó trực tiếp liên quan
  tới quyết định có giao token Gmail/Slack của user cho bên thứ ba hay không — xem §5.

## 2. So sánh: M7 tự làm trên MCP (phương án (a), đã xong ở v0.49) vs Composio (phương án (b))

| Tiêu chí | (a) M7 tự làm trên MCP — đã có | (b) Composio |
|---|---|---|
| Catalog app | **5 app thật**: Slack (3 tool), Gmail (2), Teams (2), iMessage (1 nháp), Meeting (2). Thêm app = `registerApp()` trong `catalog.ts`, không sửa core | **1.500+ toolkit** có sẵn, không cần viết tool. Lợi thế lớn nhất và gần như duy nhất về số lượng |
| OAuth một lần, chia sẻ mọi bot | ✅ Có — `SharedAppAuthStore` bọc Vault, token trong Vault mã hoá local, revoke thì mọi bot mất quyền ngay | ✅ Có — managed OAuth + refresh tự động; nhưng token nằm trên cloud Composio, không nằm trong Vault của user |
| Trạng thái auth rõ ràng | ✅ Có — chưa kết nối / đã kết nối / hết hạn / lỗi / local + nhãn tài khoản, UI trong Settings | ✅ Có — dashboard + API trạng thái connection; nhưng trạng thái “hết hạn” phía Composio chỉ biết khi gọi thử, tương tự giới hạn M7 đã ghi ở v0.49 |
| Giới hạn tool/turn (chống tràn context) | ✅ Cap 10 tool/app/turn (`toolCap.ts`), chạy trước `filterTools` — **nhưng chưa nối vào turn chạy thật** (ghi chú v0.49: việc tiếp theo) | ✅ Tool Router chỉ lộ tool liên quan qua meta-tool search — giải pháp mạnh hơn, đã chạy production |
| Triggers (sự kiện app → automation) | ⚠️ Automations có cron/event nội bộ; trigger từ app ngoài (email mới…) chưa có | ✅ 50K trigger event/tháng miễn phí, polling + realtime |
| Tool discovery theo task | ⚠️ Tool-filter tĩnh + gom nhóm (v0.10, v0.29: 123 tool → 20 defs) | ✅ Tool Router search động theo task |
| Chi phí biên | **$0** — không phí dịch vụ, chỉ phí model provider của user | $0 tới 100K call/tháng, sau đó $0,0003/call (xem §3); managed app đắt hơn |
| Chạy offline / local-first | ✅ Hoàn toàn local (trừ API của chính app đó, vd Slack API) | ❌ Mọi tool call đi qua `backend.composio.dev` — mất mạng hoặc Composio down là app ngoài chết theo |
| Credential custody | ✅ Token trong Vault local, mã hoá, chế độ `NO_STORAGE`; user tự thu hồi ở provider | ⚠️ Token trên Composio Cloud (AES-256-GCM + KMS; Enterprise mới có customer-managed KMS/self-hosted). Đã từng bị xâm phạm tháng 5/2026 |
| Data egress / log | ✅ Dữ liệu chỉ đi tới provider của app đó; log local | ⚠️ Mọi payload tool call đi qua Composio; log mặc định giữ full payload tới 1 năm; ZDR là add-on trả phí |
| Độ trễ | Trực tiếp tới provider | Thêm 1 hop qua Composio (đáng kể với tool gọi nhiều lần/turn) |
| Bảo trì | Team open-bot tự viết + duy trì từng app (chi phí tuyến tính theo số app) | Composio duy trì 1.500+ toolkit; open-bot chỉ duy trì 1 adapter |
| Lock-in | Không — tool là code của mình, MCP chuẩn mở | Cao — tên tool (`GMAIL_FETCH_EMAILS`…), session URL, auth config, trigger đều là khái niệm Composio; đổi nhà cung cấp = viết lại lớp app |
| Rủi ro pháp lý/tuân thủ | Thấp — dữ liệu ở máy user | Trung bình — DPA tự phục vụ có sẵn; BAA, ZDR, IP allowlist là add-on; Composio Cloud chạy ở Mỹ, EU residency chỉ qua self-hosted Enterprise |
| Phù hợp team/user | User cá nhân local-first, 5–20 app | Sản phẩm đa user cần 100+ app ngay, chấp nhận cloud |

Kết luận so sánh: **(a) thắng ở local-first, custody, chi phí, độ trễ, lock-in; (b) thắng
ở đúng một thứ — độ rộng catalog và công sức duy trì.** Tool Router của Composio là
kiến trúc đáng học (meta-tool search thay vì nhồi defs), nhưng M7 đã có thiết kế tương
đương ở mức nhỏ (registry + cap + filter) và có thể học ý tưởng này mà không cần
Composio.

## 3. Chi phí (đọc trực tiếp từ trang pricing chính thức ngày 2026-11-09)

> Nguồn: https://composio.dev/pricing (đọc 2026-11-09). Giá có thể đổi — kiểm tra lại
> trang này trước khi quyết định ngân sách. Các con số bên thứ ba (1.600+ toolkit,
> $29 Pro…) khớp với trang chính thức ở mức làm tròn; chỗ nào khác nhau thì lấy trang
> chính thức.

| Hạng mục | Hobby (miễn phí) | Pro | Enterprise |
|---|---|---|---|
| Giá nền | **$0**, không cần thẻ | **$29/tháng**, gồm $29 usage credit (hết tháng không cộng dồn) | Giá riêng, cam kết volume |
| Tool call (own app / API key / MCP) | 100.000/tháng miễn phí | Sau đó $0,0003/call | Theo cam kết |
| Trigger event | 50.000/tháng miễn phí | Sau đó $0,003/event | Theo cam kết |
| Connected accounts (own OAuth app / API key / MCP) | Không giới hạn, miễn phí | Không giới hạn, miễn phí | Theo cam kết |
| Team members | 3 | Không giới hạn | — |
| Hard cap (chống bill bất ngờ) | **Có — dừng ở giới hạn, không thu thêm** | Tính overage trừ khi đặt spend cap | — |
| Managed apps (dùng OAuth app của Composio) | 20.000 call miễn phí (tổng mọi managed app), sau đó **dừng** | 20.000 miễn phí, sau đó tính theo app: $0,0005 / $0,002 / $0,01 mỗi call tuỳ app; Google Maps tính từ call đầu | Giá riêng |
| Managed-app connected accounts | 1.000 đầu miễn phí | 1.000 miễn phí, sau đó $0,10/account một lần | — |
| Sandbox LLM tokens | 1M/tháng miễn phí | Sau đó $3,75/1M | — |
| Add-on đáng chú ý | Proxy Execute 1K/tháng miễn phí; Direct execution 10K; Sandbox execution 10K | Proxy Execute +$0,0002/call; ZDR (zero data retention) +$0,0001/call; IP allowlist +$0,0001/call; BAA +$0,0003/call | Gồm các mục trên |
| Audit log | 30 ngày gần nhất | Đầy đủ hơn | Đầy đủ |
| Hỗ trợ | Portal | Portal + Email (+ Slack ở mức $1K) | Riêng + SLA |

Ví dụ tính (own-app calls, chưa gồm phí model và phí của chính app đó như Slack/Gmail):

- **50.000 call/tháng → $0** (trong free tier Hobby).
- **200.000 call/tháng → ~$30/tháng ở Pro**: 100K miễn phí + 100K × $0,0003 = $30,
  trừ $29 credit → $1 overage + $29 phí nền = $30.
- **1.000.000 call/tháng → ~$270/tháng ở Pro**: 900K × $0,0003 = $270, trừ $29 credit
  → $241 overage + $29 phí nền = $270.
- **Dùng managed app** (không tự đăng ký OAuth app): chỉ 20K call miễn phí rồi tính
  $0,0005–$0,01/call tuỳ app — một user nặng Gmail/Slack qua managed app có thể tốn
  gấp 3–30 lần so với own-app. Muốn rẻ phải tự đăng ký OAuth app với Google/Slack
  (thêm việc setup cho user).

Lưu ý: giá trên chỉ là phí Composio. App được kết nối (Slack, Gmail…) vẫn có
subscription/quota riêng, và model provider (Gemini/OpenAI…) vẫn tính riêng.

## 4. Kế hoạch tích hợp NẾU sau này Huy phê duyệt (chưa làm, chỉ kế hoạch)

Nguyên tắc: Composio là **một nguồn app nữa cắm sau `AppRegistry` của M7**, không phải
lớp thay thế. M7 đã thiết kế đúng chỗ để cắm (b): `registerApp()` + `SharedAppAuthStore`
+ `applyAppToolCaps` + UI Connected apps. Kế hoạch 5 giai đoạn, mỗi giai đoạn dừng được
độc lập và rollback được (tắt adapter là M7 chạy lại như cũ):

**Giai đoạn 0 — Cổng quyết định (trước mọi code).** Huy phê duyệt bằng văn bản: (i) chấp
nhận token user nằm trên Composio Cloud (hoặc chọn Enterprise/KMS — xem §5); (ii) chấp
nhận phí theo §3 cho user cuối (ai trả: Huy/product hay user tự mang Composio key?);
(iii) danh sách app ưu tiên (không tích hợp cả 1.500 toolkit một lúc). Không có 3 điểm
này thì không bắt đầu.

**Giai đoạn 1 — Adapter phía core (~1.000–1.500 dòng nguồn, ước lượng).**
`packages/core/src/apps/composio/` mới: `ComposioAppSource` implement cùng interface
`AppRegistry` (đăng ký app động từ catalog Composio thay vì hard-code 5 app); map tên
tool Composio (`GMAIL_FETCH_EMAILS`) về tên tool nội bộ; map trạng thái auth Composio
(connected/expired/error) về `deriveAppAuthStatus()` đã có; tái dùng `toolCap.ts`
(cap 10 tool/app/turn) + `filterTools` — không viết cơ chế lọc thứ hai. API key của
Composio (project key) lưu trong Vault như provider key khác, **không bao giờ** lưu
token OAuth của user (token nằm phía Composio). Feature flag `apps.composio.enabled`
mặc định TẮT, bật theo từng user (opt-in).

**Giai đoạn 2 — Transport MCP (tái dùng MCP client đã có).** Composio expose tool qua
MCP Streamable HTTP (session URL theo user) — nối qua `packages/core/src/mcp/client.ts`
đã có (v0.9/v0.13, spec 2025-11-25), không viết client mới. Một MCP server Composio
được mount như một MCP server thường trong marketplace, nhưng có nhãn “via Composio”
và cơ chế refresh session URL khi hết hạn. Tool Router meta-tools
(`COMPOSIO_SEARCH_TOOLS`…) được map thành một tool điều phối nội bộ, tương tự cách
`groupTools` gom nhóm ở v0.10 — để model search tool động thay vì nạp hết defs.

**Giai đoạn 3 — UI (renderer).** Màn Connected apps (hiện là 1 section trong Settings —
xem `docs/ui-parity-review.md` §3.6, nên tách ra màn riêng trước hoặc cùng lúc):
thêm nguồn “Composio” với trạng thái bật/tắt, nút Connect mở Composio Connect Link
(OAuth trong trình duyệt hệ thống, không nhập password trong app), danh sách app đã kết
nối + tool/cap, đồng hồ đo usage (số call tháng này, còn bao nhiêu free tier) để user
không bị bill bất ngờ, nút Disconnect thu hồi ngay (gọi API Composio + xoá session URL
local). Hiển thị rõ nhãn “token lưu tại Composio, không lưu trên máy này”.

**Giai đoạn 4 — Guardrails + egress.** Thêm `backend.composio.dev` vào egress allowlist
(`docs/egress-policy.md`) **chỉ khi** flag Composio bật; spend cap cấu hình được (vd
dừng gọi Composio khi vượt N call/tháng — nối với usage meter ở giai đoạn 3); mọi tool
call qua Composio vẫn đi qua approval levels + denylist + guardrails như tool nội bộ;
audit log ghi rõ tool call nào đi qua Composio (để user kiểm tra). Kill-switch: tắt flag
là mọi app Composio báo unavailable kèm lý do, M7 local không ảnh hưởng.

**Giai đoạn 5 — Kiểm chứng trước khi mở cho user.** OAuth một app thật (Gmail hoặc
Slack) rồi 2 bot cùng dùng được; revoke phía Composio thì cả hai báo unavailable; vượt
free tier thì meter + cap chặn đúng; tắt mạng tới Composio thì app local vẫn chạy, chỉ
app Composio báo lỗi rõ ràng; đo độ trễ thêm 1 hop; full suite xanh dưới xvfb + smoke
Electron thật qua CDP. Ước lượng tổng: ~2.500–4.000 dòng nguồn + ~1.500 dòng test
(so sánh: M7 làm 744 dòng nguồn vì tái dùng OAuth/Vault/tool đã có; Composio adapter
nặng hơn ở mapping tool + session + UI meter). Chưa gồm thời gian xin OAuth app riêng
cho các app phổ biến (nếu chọn own-app để tránh phí managed-app).

## 5. Rủi ro (xếp theo mức độ)

1. **Credential custody — rủi ro lớn nhất.** Token OAuth/API key của user (Gmail,
   Slack, GitHub…) sẽ nằm trên Composio Cloud, không còn trong Vault local của open-bot.
   Điều này đi ngược lại điểm bán cốt lõi “local-first, secret không rời máy” và chế độ
   `NO_STORAGE` của Vault. Giảm nhẹ một phần: Composio mã hoá AES-256-GCM + KMS, token
   không trả về cho app/LLM; nhưng “không trả về” ≠ “không nằm trên server họ”. Chỉ
   Enterprise mới có customer-managed KMS (Composio không giữ key giải mã) hoặc
   self-hosted.
2. **Tiền lệ xâm phạm tháng 5/2026.** Chính Composio công bố: kẻ tấn công vào hệ thống
   nội bộ, xâm phạm ~0,3% connection (5.001 connection GitHub) và đăng ký tool definition
   độc hại để leo thang quyền. Họ đã tái cấu trúc sau đó (xem §1), nhưng một nền tảng
   từng để lộ credential tập trung là rủi ro không thể bỏ qua khi cân nhắc giao toàn bộ
   token app của user. Cần đọc kỹ bài remediation + trust center trước mọi quyết định,
   và không dùng Composio cho tài khoản chứa dữ liệu nhạy cảm cho tới khi Huy chấp nhận
   rủi ro này bằng văn bản.
   - **Cập nhật 2026-11-09 (kiểm tra lại từ trang chính thức của Composio):**
     bài "How Composio rebuilt credential security after May 2026" (đăng
     21/10/2026) + "May 2026 security incident update" (cập nhật 16/09/2026).
     Ngoài ~0,3% connection (5.001 GitHub), Composio xác định thêm **5.241
     Composio API key có thể đã lộ** (mục lộ khác với connection — không
     gộp thành một con số); toàn bộ API key tạo trước 23:00 PST ngày
     22/05/2026 đã bị xoá, buộc user tạo key mới. Kẻ tấn công còn dùng
     token Gmail OAuth của nhân viên để vào hệ thống phụ qua magic-link
     sign-in. 6 thay đổi khắc phục: envelope encryption (AES-256-GCM +
     KMS), API key chỉ lưu hash, Proxy Execute (API không còn trả token/
     secret OAuth), customer-managed KMS, IP allowlist, AppSecure
     verification (mọi finding critical/high đã sửa + re-verify; đây là
     kết quả có phạm vi — không có nghĩa mọi lỗ hổng đã hết). IntrusionOps
     làm incident response; Latacora review AWS/GitHub — **một số item
     còn đang làm** ("remaining items in progress", theo cập nhật
     16/09/2026). Customer-managed KMS là triển khai tuỳ chọn, cần làm
     việc với team Composio, KHÔNG phải mặc định; mặc định Cloud thì
     runtime vẫn giải mã credential lúc gọi. SOC 2 Type II qua Trust
     Center. Kết luận cho v0.57 không đổi: rủi ro custody tập trung vẫn
     còn nguyên về mặt kiến trúc; tích hợp tối thiểu đi kèm opt-in mặc
     định tắt + chỉ dùng cho tài khoản không nhạy cảm trước + giữ đường
     local M7 (xem `docs/composio-integration.md` §9).
3. **Data egress + log mặc định.** Mọi payload tool call (nội dung email, tin nhắn
   Slack, file…) đi qua server Composio; log mặc định giữ full request/response tới
   1 năm. ZDR (không giữ dữ liệu) là add-on trả phí (+$0,0001/call) và chỉ “select
   features”. Với user Việt Nam dùng Gmail/Slack công việc, đây là vấn đề riêng tư thực
   sự, không phải lý thuyết.
4. **Vendor lock-in.** Tên tool, session URL, auth config, trigger, usage meter đều là
   khái niệm Composio. Đổi sang Nango/Arcade/tự làm = viết lại lớp app. Giảm nhẹ: giữ
   adapter sau `AppRegistry` (giai đoạn 1) để ngày rời đi chỉ cần viết adapter mới,
   không sửa agent loop.
5. **Phụ thuộc dịch vụ ngoài + giá đổi.** Composio down / đổi pricing (đã đổi lớn tháng
   8/2026 cho tài khoản mới) thì app ngoài của user chết hoặc đắt lên mà open-bot không
   kiểm soát được. Managed-app cap 20K call rồi dừng có thể làm user tưởng “app hỏng”
   trong khi thực ra là hết free tier. Giảm nhẹ: hard cap + meter + thông báo rõ ràng
   (giai đoạn 3–4); luôn giữ đường local M7 cho 5 app cốt lõi.
6. **Phí ẩn cho user cuối.** Ai trả phí Composio chưa rõ: nếu product trả thì Huy gánh
   phí theo usage của mọi user (1M call = ~$270/tháng, xem §3); nếu user tự mang key thì
   mỗi user phải tự đăng ký Composio + tự đăng ký OAuth app để tránh phí managed-app —
   trải nghiệm onboarding tệ đi rất nhiều so với “OAuth một lần trong app” của M7.
7. **Tuân thủ / residency.** Composio Cloud chạy ở Mỹ; EU residency chỉ qua self-hosted
   Enterprise. Không có thông tin công khai về residency châu Á. User doanh nghiệp cần
   DPA/BAA phải mua add-on/Enterprise.

## 6. Khuyến nghị

> **Cập nhật 2026-11-09:** khuyến nghị "KHÔNG tích hợp bây giờ" dưới đây
> đã bị quyết định mới của Huy (20:09 ngày 09/11 — "Tích hợp Composio")
> thay thế. Giữ nguyên nội dung gốc làm hồ sơ lý do ban đầu; tiến độ
> tích hợp tối thiểu theo quyết định mới xem `docs/composio-integration.md`
> (v0.57). Các điều kiện xem lại (catalog tay vượt ~20 app…) không còn là
> cổng chặn nữa, nhưng các cảnh báo rủi ro trong §5 vẫn giữ nguyên giá trị
> và được áp dụng vào thiết kế v0.57 (opt-in mặc định tắt, tài khoản không
> nhạy cảm trước, giữ đường local M7).

**KHÔNG tích hợp Composio bây giờ. Giữ phương án (a) M7, mở rộng nó bằng tay, và chỉ
xem lại (b) khi một trong các điều kiện sau xảy ra.**

Lý do:

- Nhu cầu thực chưa tới: catalog M7 mới có 5 app; user chưa hề yêu cầu app thứ 6. Lợi
  thế duy nhất của Composio là độ rộng catalog — mua 1.500 toolkit khi mới cần 5 là
  trả giá lock-in + custody + egress cho thứ chưa dùng tới.
- M7 đã chứng minh lớp thống nhất làm được trên MCP với 744 dòng nguồn; thêm app mới
  chỉ tốn một entry `registerApp()` + tool đã có. Chi phí biên của (a) là công viết
  tool, không phải phí dịch vụ — và công đó đã được trả phần lớn ở v0.49.
- Rủi ro lớn nhất (custody + tiền lệ tháng 5/2026 + log full payload 1 năm) đụng trực
  diện với cam kết local-first của open-bot. Đây không phải rủi ro kỹ thuật sửa được
  bằng code adapter; nó chỉ hết khi dùng Enterprise/KMS/self-hosted — tức là khi trả
  tiền lớn.
- Free tier tuy hào phóng (100K call/tháng) nhưng là “free” của phía Composio; phí thật
  là kiến trúc: mọi app call rời khỏi máy user.

**Làm thay vào đó (theo thứ tự):**

1. Nối cap tool M7 vào turn chạy thật (việc tiếp theo đã ghi ở v0.49) — không có nó thì
   so sánh (a)/(b) về “chống tràn context” vẫn là lý thuyết.
2. Mở rộng catalog M7 bằng tay lên 10–15 app theo nhu cầu thật (ứng viên: Notion,
   GitHub, Google Calendar, Google Drive, Linear — toàn app có MCP server hoặc API
   ổn định, viết một lần dùng mãi).
3. Học ý tưởng Tool Router (meta-tool search động) vào `toolFilter` của mình — lấy
   kiến trúc, không lấy dịch vụ.
4. Xem lại Composio khi: (i) user yêu cầu app ngoài catalog liên tục; (ii) catalog tay
   vượt ~20 app và chi phí duy trì lớn hơn phí Composio; (iii) có ngân sách cho
   Enterprise/customer-managed KMS; hoặc (iv) Huy ra lệnh rõ ràng muốn 500+ app ngay.
   Khi đó làm theo kế hoạch §4, bắt đầu từ Giai đoạn 0 (cổng quyết định), và pilot chỉ
   với 1–2 app không nhạy cảm (vd GitHub public) trước khi đụng tới Gmail/Slack.

## 7. Nguồn đã tra cứu (ngày 2026-11-09)

- Trang pricing chính thức (đọc trực tiếp): https://composio.dev/pricing — Hobby $0 /
  100K call / 50K trigger / 3 members, hard-capped; Pro $29 gồm $29 credit; overage
  $0,0003/call; managed app 20K free rồi tính theo app; add-on Proxy Execute/ZDR/IP
  allowlist/BAA.
- Blog bảo mật chính thức: https://composio.dev/blog/two-questions-every-security-review-asks-us
  — AES-256-GCM envelope encryption, KMS, token không trả về cho app/LLM, log mặc định
  giữ full payload tới 1 năm, customer-managed KMS, self-hosted, Cloud chạy ở Mỹ.
- Blog sự cố: https://composio.dev/content/how-composio-rebuilt-credential-security-after-may-2026
  — sự cố tháng 5/2026, ~0,3% connection (5.001 GitHub), tool definition độc hại, 6 thay
  đổi tái cấu trúc.
- Trang Enterprise: https://composio.dev/enterprise — SOC 2 Type II, self-hosted,
  customer-managed keys, DPA/BAA.
- Hướng dẫn MCP: https://composio.dev/content/connect-ai-to-apps-with-mcp và
  https://composio.dev/content/how-mcp-works — một URL MCP duy nhất, Tool Router,
  managed OAuth, refresh nền.
- `docs/research-openmausbot.md` §7 + §M7 (repo nội bộ) — Composio qua OpenMausBot:
  `server/composio.ts` 1.091 dòng + `composio-*` + `shared/connector-*`, curated
  connector, `CONNECTOR_ALLOWED_TOOLS_ENV` + giới hạn byte.
- `docs/mcp-sdk-evaluation.md` (repo nội bộ) — đối chiếu MCP client tự viết vs SDK chính
  thức; kết luận “đánh giá, không migrate” vẫn đúng cho hướng Composio: Composio là
  MCP server từ xa, client tay đã đủ để nối, không cần đổi SDK.
- Code M7 thật: `packages/core/src/apps/` (catalog 5 app, authStore, toolCap),
  `apps/desktop/src/renderer/components/SettingsView.tsx` (section Connected apps),
  mục v0.49 trong `docs/BEYOND-ROADMAP.md` (giới hạn đã biết: cap chưa nối turn thật,
  OAuth thật chưa kiểm chứng, trạng thái `expired` chỉ theo `expiresAt`).

*Ghi chú tuân thủ lệnh: không đăng ký tài khoản Composio, không nhập credential/key ở
bất kỳ đâu, không tích hợp code. Tài liệu này chỉ là nghiên cứu + kế hoạch.*
