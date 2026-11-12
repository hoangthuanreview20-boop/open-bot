/**
 * Store lịch sử sampling dùng chung giữa các handler của cùng một bot
 * (v0.24 W17d, `includeContext: 'allServers'` thật).
 *
 * Vấn đề W16b để lại: lịch sử sampling chỉ nằm trong closure của từng
 * handler instance, nên `'allServers'` phải fallback về lịch sử
 * thisServer — server B không bao giờ thấy lịch sử server A. Store này
 * là chỗ chứa chung: coordinator tạo MỘT store cho mỗi bot lúc
 * `createBot` (xem `BotEntry.samplingContextStore`) và tiêm vào mọi
 * `createSamplingHandler` của bot đó (đường pool `getSamplingHandler`
 * lẫn đường system `callSystemToolFor`); handler nào sampling xong
 * thành công cũng append lượt của mình vào store, handler nào xin
 * `'allServers'` cũng đọc toàn bộ lịch sử trong store.
 *
 * Không có biến global/module: store là một object tạo bằng
 * `createSamplingContextStore()`, caller giữ nó — hai bot khác nhau có
 * hai store khác nhau nên lịch sử không rò sang bot khác. Caller không
 * truyền store thì handler giữ hành vi cũ (fallback thisServer).
 *
 * Giới hạn: lịch sử trong store chịu CÙNG ngưỡng như lịch sử thisServer
 * (`SAMPLING_HISTORY_MAX_MESSAGES` / `SAMPLING_HISTORY_MAX_TOKENS`
 * trong `clientHandlers.ts`: tối đa 20 message, tổng ước lượng
 * ≤ 2048 token theo `estimateTokens`). Store cắt ngay lúc append
 * (giữ 20 message gần nhất rồi cắt message cũ nhất tới khi vừa ngân
 * sách token) nên store không phình vô hạn; handler khi đọc vẫn cắt
 * lại bằng `trimSamplingHistory` như với lịch sử riêng.
 */
import type { ChatMessage } from '../types';
import { estimateTokens } from '../agent/tokens';

/**
 * Ngưỡng lịch sử của store — giữ đồng bộ với
 * `SAMPLING_HISTORY_MAX_MESSAGES` / `SAMPLING_HISTORY_MAX_TOKENS`
 * trong `clientHandlers.ts` (cùng 20 message / 2048 token ước lượng).
 */
export const SAMPLING_CONTEXT_MAX_MESSAGES = 20;
export const SAMPLING_CONTEXT_MAX_TOKENS = 2048;

/**
 * Store lịch sử sampling dùng chung của một bot. Lịch sử được ghi theo
 * từng server (`serverName` — vd `'system'` cho đường system, tên
 * server MCP cho đường pool) nhưng đọc `'allServers'` thì lấy toàn bộ
 * các server theo đúng thứ tự thời gian các lượt sampling diễn ra.
 */
export interface SamplingContextStore {
  /**
   * Lịch sử sampling của riêng một server (bản sao mới — sửa mảng trả
   * về không ảnh hưởng store).
   */
  getHistory(serverName: string): ChatMessage[];
  /**
   * Lịch sử sampling của TẤT CẢ server của bot, theo thứ tự thời gian
   * (bản sao mới). Đây là cái handler đọc khi
   * `includeContext === 'allServers'`.
   */
  getAllHistory(): ChatMessage[];
  /**
   * Thêm messages MỚI của một lượt sampling vào lịch sử của server đó.
   * Caller chỉ append messages mới của lượt này (messages của request
   * + text trả về cuối), KHÔNG append lại phần lịch sử đã đọc — nếu
   * không mỗi lần đọc-ghi sẽ nhân đôi lịch sử. Sau khi append, store
   * tự cắt về vừa ngưỡng (20 message / 2048 token ước lượng).
   */
  append(serverName: string, messages: ChatMessage[]): void;
  /** Xoá toàn bộ lịch sử (coordinator gọi lúc `destroyBot`/`shutdown`). */
  clear(): void;
}

/** Một entry trong log lịch sử chung (giữ thứ tự thời gian giữa các server). */
interface SamplingContextEntry {
  serverName: string;
  message: ChatMessage;
}

/**
 * Tạo một store lịch sử sampling rỗng. Store chỉ giữ dữ liệu trong bộ
 * nhớ của chính object này — không global, không file, không chia sẻ
 * ngầm giữa các bot.
 */
export function createSamplingContextStore(): SamplingContextStore {
  let entries: SamplingContextEntry[] = [];

  const trim = (): void => {
    entries = entries.slice(-SAMPLING_CONTEXT_MAX_MESSAGES);
    while (
      entries.length > 0 &&
      entries.reduce((sum, e) => sum + estimateTokens(e.message.content), 0) >
        SAMPLING_CONTEXT_MAX_TOKENS
    ) {
      entries = entries.slice(1);
    }
  };

  return {
    getHistory(serverName: string): ChatMessage[] {
      return entries
        .filter((e) => e.serverName === serverName)
        .map((e) => ({ ...e.message }));
    },
    getAllHistory(): ChatMessage[] {
      return entries.map((e) => ({ ...e.message }));
    },
    append(serverName: string, messages: ChatMessage[]): void {
      if (typeof serverName !== 'string' || !serverName.trim()) return;
      if (!Array.isArray(messages) || messages.length === 0) return;
      const name = serverName.trim();
      for (const message of messages) {
        entries.push({ serverName: name, message: { ...message } });
      }
      trim();
    },
    clear(): void {
      entries = [];
    },
  };
}
