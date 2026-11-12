/**
 * Adapter: nối MCP client thật vào transport tối thiểu mà module tasks /
 * prompts cần (v0.13, integration).
 *
 * `tasks.ts` và `prompts.ts` cố tình không import `client.ts` (tránh
 * cycle) — chúng chỉ cần `{ request(method, params) }`. File này là
 * cầu nối duy nhất, dùng `requestJsonRpc` public của client:
 *
 *   const transport = clientAsTaskTransport(client);
 *   const handle = await createTask(transport, { method: 'tools/call', ... });
 *
 *   const rpc = clientAsRpcTransport(client);
 *   const prompts = await listPrompts(rpc);
 *   const watcher = new ResourceWatcher(rpc, ...); // nhận notification qua onNotification
 *
 * Notification (`notifications/resources/updated`, `.../list_changed`,
 * `notifications/prompts/list_changed`, `notifications/tools/list_changed`)
 * đi qua dispatcher của client: adapter đăng ký MỘT handler fan-out cho
 * mỗi method, rồi chia cho mọi listener đã đăng ký qua `onNotification`.
 * Client không có dispatcher thì `onNotification` throw rõ ràng thay vì
 * lặng lẽ không hoạt động (ResourceWatcher cần biết).
 */
import type { McpClient, McpRequestOptions } from './types';
import type { McpTaskTransport } from './tasks';
import type { McpRpcTransport } from './prompts';

function requireRequestJsonRpc(client: McpClient): NonNullable<McpClient['requestJsonRpc']> {
  const fn = client.requestJsonRpc;
  if (typeof fn !== 'function') {
    throw new Error(
      'MCP client này không có requestJsonRpc — không nối được tasks/prompts adapter.',
    );
  }
  return fn.bind(client);
}

/** Nối client thật thành transport cho module tasks (`tasks/*`). */
export function clientAsTaskTransport(client: McpClient): McpTaskTransport {
  const requestJsonRpc = requireRequestJsonRpc(client);
  return {
    request: (method: string, params?: Record<string, unknown>) =>
      requestJsonRpc(method, params),
  };
}

/** Notification method mà adapter fan-out từ dispatcher tới listener. */
export const MCP_ADAPTER_NOTIFICATION_METHODS: readonly string[] = [
  'notifications/resources/updated',
  'notifications/resources/list_changed',
  'notifications/prompts/list_changed',
  'notifications/tools/list_changed',
];

/**
 * Nối client thật thành transport cho module prompts/resources/completion.
 * `options` (timeout / signal / progress) được chuyển thẳng xuống
 * `requestJsonRpc` cho mọi request.
 */
export function clientAsRpcTransport(
  client: McpClient,
  options?: McpRequestOptions,
): McpRpcTransport {
  const requestJsonRpc = requireRequestJsonRpc(client);
  const listeners = new Set<(method: string, params: unknown) => void>();
  let fanoutRegistered = false;

  const ensureFanout = (): void => {
    if (fanoutRegistered) return;
    const dispatcher = client.getDispatcher?.();
    if (!dispatcher) {
      throw new Error(
        'MCP client này không có dispatcher — không nhận được notification ' +
          '(resources/prompts/tools list_changed). Dùng StdioMcpClient / StreamableHttpMcpClient.',
      );
    }
    fanoutRegistered = true;
    for (const method of MCP_ADAPTER_NOTIFICATION_METHODS) {
      dispatcher.register(method, (params, ctx) => {
        for (const listener of [...listeners]) {
          try {
            listener(ctx.method, params);
          } catch {
            // Một listener lỗi không được làm chết fan-out.
          }
        }
      });
    }
  };

  return {
    request: (method: string, params?: Record<string, unknown>) =>
      requestJsonRpc(method, params, options),
    onNotification: (handler: (method: string, params: unknown) => void) => {
      ensureFanout();
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}
