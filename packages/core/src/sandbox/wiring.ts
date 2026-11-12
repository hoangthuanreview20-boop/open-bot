/**
 * Nối box vào session box + harness M5 + local-exec-daemon (M6).
 *
 * Giữ thay đổi ở các module cũ ở mức TỐI THIỂU: file này chỉ DÙNG API
 * public sẵn có của chúng, không sửa code của chúng.
 *
 *  - Harness M5: box KHÔNG đăng ký instance riêng trong registry
 *    (registry đã có 1 instance/bot cho provider CLI — đăng ký thêm
 *    cùng botId sẽ throw chống trùng). Box chỉ publish event lifecycle
 *    (`box_created` / `box_reset` / `box_run` / `box_destroyed`) lên
 *    bus + NDJSON log của harness, dùng instanceId của bot nếu đã có,
 *    nếu chưa thì `box:<botId>`.
 *  - Session box: box của bot đặt dưới workspace của session
 *    (`<sessionWorkspace>/boxes/<botId>/`) qua `attachBoxToSession`.
 *  - Local-exec-daemon: core KHÔNG import tools (tránh cycle
 *    core→tools). `boxDaemonExecRequest()` trả về object đúng shape
 *    `ExecRequest` của daemon (command/args/cwd/env/timeoutMs/
 *    workspaceDir/egressPolicy) — caller (desktop main / tool
 *    shell_exec) đưa object này vào `DaemonClient.exec()`. Daemon
 *    spawn lệnh trong box khi cwd + workspaceDir trỏ vào box.
 *  - Vault: secret chỉ qua `vaultSecrets` (caller lấy từ Vault) —
 *    xem `buildBoxEnv` trong env.ts; file này không đọc Vault trực tiếp.
 */

import { getSession } from '../session/box';
import type { LocalHarness } from '../harness/index';
import type { EgressPolicy } from '../egress/types';
import type { BotBox } from './types';
import { BotBoxManager } from './box';
import { buildBoxEnv } from './env';

export type BoxLifecycleAction = 'box_created' | 'box_reset' | 'box_run' | 'box_destroyed';

/**
 * Publish một event lifecycle của box lên bus + NDJSON log của harness.
 * Payload chỉ có nhãn (không secret, không đường dẫn nhạy cảm).
 */
export function publishBoxLifecycle(
  harness: LocalHarness,
  box: BotBox,
  action: BoxLifecycleAction,
  opts: { engine?: string; runIsolation?: string; exitCode?: number | null } = {},
): void {
  const engine = opts.engine ?? 'box';
  const instanceId =
    harness.registry.getByBotId(box.botId)?.instanceId ?? `box:${box.botId}`;
  const at = new Date().toISOString();
  const payload: Record<string, unknown> = {
    action,
    boxId: box.id,
    isolation: box.isolation,
    ...(opts.runIsolation !== undefined ? { runIsolation: opts.runIsolation } : {}),
    ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
  };
  try {
    harness.bus.publish({
      instanceId,
      botId: box.botId,
      threadId: box.botId,
      engine,
      kind: 'lifecycle',
      payload,
      at,
    });
    harness.log?.append({ at, botId: box.botId, threadId: box.botId, kind: 'lifecycle', payload });
    const instance = harness.registry.getByBotId(box.botId);
    if (instance) harness.registry.touch(instance.instanceId);
  } catch {
    // Publish lifecycle không bao giờ làm hỏng box.
  }
}

/**
 * Tạo (hoặc lấy lại) box của bot đặt dưới workspace của một session
 * box hiện có. Dùng khi turn chạy trong session: box là "phòng làm
 * việc" của bot trong session đó.
 */
export function attachBoxToSession(
  workspaceDir: string,
  sessionId: string,
  botId: string,
  opts: Parameters<BotBoxManager['createBox']>[1] = {},
): BotBox {
  const session = getSession(workspaceDir, sessionId);
  const manager = new BotBoxManager({ rootDir: session.workspaceDir });
  return manager.createBox(botId, opts);
}

/**
 * Shape `ExecRequest` của local-exec-daemon (mirror, không import
 * tools để tránh cycle core→tools). Caller đưa object này vào
 * `DaemonClient.exec()` để daemon spawn lệnh trong box.
 */
export interface BoxDaemonExecRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  workspaceDir?: string;
  egressPolicy?: EgressPolicy;
}

/**
 * Dựng ExecRequest cho daemon để chạy lệnh trong box: cwd +
 * workspaceDir trỏ vào box (daemon giam cwd theo workspaceDir này),
 * env từ allow-list của box (+ secret qua Vault do caller đưa),
 * egress policy (nếu có) để daemon kiểm tra đích mạng trong lệnh.
 */
export function boxDaemonExecRequest(
  box: BotBox,
  command: string,
  args: string[] = [],
  opts: {
    envValues?: Record<string, string>;
    vaultSecrets?: Record<string, string>;
    timeoutMs?: number;
    egressPolicy?: EgressPolicy;
  } = {},
): BoxDaemonExecRequest {
  return {
    command,
    args,
    cwd: box.workspaceDir,
    env: buildBoxEnv(box, {
      allowlist: box.envAllowlist,
      ...(opts.envValues !== undefined ? { values: opts.envValues } : {}),
      ...(opts.vaultSecrets !== undefined ? { vaultSecrets: opts.vaultSecrets } : {}),
    }),
    timeoutMs: opts.timeoutMs ?? box.limits.timeoutMs,
    workspaceDir: box.workspaceDir,
    ...(opts.egressPolicy !== undefined ? { egressPolicy: opts.egressPolicy } : {}),
  };
}
