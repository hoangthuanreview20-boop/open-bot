import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * MCP Apps viewer (v0.97, Team T1).
 *
 * Renders one MCP App — interactive HTML returned by an MCP server —
 * inside a sandboxed iframe. The host never trusts the app: the HTML
 * must already have passed `validateAppHtml` in @open-bot/core (the
 * `mcp2_validate_app` tool), and this component only mounts a
 * descriptor that validation produced (`srcdoc`, fixed `sandbox`
 * flags, strict CSP). The sandbox attribute is applied verbatim
 * from the descriptor — the renderer never relaxes it, and the CSP
 * is the second layer, so a dropped sandbox still cannot turn the
 * app into a network-capable page.
 *
 * App-to-host communication goes through one narrow message bridge:
 * the app posts `{ type: 'mcp-app-request', action, payload }` and
 * the host answers `{ type: 'mcp-app-response', ... }`. Messages from
 * any other origin, with an unknown type, or with an unknown action
 * are dropped. The component never exposes host APIs, the file
 * system, or credentials to the frame.
 *
 * The viewer is deliberately a pure presentational component: it
 * takes a descriptor, not raw server output, so the security
 * decision (validate / refuse) lives in exactly one place — core —
 * and the renderer cannot accidentally mount an unvalidated app.
 * The coordinator wires it to the chat / marketplace flow later by
 * passing the descriptor from `mcp2_validate_app`.
 */

/** What `buildAppFrameDescriptor` in @open-bot/core returns. */
export interface McpAppFrameDescriptorLike {
  /** Validated HTML for the iframe `srcDoc`. */
  srcdoc: string;
  /** Fixed sandbox flags — applied verbatim, never relaxed. */
  sandbox: string;
  /** Content-Security-Policy for the iframe. */
  csp: string;
  /** App title for the frame label. */
  title: string;
  /** App URI (for the activity log, not for navigation). */
  uri: string;
  /** Non-blocking warnings to show next to the frame. */
  warnings: Array<{ code: string; message: string }>;
}

/** Actions the bridge accepts from the app (see `apps.ts`). */
const BRIDGE_ACTIONS: readonly string[] = ['tool-call', 'notify', 'close', 'get-data'];

interface Props {
  /** Validated descriptor from `mcp2_validate_app`, or null when no app is open. */
  app: McpAppFrameDescriptorLike | null;
  /** Called when the app asks to close itself (bridge `close` action). */
  onClose?: () => void;
  /** Called for a `notify` bridge message (app wants to show a note). */
  onNotify?: (message: string) => void;
  /** Called for a `tool-call` bridge message; return the tool result text. */
  onToolCall?: (payload: Record<string, unknown>) => Promise<string>;
  /** Called for a `get-data` bridge message; return the data the app asked for. */
  onGetData?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export default function McpAppsViewer({ app, onClose, onNotify, onToolCall, onGetData }: Props) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [bridgeLog, setBridgeLog] = useState<string[]>([]);
  const [droppedCount, setDroppedCount] = useState(0);

  // The CSP travels as a <meta> tag prepended to the srcdoc: an
  // iframe loaded from srcdoc has no HTTP headers of its own, so the
  // meta tag is the only way to apply the policy. The tag is built
  // from the descriptor's CSP, never from app content.
  const srcDocWithCsp = useMemo(() => {
    if (!app) return '';
    const escapedCsp = app.csp.replace(/"/g, '&quot;');
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapedCsp}"></head><body>${app.srcdoc}</body></html>`;
  }, [app]);

  useEffect(() => {
    if (!app) return;
    setBridgeLog([]);
    setDroppedCount(0);
  }, [app?.uri]);

  useEffect(() => {
    if (!app) return;
    const onMessage = (event: MessageEvent) => {
      // srcdoc iframes post with origin 'null' in some browsers and
      // the app origin in others — never trust the origin header
      // alone. The check that matters is the source: only messages
      // from THIS frame are accepted.
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as unknown;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        setDroppedCount((n) => n + 1);
        return;
      }
      const rec = data as Record<string, unknown>;
      if (rec['type'] !== 'mcp-app-request') {
        setDroppedCount((n) => n + 1);
        return;
      }
      const action = rec['action'];
      if (typeof action !== 'string' || !BRIDGE_ACTIONS.includes(action)) {
        setDroppedCount((n) => n + 1);
        return;
      }
      const payload =
        rec['payload'] !== undefined && typeof rec['payload'] === 'object' && rec['payload'] !== null
          ? (rec['payload'] as Record<string, unknown>)
          : {};
      const requestId = typeof rec['requestId'] === 'string' ? rec['requestId'] : undefined;
      const reply = (result: unknown, error?: string) => {
        frameRef.current?.contentWindow?.postMessage(
          {
            type: 'mcp-app-response',
            ...(requestId ? { requestId } : {}),
            ...(error ? { error } : { result }),
          },
          '*',
        );
      };
      setBridgeLog((log) => [...log.slice(-19), `${action}: ${JSON.stringify(payload).slice(0, 200)}`]);
      if (action === 'close') {
        reply({ closed: true });
        onClose?.();
        return;
      }
      if (action === 'notify') {
        const message = typeof payload['message'] === 'string' ? payload['message'] : '';
        if (message) onNotify?.(message);
        reply({ notified: true });
        return;
      }
      if (action === 'tool-call') {
        if (!onToolCall) {
          reply(null, 'Host does not allow tool calls from this app.');
          return;
        }
        void onToolCall(payload)
          .then((result) => reply({ text: result }))
          .catch((err: unknown) => reply(null, err instanceof Error ? err.message : 'Tool call failed.'));
        return;
      }
      // get-data
      if (!onGetData) {
        reply(null, 'Host does not provide data to this app.');
        return;
      }
      void onGetData(payload)
        .then((result) => reply(result))
        .catch((err: unknown) => reply(null, err instanceof Error ? err.message : 'Data request failed.'));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [app, onClose, onNotify, onToolCall, onGetData]);

  if (!app) {
    return (
      <div data-testid="mcp-apps-empty">
        <p>{t('mcp2.appsEmpty')}</p>
        <p className="hint">{t('mcp2.appsEmptyHint')}</p>
      </div>
    );
  }

  return (
    <div data-testid="mcp-apps-viewer">
      <div>
        <strong>{app.title}</strong>{' '}
        <span className="hint">{app.uri}</span>
      </div>
      {app.warnings.length > 0 && (
        <div data-testid="mcp-apps-warnings">
          <p>{t('mcp2.appsWarnings')}</p>
          <ul>
            {app.warnings.map((w) => (
              <li key={w.code}>
                <code>{w.code}</code>: {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <iframe
        ref={frameRef}
        sandbox={app.sandbox}
        srcDoc={srcDocWithCsp}
        title={app.title}
        data-testid="mcp-apps-frame"
        style={{ width: '100%', height: '50vh', border: '1px solid var(--border, #ccc)', background: '#fff' }}
      />
      <p className="hint">{t('mcp2.appsSandboxNote')}</p>
      {bridgeLog.length > 0 && (
        <details>
          <summary>{t('mcp2.appsBridgeLog')}</summary>
          <ul>
            {bridgeLog.map((entry, i) => (
              <li key={i}>{entry}</li>
            ))}
          </ul>
        </details>
      )}
      {droppedCount > 0 && (
        <p className="hint" data-testid="mcp-apps-dropped">
          {t('mcp2.appsDroppedMessages', { count: droppedCount })}
        </p>
      )}
    </div>
  );
}
