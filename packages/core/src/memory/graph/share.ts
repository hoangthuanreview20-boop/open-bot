/**
 * Memory share giữa các bot — đồ thị của bot này cho bot khác đọc
 * (v0.98, Đội T1).
 *
 * Mô hình share (khớp với memory blocks v0.96: attach theo botId):
 *  - Bot nguồn (owner) ghi `shares[targetBotId] = { readOnly }` vào
 *    chính file đồ thị của nó (store.share()).
 *  - Bot đích mở đồ thị nguồn qua `openSharedGraph()` — store đó ở
 *    chế độ readOnly khi share.readOnly = true: mọi ghi (ingest,
 *    addFact, quarantine-review, ...) đều throw GraphStoreError.
 *  - Search/share-read LUÔN lọc theo scope của bot nguồn (fact của
 *    bot nguồn), không lẫn scope bot đích — vì đồ thị nguồn chỉ chứa
 *    fact scope nguồn.
 *  - Thu hồi: owner gọi `unshare()` — bot đích mở lại sẽ bị từ chối
 *    (share đã mất).
 *
 * Host (main.ts / coordinator) cung cấp `resolveWorkspace(botId)` để
 * map botId → thư mục workspace. Không có resolver thì chỉ share
 * trong cùng workspace (dùng cho test).
 */

import * as path from 'node:path';
import { TemporalGraphStore } from './store';
import { MEMORY_GRAPH_REL_PATH, FileGraphBackend } from './store';
import type { GraphShare } from './types';

export interface ShareResolver {
  /** Map botId → thư mục workspace (throw khi không tìm thấy bot). */
  resolveWorkspace(botId: string): string;
}

export interface OpenSharedGraphResult {
  store: TemporalGraphStore;
  share: GraphShare;
  sourceBotId: string;
}

/**
 * Mở đồ thị của bot nguồn để bot đích đọc. Throw khi:
 *  - bot nguồn chưa từng share cho bot đích,
 *  - bot nguồn không có workspace / chưa có file đồ thị.
 */
export function openSharedGraph(
  sourceBotId: string,
  targetBotId: string,
  resolver: ShareResolver,
): OpenSharedGraphResult {
  const sourceDir = resolver.resolveWorkspace(sourceBotId);
  const sourceStore = new TemporalGraphStore(
    new FileGraphBackend(path.join(sourceDir, MEMORY_GRAPH_REL_PATH)),
  );
  const share = sourceStore.getShare(targetBotId);
  if (!share) {
    throw new Error(`Bot ${sourceBotId} chưa share đồ thị cho bot ${targetBotId}.`);
  }
  const store = new TemporalGraphStore(
    new FileGraphBackend(path.join(sourceDir, MEMORY_GRAPH_REL_PATH)),
    { readOnly: share.readOnly },
  );
  return { store, share, sourceBotId };
}

/** Liệt kê các bot đang được share từ store của bot nguồn. */
export function listGraphShares(store: TemporalGraphStore): GraphShare[] {
  return store.listShares();
}

/**
 * Kiểm tra một bot đích có quyền đọc đồ thị nguồn không (không mở
 * file đích — chỉ đọc cấu hình share của nguồn).
 */
export function canReadSharedGraph(sourceStore: TemporalGraphStore, targetBotId: string): boolean {
  return sourceStore.getShare(targetBotId) !== undefined;
}

/**
 * Kiểm tra quyền ghi: chỉ khi share tồn tại VÀ readOnly = false.
 * Share read-only thì bot đích chỉ search/xem, không consolidate
 * vào đồ thị nguồn.
 */
export function canWriteSharedGraph(sourceStore: TemporalGraphStore, targetBotId: string): boolean {
  const share = sourceStore.getShare(targetBotId);
  return share !== undefined && share.readOnly === false;
}
