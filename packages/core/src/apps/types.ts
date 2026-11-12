/**
 * Connected apps (M7) — kiểu chung.
 *
 * Một "app" là một dịch vụ bên ngoài mà bot có thể dùng qua tool
 * (Slack, Gmail, Teams, iMessage, meeting, ...). Catalog chỉ là DỮ
 * LIỆU + hàm thuần: mỗi app khai báo id, tên, mô tả, cách xác thực,
 * và danh sách tool nó cung cấp (tên tool phải khớp tool thật trong
 * packages/tools/src/integrationTools.ts — catalog không tạo tool
 * mới, chỉ trỏ tới tool đã có).
 *
 * Không có tích hợp Composio thật ở đây (phương án (b) cần key/dịch
 * vụ ngoài, để sau). Lớp này tự làm trên MCP/connector đã có
 * (phương án (a)): token OAuth lưu MỘT lần trong Vault, mọi bot
 * dùng chung qua SharedAppAuthStore (xem authStore.ts).
 *
 * v0.57: app Composio (xem packages/core/src/composio/) cũng khai báo
 * bằng AppDefinition này — `authType: 'composio'`, `source: 'composio'`,
 * không có connectorId (token OAuth của app nằm phía Composio, key
 * project của user nằm trong Vault 'provider:composio').
 *
 * v0.68b: app GitHub dùng `authType: 'token'` — user tự tạo personal
 * access token (PAT) rồi dán vào UI; token lưu nguyên chuỗi trong Vault
 * (`vaultNamespace`/`vaultKey`, vd 'github'/'token'), không qua OAuth
 * flow, không cần ConnectorDefinition. Quyết định này thay cho việc tạo
 * connector OAuth GitHub mới: PAT là chuẩn GitHub cho dùng cá nhân,
 * không cần đăng ký OAuth app; trade-off là user phải tự tạo PAT trên
 * github.com (UI + docs ghi rõ đường dẫn).
 */

/** Cách app xác thực: OAuth2 (token trong Vault) / không cần (chạy local) / qua Composio (managed OAuth phía Composio) / token PAT dán tay (token thô trong Vault). */
export type AppAuthType = 'oauth2' | 'none' | 'composio' | 'token';

/** Nguồn cung cấp app: local (M7 tự làm) hay Composio (adapter v0.57). */
export type AppSource = 'local' | 'composio';

/**
 * Trạng thái xác thực của một app, tính từ TokenSet đã lưu (không
 * bao giờ chứa giá trị token):
 *  - 'not_connected': chưa có token nào trong Vault.
 *  - 'connected': có token còn hạn (hoặc token không hạn + có/không
 *    có refresh token — framework tự refresh khi dùng, xem
 *    connectors/framework.ts getValidAccessToken).
 *  - 'expired': token đã hết hạn và KHÔNG có refresh token để tự
 *    làm mới — user phải kết nối lại.
 *  - 'error': token đã lưu hỏng định dạng, hoặc lần refresh/lấy
 *    token gần nhất thất bại (xem SharedAppAuthStore.markError).
 *  - 'local': app không cần xác thực (chạy local, vd iMessage draft,
 *    meeting import) — luôn dùng được.
 */
export type AppAuthStatus =
  | 'not_connected'
  | 'connected'
  | 'expired'
  | 'error'
  | 'local';

/** Một tool mà app cung cấp — chỉ trỏ tên, không chứa logic tool. */
export interface AppToolRef {
  /** Tên tool thật, vd 'slack_send' (khớp integrationTools.ts). */
  name: string;
  /** Mô tả ngắn cho UI (danh sách tool thu gọn). */
  description: string;
  /** Tool có cần approval trước khi chạy không (khớp Tool.needsApproval). */
  needsApproval: boolean;
}

/** Khai báo một app trong catalog. */
export interface AppDefinition {
  /** Id ổn định, vd 'slack'. Khớp /^[A-Za-z0-9][A-Za-z0-9._-]*$/. */
  id: string;
  /** Tên hiển thị, vd 'Slack'. */
  label: string;
  /** Mô tả ngắn cho UI. */
  description: string;
  /** Biểu tượng hiển thị (một ký tự/emoji ngắn, không phải asset ngoài). */
  icon: string;
  /** Cách xác thực của app. */
  authType: AppAuthType;
  /**
   * Id connector OAuth tương ứng trong connectors/framework.ts
   * (vd 'slack', 'gmail', 'teams'). Chỉ có khi authType='oauth2'.
   * Token lưu trong Vault namespace 'connector', key = connector id.
   */
  connectorId?: string;
  /**
   * v0.68b: vị trí token PAT trong Vault — chỉ có khi authType='token'.
   * Token lưu nguyên chuỗi (không phải TokenSet JSON), vd GitHub:
   * `vaultNamespace: 'github'`, `vaultKey: 'token'`. Trạng thái app
   * chỉ kiểm tra sự tồn tại của secret này, không gọi API ngoài và
   * không bao giờ lộ giá trị token.
   */
  vaultNamespace?: string;
  /** Key Vault của token PAT (đi cùng vaultNamespace, chỉ khi authType='token'). */
  vaultKey?: string;
  /**
   * Nguồn cung cấp app (v0.57). Mặc định 'local' khi không ghi —
   * app built-in M7 và app đăng ký tay đều là local. App Composio
   * ghi 'composio' để UI ghi rõ nhãn "via Composio" + cảnh báo token
   * nằm phía Composio.
   */
  source?: AppSource;
  /**
   * Toolkit slug Composio (vd 'gmail') — chỉ có khi source='composio'.
   * Dùng để bật/tắt từng toolkit và đưa vào Tool Router session.
   */
  toolkit?: string;
  /** Tool mà app cung cấp (tên phải khớp tool thật). */
  tools: AppToolRef[];
}

/**
 * Trạng thái đầy đủ của một app để UI/API hiển thị — không chứa
 * token, chỉ chứa nhãn tài khoản (display name/email) khi biết.
 */
export interface AppStatusView {
  /** Khai báo app (id/label/description/icon/authType/tools). */
  app: AppDefinition;
  /** Trạng thái xác thực hiện tại. */
  authStatus: AppAuthStatus;
  /** Nhãn tài khoản đã kết nối (vd tên/email), undefined khi chưa có. */
  accountLabel?: string;
  /**
   * v0.70: chi tiết trạng thái — vd token GitHub không còn hiệu lực +
   * hướng dẫn dán lại PAT mới, hoặc lý do chưa kiểm tra được (lỗi
   * mạng/timeout/rate-limit) khi trạng thái cũ được giữ lại. Không bao
   * giờ chứa token. Chỉ có khi trạng thái cần giải thích thêm.
   */
  authStatusDetail?: string;
  /** Số tool tối đa của app được expose cho model trong 1 turn (cap). */
  toolCap: number;
  /** Số tool của app đang được expose (sau khi áp cap). */
  exposedToolCount: number;
  /** Tên tool bị cap cắt bớt trong turn hiện tại (rỗng khi không cắt). */
  cappedOutToolNames: string[];
}
