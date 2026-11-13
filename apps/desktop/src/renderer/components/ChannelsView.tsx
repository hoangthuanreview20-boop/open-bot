import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfigLike, ChannelMessageView, ChannelView } from '../types';
import { useT } from '../i18n/useT';
import ConfirmModal from './ConfirmModal';

/**
 * Channels (v0.96 Team T4): a shared workspace for several bots —
 * its own transcript, shared instructions, a working folder, and
 * responder rules (which bot replies to a message in the channel).
 *
 * Durable data flows over IPC `channel:*` to the coordinator
 * (ChannelStore in `channels.json` under the data dir, see
 * `packages/core/src/channels/`). Sending a message runs the
 * responder rules for real in the coordinator: each chosen bot runs
 * a silent run (shared instructions prepended to the prompt, working
 * folder as the run cwd) and its reply is written to the transcript.
 * A bot that fails leaves an `[error]` note in the transcript (written
 * by the adapter — the channel itself keeps working).
 */

type ResponderMode = 'mentioned' | 'all' | 'round-robin' | 'first' | 'none';

interface Props {
  bots: BotConfigLike[];
  onBack: () => void;
}

const MODE_KEYS: ResponderMode[] = ['mentioned', 'all', 'round-robin', 'first', 'none'];

function isResponderMode(value: string): value is ResponderMode {
  return (MODE_KEYS as readonly string[]).includes(value);
}

export default function ChannelsView({ bots, onBack }: Props) {
  const t = useT();
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChannelMessageView[]>([]);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'work' | 'personal' | 'project'>('work');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChannelView | null>(null);
  const [addBotId, setAddBotId] = useState('');
  const [moveBotId, setMoveBotId] = useState('');
  const [moveToId, setMoveToId] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // Drafts for the two free-text fields: typing stays local, the IPC
  // update fires on blur (one round-trip per edit, not per keystroke).
  const [instructionsDraft, setInstructionsDraft] = useState('');
  const [folderDraft, setFolderDraft] = useState('');
  const loadedOnce = useRef(false);

  const selected = useMemo(
    () => channels.find((c) => c.id === selectedId) ?? null,
    [channels, selectedId],
  );
  const botsById = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const availableBots = bots.filter((b) => selected && !selected.botIds.includes(b.id));
  const otherChannels = channels.filter((c) => selected && c.id !== selected.id);

  const loadChannels = useCallback(async () => {
    const showLoading = !loadedOnce.current;
    if (showLoading) {
      setLoading(true);
      setError('');
    }
    try {
      const list = await window.openBot.listChannels();
      if (!Array.isArray(list)) throw new Error('channel list is not an array');
      setChannels(list);
      setError('');
      loadedOnce.current = true;
      if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
    } catch {
      setError(t('channels.loadError'));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [selectedId, t]);

  const loadMessages = useCallback(
    async (channelId: string) => {
      try {
        const list = await window.openBot.listChannelMessages({ channelId, limit: 100 });
        if (!Array.isArray(list)) throw new Error('channel messages are not an array');
        setMessages(list);
      } catch {
        setError(t('channels.loadError'));
      }
    },
    [t],
  );

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void loadMessages(selectedId);
  }, [selectedId, loadMessages]);

  // Keep the drafts in sync when the user picks another channel.
  useEffect(() => {
    setInstructionsDraft(selected?.sharedInstructions ?? '');
    setFolderDraft(selected?.workingFolder ?? '');
  }, [selected?.id]);

  function refreshSelected(updated: ChannelView): void {
    setChannels((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  }

  async function createChannel(): Promise<void> {
    const name = newName.trim();
    if (name === '') {
      setError(t('channels.nameRequired'));
      return;
    }
    try {
      const { channel } = await window.openBot.createChannel({ name, kind: newKind });
      setChannels((prev) => [...prev, channel]);
      setSelectedId(channel.id);
      setNewName('');
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.createError'));
    }
  }

  async function updateSelected(patch: {
    name?: string;
    kind?: 'work' | 'personal' | 'project';
    sharedInstructions?: string;
    workingFolder?: string;
    responderRules?: Partial<ChannelView['responderRules']>;
  }): Promise<void> {
    if (!selected) return;
    try {
      const { channel } = await window.openBot.updateChannel({ channelId: selected.id, ...patch });
      refreshSelected(channel);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.updateError'));
    }
  }

  function toggleInList(list: string[] | undefined, botId: string): string[] {
    const base = list ?? [];
    return base.includes(botId) ? base.filter((id) => id !== botId) : [...base, botId];
  }

  async function addBot(): Promise<void> {
    if (!selected || addBotId === '') return;
    try {
      await window.openBot.addBotToChannel({ channelId: selected.id, botId: addBotId });
      await loadChannels();
      setAddBotId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.addBotError'));
    }
  }

  async function removeBot(botId: string): Promise<void> {
    if (!selected) return;
    try {
      await window.openBot.removeBotFromChannel({ channelId: selected.id, botId });
      await loadChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.removeBotError'));
    }
  }

  async function moveBot(): Promise<void> {
    if (!selected || moveBotId === '' || moveToId === '') return;
    try {
      await window.openBot.moveBotBetweenChannels({
        fromChannelId: selected.id,
        toChannelId: moveToId,
        botId: moveBotId,
      });
      await loadChannels();
      setMoveBotId('');
      setMoveToId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.moveBotError'));
    }
  }

  async function sendMessage(): Promise<void> {
    if (!selected || text.trim() === '' || sending) return;
    const body = text.trim();
    setText('');
    setSending(true);
    try {
      const res = await window.openBot.postChannelMessage({ channelId: selected.id, text: body });
      // The user message + replies (including `[error]` notes from bots
      // whose run failed).
      setMessages((prev) => [...prev, res.message, ...res.replies]);
      if (Object.keys(res.errors).length > 0) {
        const names = Object.keys(res.errors)
          .map((id) => botsById.get(id)?.name ?? id)
          .join(', ');
        setError(t('channels.replyError', { names }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('channels.sendError'));
      setText(body);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="channels-view">
      <div className="channels-header">
        <button type="button" className="btn-ghost" onClick={onBack}>{t('channels.back')}</button>
        <h2>{t('channels.title')}</h2>
      </div>
      <p className="channels-note">{t('channels.sessionNote')}</p>
      {loading && <p className="channels-hint">{t('channels.loading')}</p>}
      {error !== '' && <div className="channels-error">{error}</div>}

      <div className="channels-create">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={t('channels.createPlaceholder')}
          maxLength={80}
          aria-label={t('channels.createPlaceholder')}
        />
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as 'work' | 'personal' | 'project')} aria-label={t('channels.kind')}>
          <option value="work">{t('channels.kindWork')}</option>
          <option value="personal">{t('channels.kindPersonal')}</option>
          <option value="project">{t('channels.kindProject')}</option>
        </select>
        <button type="button" className="btn-primary" onClick={() => void createChannel()}>{t('channels.create')}</button>
      </div>

      {channels.length === 0 && !loading ? (
        <p className="channels-empty">{t('channels.empty')}</p>
      ) : (
        <div className="channels-layout">
          <ul className="channels-list">
            {channels.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={c.id === selectedId ? 'channels-item selected' : 'channels-item'}
                  onClick={() => setSelectedId(c.id)}
                >
                  <span className="channels-item-name">{c.name}</span>
                  <span className="channels-item-meta">
                    {t(`channels.kind${c.kind === 'work' ? 'Work' : c.kind === 'personal' ? 'Personal' : 'Project'}`)}
                    {' · '}
                    {t('channels.botCount', { count: String(c.botIds.length) })}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {selected && (
            <div className="channels-detail">
              <div className="channels-detail-head">
                <h3>{selected.name}</h3>
                <button type="button" className="btn-danger-ghost" onClick={() => setDeleteTarget(selected)}>
                  {t('channels.delete')}
                </button>
              </div>

              <label className="channels-field">
                <span>{t('channels.sharedInstructions')}</span>
                <textarea
                  value={instructionsDraft}
                  onChange={(e) => setInstructionsDraft(e.target.value)}
                  onBlur={() => {
                    if (instructionsDraft !== selected.sharedInstructions) {
                      void updateSelected({ sharedInstructions: instructionsDraft });
                    }
                  }}
                  placeholder={t('channels.sharedInstructionsPlaceholder')}
                  rows={4}
                  maxLength={20000}
                />
              </label>
              <label className="channels-field">
                <span>{t('channels.workingFolder')}</span>
                <input
                  value={folderDraft}
                  onChange={(e) => setFolderDraft(e.target.value)}
                  onBlur={() => {
                    if (folderDraft !== selected.workingFolder) {
                      void updateSelected({ workingFolder: folderDraft });
                    }
                  }}
                  placeholder={t('channels.workingFolderPlaceholder')}
                  maxLength={500}
                />
              </label>

              <div className="channels-field">
                <span>{t('channels.responderMode')}</span>
                <select
                  value={selected.responderRules.mode}
                  onChange={(e) => {
                    if (isResponderMode(e.target.value)) {
                      void updateSelected({ responderRules: { mode: e.target.value } });
                    }
                  }}
                >
                  {MODE_KEYS.map((mode) => (
                    <option key={mode} value={mode}>{t(`channels.mode.${mode}`)}</option>
                  ))}
                </select>
                <p className="channels-hint">{t(`channels.modeHint.${selected.responderRules.mode}`)}</p>
              </div>

              <div className="channels-field">
                <span>{t('channels.roster')}</span>
                {selected.botIds.length === 0 ? (
                  <p className="channels-hint">{t('channels.rosterEmpty')}</p>
                ) : (
                  <ul className="channels-roster">
                    {selected.botIds.map((botId) => {
                      const bot = botsById.get(botId);
                      return (
                        <li key={botId}>
                          <span>{bot?.name ?? botId}</span>
                          <label>
                            <input
                              type="checkbox"
                              checked={(selected.responderRules.requireMentionFor ?? []).includes(botId)}
                              onChange={() => void updateSelected({
                                responderRules: {
                                  requireMentionFor: toggleInList(selected.responderRules.requireMentionFor, botId),
                                },
                              })}
                            />
                            {t('channels.onlyWhenMentioned')}
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={(selected.responderRules.onlyBotIds ?? []).includes(botId)}
                              onChange={() => void updateSelected({
                                responderRules: {
                                  onlyBotIds: toggleInList(selected.responderRules.onlyBotIds, botId),
                                },
                              })}
                            />
                            {t('channels.allowedToReply')}
                          </label>
                          <button type="button" className="btn-ghost" onClick={() => void removeBot(botId)}>
                            {t('channels.removeBot')}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {availableBots.length > 0 && (
                  <div className="channels-add-bot">
                    <select value={addBotId} onChange={(e) => setAddBotId(e.target.value)} aria-label={t('channels.addBot')}>
                      <option value="">{t('channels.addBot')}</option>
                      {availableBots.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                    <button type="button" className="btn-primary" disabled={addBotId === ''} onClick={() => void addBot()}>
                      {t('channels.add')}
                    </button>
                  </div>
                )}
                {selected.botIds.length > 0 && otherChannels.length > 0 && (
                  <div className="channels-add-bot">
                    <select value={moveBotId} onChange={(e) => setMoveBotId(e.target.value)} aria-label={t('channels.moveBot')}>
                      <option value="">{t('channels.moveBot')}</option>
                      {selected.botIds.map((botId) => (
                        <option key={botId} value={botId}>{botsById.get(botId)?.name ?? botId}</option>
                      ))}
                    </select>
                    <select value={moveToId} onChange={(e) => setMoveToId(e.target.value)} aria-label={t('channels.moveTo')}>
                      <option value="">{t('channels.moveTo')}</option>
                      {otherChannels.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <button type="button" className="btn-primary" disabled={moveBotId === '' || moveToId === ''} onClick={() => void moveBot()}>
                      {t('channels.move')}
                    </button>
                  </div>
                )}
              </div>

              <div className="channels-field">
                <span>{t('channels.transcript')}</span>
                {messages.length === 0 ? (
                  <p className="channels-hint">{t('channels.transcriptEmpty')}</p>
                ) : (
                  <ul className="channels-messages">
                    {messages.map((m) => (
                      <li key={m.id}><strong>{m.botName}:</strong> {m.text}</li>
                    ))}
                  </ul>
                )}
                <div className="channels-composer">
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void sendMessage(); }}
                    placeholder={t('channels.composerPlaceholder')}
                    disabled={sending}
                  />
                  <button type="button" className="btn-primary" disabled={sending || text.trim() === ''} onClick={() => void sendMessage()}>
                    {t('channels.send')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t('channels.deleteConfirmTitle')}
          message={t('channels.deleteConfirmBody', { name: deleteTarget.name })}
          confirmLabel={t('channels.delete')}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            void window.openBot.deleteChannel({ channelId: target.id })
              .then(() => {
                setChannels((prev) => prev.filter((c) => c.id !== target.id));
                if (selectedId === target.id) setSelectedId(null);
              })
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : t('channels.deleteError'));
              });
          }}
        />
      )}
    </div>
  );
}
