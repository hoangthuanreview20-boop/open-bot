import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { t } from './i18n';
import './styles.css';

// v0.86 (P2-7): renderer error hook — forwards uncaught errors to the
// main process via IPC `crash-report:renderer`; main applies the opt-in
// gate + redaction + local save. Only message + stack are forwarded (no
// chat content, no raw home paths — main redacts again before saving).
// `createRendererErrorHandler` from @open-bot/core is NOT imported here:
// the renderer never imports core's Node runtime (types only); the
// forwarding is a few lines and must NEVER throw inside an error
// handler (a throwing handler would hide the original error).
// Returning nothing keeps the browser's default error handling as-is.
function installRendererCrashHook(): void {
  const report = (message: string, stack?: string): void => {
    try {
      const api = (window as unknown as { openBot?: { reportRendererError?: (input: { message: string; stack?: string }) => Promise<unknown> } }).openBot;
      void api?.reportRendererError?.({ message, ...(stack ? { stack } : {}) }).catch(() => undefined);
    } catch {
      // Never throw from inside an error handler.
    }
  };
  window.addEventListener('error', (event) => {
    report(
      typeof event.message === 'string' ? event.message : 'Unknown renderer error',
      event.error instanceof Error ? event.error.stack : undefined,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    report(
      reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unhandled rejection',
      reason instanceof Error ? reason.stack : undefined,
    );
  });
}
installRendererCrashHook();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error(t('app.rootMissing'));
createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
