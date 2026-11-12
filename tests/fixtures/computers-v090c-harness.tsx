/**
 * Harness entry for tests/computers-v090c-renderer.test.mjs.
 *
 * Bundles the real `ComputersView` in a bare Electron window — no
 * main process, no preload. Exposes:
 *   `__mountComputersView()` — mounts the view for 3 bots; the mock
 *   `window.openBot` counts IPC calls on `window.__listCalls`,
 *   `window.__probeCalls`, `window.__queueCalls`,
 *   `window.__priorityCalls` (with last payload),
 *   `window.__autoShedCalls` (with last payload) and
 *   `window.__guestHealthCalls`.
 *
 * Mock data (no secret):
 * - probe: fake 8-core / 16GB machine, not busy.
 * - list: bot-1 box computer (paused, with lastPauseReason) + bot-2
 *   VM computer (running, guest health 'unknown', not connected).
 * - queue: bot-3 waiting (priority 30, reason 'hết chỗ lúc tạo'),
 *   autoShed starts off.
 * - set-priority updates the queued entry; set-auto-shed flips the
 *   flag; guest-health returns ok + version '0.90c' + uptime 123s.
 *
 * The view reads the real vi.json through useT (default locale is
 * vi), so assertions check the real Vietnamese strings.
 */
import { createRoot, type Root } from 'react-dom/client';
import ComputersView from '../../apps/desktop/src/renderer/components/ComputersView';
import type {
  BotConfigLike,
  ComputerQueueView,
  ComputerStatusView,
  ComputersProbeView,
  GuestAgentHealthView,
} from '../../apps/desktop/src/renderer/types';

let root: Root | null = null;

type Win = typeof window & {
  __listCalls?: number;
  __probeCalls?: number;
  __queueCalls?: number;
  __priorityCalls?: Array<{ botId: string; priority: number }>;
  __autoShedCalls?: Array<{ enabled: boolean }>;
  __guestHealthCalls?: string[];
};

const BOTS: BotConfigLike[] = [
  { id: 'bot-1', name: 'Bot One', providerId: 'xai', model: 'grok-4.7', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
  { id: 'bot-2', name: 'Bot Two', providerId: 'xai', model: 'grok-4.7', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
  { id: 'bot-3', name: 'Bot Three', providerId: 'xai', model: 'grok-4.7', systemPrompt: '', workspaceDir: '/tmp', autoApprove: false },
];

const PROBE: ComputersProbeView = {
  profile: {
    os: 'linux',
    osVersion: 'Ubuntu 24.04.1 LTS',
    arch: 'x64',
    hostname: 'test-machine',
    cpu: { model: 'Test CPU', logicalCores: 8, physicalCores: 4, speedMhz: 3000, virtualizationFlags: ['vmx'], loadAvg1m: 1.0, loadPerCore: 0.125 },
    memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 12 * 1024 ** 3, freeRatio: 0.75 },
    disks: [{ mount: '/', totalBytes: 500 * 1024 ** 3, freeBytes: 300 * 1024 ** 3, freeRatio: 0.6 }],
    virtualization: { supported: true, detail: 'VMX (Intel) + KVM (/dev/kvm)' },
    gpus: [],
    warnings: [],
  },
  backends: [
    { kind: 'box', level: 'box', available: true, detail: 'box' },
    { kind: 'qemu', level: 'vm', available: true, detail: 'qemu' },
  ],
  busy: false,
};

function boxView(): ComputerStatusView {
  return {
    computer: {
      id: 'computer-bot-1',
      botId: 'bot-1',
      level: 'box',
      backend: 'box',
      backendDetail: 'box',
      cpuCores: 0.5,
      ramBytes: 512 * 1024 ** 2,
      diskBytes: 1024 ** 3,
      priority: 50,
      state: 'paused',
      workspaceDir: '/tmp/bot-1',
      diskUsedBytes: 1024,
      lastPauseReason: 'Tự giảm tải: máy host đang bận (cpu-load).',
    },
    effectiveLevel: 'box',
    memoryEnforcement: 'prlimit-only',
    memoryUsageBytes: null,
  };
}

function vmView(): ComputerStatusView {
  return {
    computer: {
      id: 'computer-bot-2',
      botId: 'bot-2',
      level: 'vm',
      backend: 'qemu',
      backendDetail: 'qemu',
      cpuCores: 2,
      ramBytes: 4 * 1024 ** 3,
      diskBytes: 10 * 1024 ** 3,
      priority: 80,
      state: 'running',
      workspaceDir: '/tmp/bot-2',
      imagePath: '/tmp/vm.qcow2',
      vmNetwork: 'none',
      diskUsedBytes: null,
    },
    effectiveLevel: 'vm',
    guestAgentConnected: false,
    guestAgentHealth: { status: 'unknown' },
    memoryEnforcement: 'prlimit-only',
    memoryUsageBytes: null,
  };
}

let queueState: ComputerQueueView = {
  queue: [
    {
      botId: 'bot-3',
      request: { botId: 'bot-3', level: 'box', priority: 30 },
      priority: 30,
      enqueuedAt: '2026-11-11T00:00:00.000Z',
      reason: 'hết chỗ lúc tạo',
    },
  ],
  autoShed: false,
};

function installMock(): void {
  const w = window as Win;
  w.__listCalls = 0;
  w.__probeCalls = 0;
  w.__queueCalls = 0;
  w.__priorityCalls = [];
  w.__autoShedCalls = [];
  w.__guestHealthCalls = [];
  const api: Record<string, unknown> = {
    'computers:probe': () => {
      w.__probeCalls = (w.__probeCalls ?? 0) + 1;
      return Promise.resolve(PROBE);
    },
    'computers:plan': () => Promise.resolve({ allocations: [], rejected: [], hostHeadroom: { cpuCores: 0, ramBytes: 0, diskBytes: 0 }, busy: false, warnings: [] }),
    'computers:create': () => Promise.resolve([boxView(), vmView()]),
    'computers:list': () => {
      w.__listCalls = (w.__listCalls ?? 0) + 1;
      return Promise.resolve([boxView(), vmView()]);
    },
    'computers:queue': () => {
      w.__queueCalls = (w.__queueCalls ?? 0) + 1;
      return Promise.resolve(queueState);
    },
    'computers:set-priority': (payload: { botId: string; priority: number }) => {
      w.__priorityCalls = [...(w.__priorityCalls ?? []), payload];
      queueState = {
        ...queueState,
        queue: queueState.queue.map((e) =>
          e.botId === payload.botId
            ? { ...e, priority: payload.priority, request: { ...e.request, priority: payload.priority } }
            : e,
        ),
      };
      return Promise.resolve(queueState);
    },
    'computers:set-auto-shed': (payload: { enabled: boolean }) => {
      w.__autoShedCalls = [...(w.__autoShedCalls ?? []), payload];
      queueState = { ...queueState, autoShed: payload.enabled };
      return Promise.resolve(queueState);
    },
    'computers:guest-health': (botId: string) => {
      w.__guestHealthCalls = [...(w.__guestHealthCalls ?? []), botId];
      const health: GuestAgentHealthView = { status: 'ok', version: '0.90c', uptimeSeconds: 123 };
      return Promise.resolve(health);
    },
    probeComputers: () => {
      w.__probeCalls = (w.__probeCalls ?? 0) + 1;
      return Promise.resolve(PROBE);
    },
    listComputers: () => {
      w.__listCalls = (w.__listCalls ?? 0) + 1;
      return Promise.resolve([boxView(), vmView()]);
    },
    getComputerQueue: () => {
      w.__queueCalls = (w.__queueCalls ?? 0) + 1;
      return Promise.resolve(queueState);
    },
    setComputerPriority: (payload: { botId: string; priority: number }) => {
      w.__priorityCalls = [...(w.__priorityCalls ?? []), payload];
      return Promise.resolve(queueState);
    },
    setComputerAutoShed: (payload: { enabled: boolean }) => {
      w.__autoShedCalls = [...(w.__autoShedCalls ?? []), payload];
      return Promise.resolve(queueState);
    },
    checkComputerGuestHealth: (botId: string) => {
      w.__guestHealthCalls = [...(w.__guestHealthCalls ?? []), botId];
      return Promise.resolve({ status: 'ok', version: '0.90c', uptimeSeconds: 123 } as GuestAgentHealthView);
    },
  };
  (window as unknown as { openBot: unknown }).openBot = api;
}

function mountComputersView(): boolean {
  installMock();
  queueState = {
    queue: [
      {
        botId: 'bot-3',
        request: { botId: 'bot-3', level: 'box', priority: 30 },
        priority: 30,
        enqueuedAt: '2026-11-11T00:00:00.000Z',
        reason: 'hết chỗ lúc tạo',
      },
    ],
    autoShed: false,
  };
  const el = document.getElementById('root');
  if (!el) return false;
  if (root) {
    root.unmount();
    root = null;
  }
  root = createRoot(el);
  root.render(<ComputersView bots={BOTS} onBack={() => undefined} />);
  return true;
}

(window as unknown as { __mountComputersView: () => boolean }).__mountComputersView =
  mountComputersView;
