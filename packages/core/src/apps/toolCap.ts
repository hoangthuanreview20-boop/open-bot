/**
 * Giới hạn số tool của connector (M7) — cap theo từng app.
 *
 * Vấn đề: một app kiểu Composio có thể expose hàng chục tool; gửi
 * hết cho model mỗi turn thì tốn context (v0.29 đo 123 tool ≈
 * 16.929 token, lọc còn 20 defs ≈ 3.241 token). Cap này là LỚP
 * RIÊNG cho app: mỗi app chỉ được expose tối đa N tool trong 1
 * turn, theo thứ tự catalog (tool đầu catalog giữ trước — thứ tự
 * ổn định, không xáo trộn).
 *
 * Tái dùng cơ chế đã có, không viết cơ chế thứ hai: cap chạy TRƯỚC
 * `filterTools` (agent/toolFilter.ts — allowlist/skill/mode). Thứ
 * tự: cap theo app -> filterTools (bot policy/skill/mode). Cap
 * không thay filterTools và không bị filterTools thay thế.
 */

import { defaultAppRegistry } from './catalog';

/**
 * Cap mặc định: 10 tool/app/turn. Đủ cho mọi app hiện có (nhiều
 * nhất 3 tool: Slack) và chặn app tương lai expose hàng chục tool
 * trong một lần. Host/bot có thể ghi đè theo từng app qua
 * SharedAppAuthStore.setToolCap() hoặc applyAppToolCaps().
 */
export const DEFAULT_APP_TOOL_CAP = 10;

/** Kết quả cap: tool còn lại + tool bị cắt (để UI/log báo rõ). */
export interface CappedTools<T extends { definition: { name: string } }> {
  tools: T[];
  /** Tên tool bị cap cắt bớt (theo thứ tự catalog). */
  droppedToolNames: string[];
}

/**
 * Cắt danh sách tool của MỘT app xuống tối đa `cap` tool, giữ đúng
 * thứ tự đầu vào (đầu vào đã theo thứ tự catalog thì đầu ra giữ
 * nguyên thứ tự đó). Cap <= 0 coi như 0 (cắt hết, fail-closed);
 * cap không phải số nguyên thì làm tròn xuống.
 */
export function capAppTools<T extends { definition: { name: string } }>(
  tools: T[],
  cap: number,
): CappedTools<T> {
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  if (tools.length <= limit) return { tools: [...tools], droppedToolNames: [] };
  return {
    tools: tools.slice(0, limit),
    droppedToolNames: tools.slice(limit).map((t) => t.definition.name),
  };
}

/** Một app bị cap cắt bớt trong applyAppToolCaps. */
export interface AppCapReport {
  appId: string;
  cap: number;
  exposedCount: number;
  droppedToolNames: string[];
}

/**
 * Áp cap cho TOÀN BỘ tool list theo từng app: tool thuộc app nào
 * thì chịu cap của app đó (mặc định DEFAULT_APP_TOOL_CAP, ghi đè
 * qua `capsByApp`); tool không thuộc app nào giữ nguyên (tool nội
 * bộ của bot không phải app bên ngoài). Thứ tự tool giữ nguyên.
 * Trả thêm báo cáo app nào bị cắt để loop/UI log rõ.
 */
export function applyAppToolCaps<T extends { definition: { name: string } }>(
  tools: T[],
  capsByApp: Record<string, number> = {},
  registry: { appIdForTool(toolName: string): string | undefined } = defaultAppRegistry,
): { tools: T[]; capped: AppCapReport[] } {
  // Đếm theo app để cắt đúng "N tool đầu tiên của app đó".
  const seenByApp = new Map<string, number>();
  const kept: T[] = [];
  const droppedByApp = new Map<string, string[]>();
  for (const tool of tools) {
    const appId = registry.appIdForTool(tool.definition.name);
    if (appId === undefined) {
      kept.push(tool);
      continue;
    }
    const cap = capsByApp[appId] ?? DEFAULT_APP_TOOL_CAP;
    const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
    const seen = seenByApp.get(appId) ?? 0;
    if (seen < limit) {
      kept.push(tool);
      seenByApp.set(appId, seen + 1);
    } else {
      const dropped = droppedByApp.get(appId) ?? [];
      dropped.push(tool.definition.name);
      droppedByApp.set(appId, dropped);
    }
  }
  const capped: AppCapReport[] = [...droppedByApp.entries()].map(([appId, droppedToolNames]) => ({
    appId,
    cap: capsByApp[appId] ?? DEFAULT_APP_TOOL_CAP,
    exposedCount: kept.filter((t) => registry.appIdForTool(t.definition.name) === appId).length,
    droppedToolNames,
  }));
  return { tools: kept, capped };
}
