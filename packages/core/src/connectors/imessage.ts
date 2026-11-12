/**
 * iMessage connector (v0.7) — CHỈ SOẠN NHÁP, KHÔNG BAO GIỜ TỰ GỬI.
 *
 * ROADMAP §2c: "Tích hợp iMessage (soạn/gửi nháp)".
 *
 * Giới hạn thật (ghi rõ, không giả vờ):
 *  - iMessage KHÔNG có API công khai. Không có endpoint nào để gửi
 *    iMessage từ server hay từ app bên thứ ba.
 *  - Chỉ chạy trên máy Apple: trên macOS, tool mở cửa sổ soạn tin của
 *    app Messages với người nhận + nội dung đã điền sẵn (URL scheme
 *    `sms:` qua lệnh `open`) — người dùng tự bấm Gửi. Tool KHÔNG gọi
 *    AppleScript `send` (lệnh đó sẽ gửi thật) và KHÔNG BAO GIỜ báo
 *    "đã gửi".
 *  - Trên Linux/Windows (kể cả máy dev hiện tại): không có app
 *    Messages — tool ghi file nháp
 *    `.open-bot/imessage-drafts/<id>.txt` (người nhận + nội dung) và
 *    trả hướng dẫn mở trên máy Apple. Kết quả luôn ghi rõ
 *    `sent: false`.
 *
 * Vì vậy tool tên là `imessage_draft`, không phải `imessage_send`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const IMESSAGE_DRAFTS_REL_DIR = path.join('.open-bot', 'imessage-drafts');

export type ImessageDraftMethod = 'macos-messages-compose' | 'file';

export interface ImessageDraft {
  /** Id nháp (tên file khi ghi file). */
  id: string;
  to: string;
  /** Luôn false: tool này không bao giờ gửi. */
  sent: false;
  method: ImessageDraftMethod;
  /** Đường dẫn file nháp (chỉ khi method = 'file'). */
  path?: string;
  note: string;
}

export interface DraftImessageOptions {
  to: string;
  body: string;
  /** Workspace chứa thư mục nháp (khi ghi file). */
  workspaceDir: string;
  /** Ghi đè platform để test (mặc định process.platform). */
  platform?: NodeJS.Platform;
}

/**
 * Soạn nháp iMessage. Không bao giờ gửi.
 *  - macOS: mở app Messages ở cửa sổ soạn tin (người nhận + nội dung
 *    điền sẵn); nếu `open` thất bại thì rơi về ghi file nháp.
 *  - Linux/Windows: ghi file nháp `.open-bot/imessage-drafts/<id>.txt`.
 */
export function draftImessage(opts: DraftImessageOptions): ImessageDraft {
  if (!opts.to) throw new Error('iMessage recipient ("to") is required.');
  if (!opts.body) throw new Error('iMessage body must not be empty.');
  const id = randomUUID();
  const platform = opts.platform ?? process.platform;

  if (platform === 'darwin') {
    // URL scheme sms: mở cửa sổ soạn tin, KHÔNG gửi. `open` chỉ mở app.
    const url = `sms:${encodeURIComponent(opts.to)}&body=${encodeURIComponent(opts.body)}`;
    const result = spawnSync('open', [url], { encoding: 'utf8' });
    if (result.status === 0) {
      return {
        id,
        to: opts.to,
        sent: false,
        method: 'macos-messages-compose',
        note:
          'Đã mở cửa sổ soạn tin trong app Messages (người nhận + nội dung đã điền sẵn). ' +
          'Bạn tự bấm Gửi — open-bot KHÔNG tự gửi iMessage.',
      };
    }
    // `open` thất bại (vd. không có app Messages) — rơi về ghi file.
  }

  const dir = path.join(opts.workspaceDir, IMESSAGE_DRAFTS_REL_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.txt`);
  const content = [
    `To: ${opts.to}`,
    `Drafted: ${new Date().toISOString()}`,
    '',
    opts.body,
    '',
    '---',
    'Nháp iMessage — CHƯA GỬI. Mở file này trên máy Apple và gửi bằng app Messages.',
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    id,
    to: opts.to,
    sent: false,
    method: 'file',
    path: filePath,
    note:
      platform === 'darwin'
        ? 'Không mở được app Messages nên đã ghi file nháp. Mở file trên máy Apple và gửi bằng app Messages — open-bot KHÔNG tự gửi iMessage.'
        : 'iMessage chỉ chạy trên máy Apple nên đã ghi file nháp. Mở file này trên máy Apple và gửi bằng app Messages — open-bot KHÔNG tự gửi iMessage.',
  };
}
