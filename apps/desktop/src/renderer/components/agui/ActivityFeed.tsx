/**
 * ActivityFeed — live activity feed for one bot (v0.97, Team T3).
 *
 * Renders the feed items produced by `aguiFeed.ts` from AG-UI
 * events: run lifecycle rows, streaming assistant text (accumulated
 * per message), tool calls with status + argument keys + output
 * preview, activity notes, shared-state snapshots, and generative-UI
 * components (rendered by GenerativeUi, sandboxed).
 *
 * The feed is read-only except for generative-UI answers: every
 * string comes from a validated event payload and is rendered as
 * React text. The component never renders event content as HTML.
 * A run filter (all / running only / tools only) and a text search
 * narrow the list without dropping items from state, so clearing
 * the filter restores the full feed.
 */
import { useMemo, useState } from 'react';
import type { AgUiFeedItem } from './aguiFeed';
import { summarizeAgUiFeed } from './aguiFeed';
import GenerativeUi, { type GenerativeUiRequestView } from './GenerativeUi';
import { useT } from '../../i18n/useT';

export type ActivityFeedFilter = 'all' | 'running' | 'tools' | 'components';

interface ActivityFeedProps {
  items: AgUiFeedItem[];
  botId?: string;
  onAnswerComponent: (
    componentId: string,
    response: Record<string, unknown>,
    action: string,
  ) => void;
}

function toolStatusLabel(t: ReturnType<typeof useT>, status?: string): string {
  switch (status) {
    case 'running':
      return t('agui.feed.toolRunning');
    case 'ok':
      return t('agui.feed.toolOk');
    case 'error':
      return t('agui.feed.toolError');
    case 'denied':
      return t('agui.feed.toolDenied');
    default:
      return '';
  }
}

function runStatusLabel(t: ReturnType<typeof useT>, status?: string): string {
  switch (status) {
    case 'running':
      return t('agui.feed.runRunning');
    case 'completed':
      return t('agui.feed.runCompleted');
    case 'stopped':
      return t('agui.feed.runStopped');
    case 'failed':
      return t('agui.feed.runFailed');
    case 'cancelled':
      return t('agui.feed.runCancelled');
    default:
      return '';
  }
}

function itemMatchesFilter(item: AgUiFeedItem, filter: ActivityFeedFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return item.kind === 'run' && item.runStatus === 'running';
  if (filter === 'tools') return item.kind === 'tool';
  if (filter === 'components') return item.kind === 'genui';
  return true;
}

function itemMatchesQuery(item: AgUiFeedItem, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  const haystacks = [
    item.title,
    item.detail ?? '',
    item.text ?? '',
    item.toolName ?? '',
    item.outputPreview ?? '',
    item.activityKind ?? '',
  ];
  return haystacks.some((entry) => entry.toLowerCase().includes(needle));
}

function FeedRow({ item, onAnswerComponent }: { item: AgUiFeedItem; onAnswerComponent: ActivityFeedProps['onAnswerComponent'] }): React.ReactElement {
  const t = useT();
  if (item.kind === 'genui' && item.component) {
    const request: GenerativeUiRequestView = {
      componentId: item.component.componentId,
      kind: item.component.kind as GenerativeUiRequestView['kind'],
      title: item.component.title,
      ...(item.component.description !== undefined ? { description: item.component.description } : {}),
      props: item.component.props,
      ...(item.component.blocking === true ? { blocking: true } : {}),
      answered: item.component.answered === true,
      ...(item.component.response !== undefined ? { response: item.component.response } : {}),
    };
    return <GenerativeUi request={request} onAnswer={onAnswerComponent} />;
  }
  return (
    <li>
      <div>
        <strong>{item.title}</strong>
        {item.kind === 'run' ? <span> · {runStatusLabel(t, item.runStatus)}</span> : null}
        {item.kind === 'tool' ? <span> · {toolStatusLabel(t, item.toolStatus)}</span> : null}
        {item.kind === 'activity' && item.progress !== undefined ? (
          <span> · {Math.round(item.progress * 100)}%</span>
        ) : null}
      </div>
      {item.detail ? <p>{item.detail}</p> : null}
      {item.kind === 'text' && item.text ? <p>{item.text}</p> : null}
      {item.kind === 'tool' && item.argKeys && item.argKeys.length > 0 ? (
        <p>
          {t('agui.feed.args')}: {item.argKeys.join(', ')}
        </p>
      ) : null}
      {item.kind === 'tool' && item.outputPreview ? <p>{item.outputPreview}</p> : null}
      {item.kind === 'state' && item.state ? (
        <pre>{JSON.stringify(item.state, null, 2)}</pre>
      ) : null}
      <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleTimeString()}</time>
    </li>
  );
}

export default function ActivityFeed({ items, botId, onAnswerComponent }: ActivityFeedProps): React.ReactElement {
  const t = useT();
  const [filter, setFilter] = useState<ActivityFeedFilter>('all');
  const [query, setQuery] = useState('');
  const summary = useMemo(() => summarizeAgUiFeed(items), [items]);
  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (botId === undefined || item.botId === undefined || item.botId === botId) &&
          itemMatchesFilter(item, filter) &&
          itemMatchesQuery(item, query.trim()),
      ),
    [items, botId, filter, query],
  );
  return (
    <section aria-label={t('agui.feed.title')}>
      <header>
        <h2>{t('agui.feed.title')}</h2>
        <p>
          {t('agui.feed.summary', {
            runs: String(summary.runs),
            running: String(summary.runningRuns),
            tools: String(summary.toolCalls),
            failed: String(summary.failedTools),
            components: String(summary.components),
            pending: String(summary.pendingComponents),
          })}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select
            aria-label={t('agui.feed.filterLabel')}
            value={filter}
            onChange={(event) => setFilter(event.target.value as ActivityFeedFilter)}
          >
            <option value="all">{t('agui.feed.filterAll')}</option>
            <option value="running">{t('agui.feed.filterRunning')}</option>
            <option value="tools">{t('agui.feed.filterTools')}</option>
            <option value="components">{t('agui.feed.filterComponents')}</option>
          </select>
          <input
            type="search"
            aria-label={t('agui.feed.searchLabel')}
            placeholder={t('agui.feed.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </header>
      {visible.length === 0 ? <p>{t('agui.feed.empty')}</p> : null}
      <ul>
        {visible.map((item) => (
          <FeedRow key={item.id} item={item} onAnswerComponent={onAnswerComponent} />
        ))}
      </ul>
    </section>
  );
}
