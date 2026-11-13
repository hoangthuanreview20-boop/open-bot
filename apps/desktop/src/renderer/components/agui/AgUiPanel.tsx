/**
 * AgUiPanel — live activity feed view (v0.97, Team T3).
 *
 * The desktop home of AG-UI: a live activity feed for the selected
 * bot, fed by two channels that main forwards from the coordinator
 * child:
 *
 * - `agui:event` — full-fidelity AG-UI events from the loop emitter
 *   (API providers only; mock / CLI runs never emit these).
 * - `harness:event` — sanitised harness events, bridged into AG-UI
 *   shape by `harnessEventToAgUiView`, so CLI runs still show their
 *   text/tool activity in the same feed.
 *
 * Events are deduplicated by run + sequence (a reconnect or a
 * double forward must never show the same step twice) and the feed
 * keeps at most AG_UI_FEED_CAP items. Generative-UI answers go back
 * through IPC `agui:answer-component` (preload
 * `answerAgUiComponent`); the panel marks the component answered
 * optimistically and the GENERATIVE_UI_RESPONSE event confirms it.
 * Switching bots clears the feed synchronously so a slow event for
 * the old bot cannot land in the new bot's feed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgUiEventView, BotConfigLike, HarnessEventView } from '../../types';
import { useT } from '../../i18n/useT';
import ActivityFeed from './ActivityFeed';
import { appendAgUiEventToFeed, harnessEventToAgUiView, shouldBridgeHarnessEvent, type AgUiFeedItem } from './aguiFeed';

interface AgUiPanelProps {
  bots: BotConfigLike[];
  botId?: string | null;
  onBack: () => void;
  onSelectBot: (botId: string) => void;
}

type OpenBotAgUiApi = {
  onAgUiEvent?: (cb: (event: AgUiEventView) => void) => () => void;
  onHarnessEvent?: (cb: (event: HarnessEventView) => void) => () => void;
  answerAgUiComponent?: (payload: {
    componentId: string;
    response: Record<string, unknown>;
    action?: string;
  }) => Promise<{ componentId: string; found: boolean }>;
};

const LIVE_RETRY_MS = 2000;

export default function AgUiPanel({ bots, botId, onBack, onSelectBot }: AgUiPanelProps): React.ReactElement {
  const t = useT();
  const selectedBotId = botId ?? bots[0]?.id ?? null;
  const [items, setItems] = useState<AgUiFeedItem[]>([]);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const seenRef = useRef(new Set<string>());
  const generationRef = useRef(0);

  const applyEvent = useCallback((event: AgUiEventView) => {
    const generation = generationRef.current;
    const key =
      event.sequence !== undefined
        ? `${event.runId}:${event.sequence}`
        : `${event.runId}:${event.type}:${event.timestamp}:${event.messageId ?? ''}:${event.toolCallId ?? ''}`;
    setItems((prev) => {
      if (generation !== generationRef.current) return prev;
      if (seenRef.current.has(key)) return prev;
      seenRef.current.add(key);
      if (seenRef.current.size > 5000) {
        const next = new Set<string>();
        for (const entry of [...seenRef.current].slice(-2000)) next.add(entry);
        seenRef.current = next;
      }
      return appendAgUiEventToFeed(prev, event);
    });
  }, []);

  useEffect(() => {
    // Switching bots starts a fresh feed (same rule as EventLogView:
    // clear synchronously so stale events cannot leak across bots).
    generationRef.current += 1;
    seenRef.current = new Set<string>();
    setItems([]);
    setError('');
  }, [selectedBotId]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeAgUi: (() => void) | undefined;
    let unsubscribeHarness: (() => void) | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const trySubscribe = (): void => {
      if (cancelled) return;
      const api = window.openBot as unknown as OpenBotAgUiApi;
      let subscribed = false;
      if (typeof api.onAgUiEvent === 'function') {
        try {
          unsubscribeAgUi = api.onAgUiEvent((event) => {
            setConnected(true);
            applyEvent(event);
          });
          subscribed = true;
        } catch {
          // Preload not ready yet — retry below.
        }
      }
      if (typeof api.onHarnessEvent === 'function') {
        try {
          unsubscribeHarness = api.onHarnessEvent((event) => {
            setConnected(true);
            // Bridge only CLI/mock engines — API runs already publish
            // their own AG-UI events (see shouldBridgeHarnessEvent).
            if (!shouldBridgeHarnessEvent(event)) return;
            const bridged = harnessEventToAgUiView(event, event.threadId);
            if (bridged) applyEvent(bridged);
          });
          subscribed = true;
        } catch {
          // Preload not ready yet — retry below.
        }
      }
      if (!subscribed) {
        retryTimer = setTimeout(trySubscribe, LIVE_RETRY_MS);
      }
    };
    trySubscribe();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      try {
        unsubscribeAgUi?.();
      } catch {
        // Unsubscribe is best-effort.
      }
      try {
        unsubscribeHarness?.();
      } catch {
        // Unsubscribe is best-effort.
      }
    };
  }, [applyEvent]);

  const answerComponent = useCallback(
    (componentId: string, response: Record<string, unknown>, action: string): void => {
      const api = window.openBot as unknown as OpenBotAgUiApi;
      if (typeof api.answerAgUiComponent !== 'function') {
        setError(t('agui.panel.answerUnavailable'));
        return;
      }
      // Optimistic mark: the GENERATIVE_UI_RESPONSE event confirms it,
      // but the card must disable immediately so it cannot be answered twice.
      setItems((prev) =>
        prev.map((item) =>
          item.kind === 'genui' && item.component?.componentId === componentId
            ? { ...item, component: { ...item.component, answered: true, response } }
            : item,
        ),
      );
      void api
        .answerAgUiComponent({ componentId, response, action })
        .then((result) => {
          if (result.found !== true) setError(t('agui.panel.answerNotFound'));
        })
        .catch(() => {
          setError(t('agui.panel.answerFailed'));
        });
    },
    [t],
  );

  const clearFeed = useCallback(() => {
    generationRef.current += 1;
    seenRef.current = new Set<string>();
    setItems([]);
  }, []);

  return (
    <section aria-label={t('agui.panel.title')}>
      <header>
        <button type="button" onClick={onBack}>
          {t('agui.panel.back')}
        </button>
        <h2>{t('agui.panel.title')}</h2>
        <p>{t('agui.panel.intro')}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label>
            {t('agui.panel.botLabel')}
            <select
              value={selectedBotId ?? ''}
              onChange={(event) => onSelectBot(event.target.value)}
            >
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={clearFeed}>
            {t('agui.panel.clear')}
          </button>
          <span>{connected ? t('agui.panel.connected') : t('agui.panel.connecting')}</span>
        </div>
        {error ? <p role="alert">{error}</p> : null}
      </header>
      <ActivityFeed items={items} botId={selectedBotId ?? undefined} onAnswerComponent={answerComponent} />
    </section>
  );
}
