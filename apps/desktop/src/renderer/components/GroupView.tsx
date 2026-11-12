import { useCallback, useEffect, useRef, useState } from 'react';
import type { BotConfigLike, GroupBotInterruptedView, GroupBotStatusView, GroupChatView, GroupMessageAttachmentView, GroupMessageView } from '../types';
import { useT } from '../i18n/useT';
import ConfirmModal, { type PendingConfirm } from './ConfirmModal';
import {
  VISION_MAX_IMAGE_BYTES,
  VISION_MAX_IMAGES,
  VISION_MAX_TOTAL_BYTES,
  buildVisionAttachments,
  formatFileSize,
  validateVisionItems,
  visionMimeTypeForFile,
  type AttachmentSendItem,
} from './composer';

/** Chunked ArrayBuffer -> base64 (same as ChatView — avoids spreading huge arrays into btoa). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface Props {
  bots: BotConfigLike[];
  onBack: () => void;
}

/**
 * Bot-to-bot group chat (M8): create groups, add bots, read messages
 * labelled by which bot said them, and send messages with @mentions to
 * call a specific bot — the called bot runs the task and replies right
 * in the thread (delegation lives in the coordinator). Group history
 * is durable (group-chats.json in the coordinator) so reopening the
 * app keeps it.
 */
export default function GroupView({ bots, onBack }: Props) {
  const t = useT();
  const [groups, setGroups] = useState<GroupChatView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<GroupMessageView[]>([]);
  const [newName, setNewName] = useState('');
  const [text, setText] = useState('');
  const [addBotId, setAddBotId] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  // v0.94c: image attachments — same vision-channel rules as the
  // regular chat (max 5 images, PNG/JPEG/GIF/WebP only, base64 read
  // at pick time).
  const [attachments, setAttachments] = useState<AttachmentSendItem[]>([]);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // v0.94c: loaded thumbnails by attachment id (data URL) — a message
  // only carries file references, bytes come lazily through
  // `group:get-attachment` (each image fetched once; a failure records
  // 'missing' so a placeholder shows instead of a broken image).
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  const [thumbMissing, setThumbMissing] = useState<Record<string, true>>({});
  const thumbLoading = useRef<Set<string>>(new Set());
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  // v0.71 (audit): the two mount loads had no loading state at all —
  // while they were in flight the view showed "no groups yet" /
  // "no messages yet" as if that were the real state, and a failed
  // load had no retry. Same first-load pattern as Settings (v0.68c):
  // flag + *LoadedOnce ref + finally + dedicated load error + retry.
  // `loadError` is separate from `error` (create/add/delete/send):
  // a later action error must not hide a load failure, or vice versa.
  const [groupsLoading, setGroupsLoading] = useState(true);
  const groupsLoadedOnce = useRef(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  // v0.79a (UI parity §7): running status of each bot in the open
  // group — the coordinator marks `running` during a delegation run
  // and the renderer polls `group:status` every 2s to show the
  // "replying…" line + a status dot per member. A failed poll quietly
  // keeps the previous status (status is auxiliary info — it must
  // never hide messages or raise a load error).
  const [statuses, setStatuses] = useState<GroupBotStatusView[]>([]);
  // v0.82: bots whose run was cut short when the app stopped
  // (restored from the snapshot after a restart — NOT still running).
  // Shows a warning line + a Dismiss button; the line goes away when
  // the bot runs again or the user dismisses it.
  const [interrupted, setInterrupted] = useState<GroupBotInterruptedView[]>([]);
  const loadStatus = useCallback(async (groupId: string) => {
    const api = window.openBot as unknown as {
      getGroupBotStatus?: (payload: { groupId: string }) => Promise<{ running: GroupBotStatusView[]; interrupted?: GroupBotInterruptedView[] }>;
    };
    if (typeof api.getGroupBotStatus !== 'function') return;
    try {
      const res = await api.getGroupBotStatus({ groupId });
      if (Array.isArray(res?.running)) setStatuses(res.running);
      if (Array.isArray(res?.interrupted)) setInterrupted(res.interrupted);
    } catch {
      // Keep the previous status; the next poll retries.
    }
  }, []);

  const dismissInterrupted = useCallback(
    async (groupId: string, botId: string) => {
      const api = window.openBot as unknown as {
        dismissGroupBotInterrupted?: (payload: { groupId: string; botId: string }) => Promise<unknown>;
      };
      if (typeof api.dismissGroupBotInterrupted !== 'function') return;
      try {
        await api.dismissGroupBotInterrupted({ groupId, botId });
        setInterrupted((prev) => prev.filter((e) => e.botId !== botId));
      } catch {
        // A failed dismiss leaves the line in place; the next poll retries.
      }
    },
    [],
  );

  useEffect(() => {
    if (!selectedId) {
      setStatuses([]);
      setInterrupted([]);
      return undefined;
    }
    void loadStatus(selectedId);
    const timer = window.setInterval(() => void loadStatus(selectedId), 2000);
    return () => window.clearInterval(timer);
  }, [selectedId, loadStatus]);

  const loadGroups = useCallback(async () => {
    const showLoading = !groupsLoadedOnce.current;
    if (showLoading) {
      setGroupsLoading(true);
      setLoadError('');
    }
    try {
      const list = await window.openBot.listGroupChats();
      // Defensive: a non-array payload (e.g. a raw RPC envelope) must
      // never white-screen the app — show the load error instead.
      if (!Array.isArray(list)) throw new Error('group list is not an array');
      setGroups(list);
      setLoadError('');
      groupsLoadedOnce.current = true;
      if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
    } catch {
      setLoadError(t('group.loadError'));
    } finally {
      if (showLoading) setGroupsLoading(false);
    }
  }, [selectedId, t]);

  const loadMessages = useCallback(
    async (groupId: string) => {
      setMessagesLoading(true);
      try {
        const list = await window.openBot.listGroupMessages({ groupId, limit: 100 });
        if (!Array.isArray(list)) throw new Error('group messages are not an array');
        setMessages(list);
        setLoadError('');
      } catch {
        setLoadError(t('group.loadError'));
      } finally {
        setMessagesLoading(false);
      }
    },
    [t],
  );

  /** Retry after a load failure: reload the list and the open thread. */
  const reloadGroups = useCallback(async () => {
    await loadGroups();
    if (selectedId) await loadMessages(selectedId);
  }, [loadGroups, loadMessages, selectedId]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (selectedId) void loadMessages(selectedId);
    else setMessages([]);
  }, [selectedId, loadMessages]);

  // v0.94c: lazily load thumbnails for messages with images — each
  // attachment calls the IPC once (guarded by the ref + existing
  // state); a failure marks it missing so a placeholder shows instead
  // of retrying forever.
  useEffect(() => {
    if (!selectedId) return;
    for (const m of messages) {
      for (const att of m.attachments ?? []) {
        if (thumbUrls[att.id] || thumbMissing[att.id] || thumbLoading.current.has(att.id)) continue;
        thumbLoading.current.add(att.id);
        const api = window.openBot as unknown as {
          getGroupAttachment?: (payload: { groupId: string; messageId: string; attachmentId: string }) => Promise<{ attachment: { mimeType: string; data: string } }>;
        };
        if (typeof api.getGroupAttachment !== 'function') {
          setThumbMissing((prev) => ({ ...prev, [att.id]: true }));
          continue;
        }
        void api
          .getGroupAttachment({ groupId: selectedId, messageId: m.id, attachmentId: att.id })
          .then((res) => {
            const a = res?.attachment;
            if (a?.data) {
              setThumbUrls((prev) => ({ ...prev, [att.id]: `data:${a.mimeType};base64,${a.data}` }));
            } else {
              setThumbMissing((prev) => ({ ...prev, [att.id]: true }));
            }
          })
          .catch(() => {
            setThumbMissing((prev) => ({ ...prev, [att.id]: true }));
          })
          .finally(() => {
            thumbLoading.current.delete(att.id);
          });
      }
    }
  }, [messages, selectedId, thumbUrls, thumbMissing]);

  const selected = groups.find((g) => g.id === selectedId) ?? null;
  const memberBots = (selected?.botIds ?? [])
    .map((id) => bots.find((b) => b.id === id))
    .filter((b): b is BotConfigLike => b !== undefined);
  const addableBots = bots.filter((b) => !(selected?.botIds ?? []).includes(b.id));

  const createGroup = async () => {
    if (!newName.trim()) return;
    setError('');
    try {
      const { group } = await window.openBot.createGroupChat({ name: newName.trim() });
      setNewName('');
      setGroups((prev) => [...prev, group]);
      setSelectedId(group.id);
    } catch {
      setError(t('group.createError'));
    }
  };

  const addBot = async () => {
    if (!selected || !addBotId) return;
    setError('');
    try {
      const { added } = await window.openBot.addBotToGroupChat({ groupId: selected.id, botId: addBotId });
      if (added) {
        setGroups((prev) =>
          prev.map((g) => (g.id === selected.id ? { ...g, botIds: [...g.botIds, addBotId] } : g)),
        );
        setAddBotId('');
      }
    } catch {
      // v0.73: this used to show group.loadError ("Could not load
      // group chats") for a failed ADD — a load never happened
      // here, so the message blamed the wrong operation.
      setError(t('group.addError'));
    }
  };

  const deleteGroup = () => {
    if (!selected) return;
    setPendingConfirm({
      title: t('group.title'),
      message: t('group.deleteConfirm', { name: selected.name }),
      confirmLabel: t('group.delete'),
      onConfirm: () => void doDeleteGroup(selected),
    });
  };

  const doDeleteGroup = async (group: GroupChatView) => {
    setError('');
    try {
      await window.openBot.deleteGroupChat({ groupId: group.id });
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
      setSelectedId(null);
    } catch {
      // v0.73: same wrong-message bug as addBot — a failed DELETE
      // used to report group.loadError.
      setError(t('group.deleteError'));
    }
  };

  // v0.94c: pick image attachments — vision images only (PNG/JPEG/
  // GIF/WebP), same limits as ChatView: max 5 images, 10 MB each,
  // 20 MB total. A violation shows a notice and skips that file.
  const addFiles = async (files: File[] | FileList) => {
    const list = [...files];
    let next = attachments;
    for (const file of list) {
      if (!visionMimeTypeForFile(file.name)) {
        setAttachNotice(t('group.attachImageUnsupported', { name: file.name }));
        continue;
      }
      const imageCount = next.filter((a) => a.kind === 'image').length;
      if (imageCount >= VISION_MAX_IMAGES) {
        setAttachNotice(t('group.attachImageTooMany', { max: String(VISION_MAX_IMAGES), name: file.name }));
        continue;
      }
      if (file.size > VISION_MAX_IMAGE_BYTES) {
        setAttachNotice(
          t('group.attachImageTooLarge', {
            name: file.name,
            size: formatFileSize(file.size),
            max: formatFileSize(VISION_MAX_IMAGE_BYTES),
          }),
        );
        continue;
      }
      const imagesTotal = next.filter((a) => a.kind === 'image').reduce((sum, a) => sum + a.size, 0);
      if (imagesTotal + file.size > VISION_MAX_TOTAL_BYTES) {
        setAttachNotice(
          t('group.attachImagesTooLargeTotal', {
            max: formatFileSize(VISION_MAX_TOTAL_BYTES),
            name: file.name,
          }),
        );
        continue;
      }
      try {
        const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
        next = [
          ...next,
          {
            name: file.name,
            size: file.size,
            kind: 'image',
            relPath: null,
            content: null,
            truncated: false,
            takenBytes: 0,
            totalBytes: file.size,
            readError: false,
            dataBase64,
          },
        ];
      } catch {
        setAttachNotice(t('group.attachImageUnreadable', { name: file.name }));
      }
    }
    setAttachments(next);
  };

  const removeAttachment = (name: string) => {
    setAttachments((prev) => prev.filter((a) => a.name !== name));
  };

  const send = async () => {
    if (!selected || sending) return;
    const trimmed = text.trim();
    // v0.94c: an image-only message sends with no text (like the regular chat).
    if (!trimmed && attachments.length === 0) return;
    const visionCheck = validateVisionItems(attachments);
    if (!visionCheck.ok) {
      if (visionCheck.reason === 'too-many-images') {
        setAttachNotice(t('group.attachImageTooMany', { max: String(VISION_MAX_IMAGES), name: visionCheck.name }));
      } else if (visionCheck.reason === 'image-too-large') {
        setAttachNotice(
          t('group.attachImageTooLarge', {
            name: visionCheck.name,
            size: formatFileSize(visionCheck.size),
            max: formatFileSize(VISION_MAX_IMAGE_BYTES),
          }),
        );
      } else if (visionCheck.reason === 'images-too-large-total') {
        setAttachNotice(
          t('group.attachImagesTooLargeTotal', {
            max: formatFileSize(VISION_MAX_TOTAL_BYTES),
            name: visionCheck.name,
          }),
        );
      } else if (visionCheck.reason === 'image-format-unsupported') {
        setAttachNotice(t('group.attachImageUnsupported', { name: visionCheck.name }));
      } else {
        setAttachNotice(t('group.attachImageUnreadable', { name: visionCheck.name }));
      }
      return;
    }
    setSending(true);
    setError('');
    setAttachNotice(null);
    try {
      const vision = buildVisionAttachments(attachments);
      await window.openBot.postGroupMessage({
        groupId: selected.id,
        text: trimmed,
        ...(vision.length > 0 ? { attachments: vision } : {}),
      });
      setText('');
      setAttachments([]);
      await loadMessages(selected.id);
      // v0.79a: a delegation may still be running after post returns
      // (post waits for the runs — but a busy bot queues its run);
      // refresh the status right away so the running dot does not lag
      // one poll cycle behind.
      await loadStatus(selected.id);
    } catch {
      setError(t('group.sendError'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="group-layout">
      <div className="group-side">
        <h2 style={{ marginTop: 0 }}>{t('group.title')}</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createGroup();
            }}
            placeholder={t('group.createPlaceholder')}
            aria-label={t('group.nameLabel')}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="btn" onClick={() => void createGroup()} disabled={!newName.trim()}>
            {t('group.create')}
          </button>
        </div>
        {groupsLoading ? (
          <p className="hint" data-testid="groups-loading">{t('group.loading')}</p>
        ) : (
          groups.length === 0 && <p className="empty">{t('group.noGroups')}</p>
        )}
        {groups.map((g) => (
          <div key={g.id} className={`bot-item ${g.id === selectedId ? 'active' : ''}`}>
            <button className="bot-item" style={{ border: 'none', padding: 0 }} onClick={() => setSelectedId(g.id)} title={g.name}>
              <span className="name">{g.name}</span>
            </button>
          </div>
        ))}
        <div style={{ marginTop: 16 }}>
          <button className="btn secondary" onClick={onBack}>{t('group.back')}</button>
        </div>
      </div>
      <div className="group-main">
        {error && <p className="error">{error}</p>}
        {loadError && (
          <>
            <p className="error">{loadError}</p>
            <button className="btn secondary" data-testid="groups-retry" onClick={() => void reloadGroups()}>
              {t('group.retry')}
            </button>
          </>
        )}
        {!selected ? (
          groupsLoading ? (
            <p className="hint" data-testid="groups-loading">{t('group.loading')}</p>
          ) : (
            <p className="empty">{t('group.noGroups')}</p>
          )
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <h3 style={{ margin: 0, flex: 1 }}>{selected.name}</h3>
              <button className="btn secondary" onClick={() => void deleteGroup()}>
                {t('group.delete')}
              </button>
            </div>
            {/* v0.79a: status of each member — green dot + "running"
                for a bot on a delegation, grey + "idle" for the rest
                (same dot convention as the sidebar, see `.bot-status`). */}
            <p className="hint" style={{ margin: '0 0 8px' }}>
              {t('group.members')}:{' '}
              {memberBots.length > 0
                ? memberBots.map((b, i) => {
                    const running = statuses.some((s) => s.botId === b.id);
                    return (
                      <span key={b.id}>
                        {i > 0 ? ', ' : ''}
                        <span
                          className={`bot-status ${running ? 'running' : 'idle'}`}
                          data-testid={running ? 'group-member-running' : 'group-member-idle'}
                          data-bot-id={b.id}
                          title={running ? t('group.botRunning') : t('group.botIdle')}
                        >
                          ●
                        </span>{' '}
                        {b.name}
                      </span>
                    );
                  })
                : '—'}
            </p>
            <div className="row" style={{ marginBottom: 12 }}>
              <select
                value={addBotId}
                onChange={(e) => setAddBotId(e.target.value)}
                aria-label={t('group.addBot')}
                style={{ flex: 1, minWidth: 0 }}
              >
                <option value="">{t('group.selectBot')}</option>
                {addableBots.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
              <button className="btn secondary" onClick={() => void addBot()} disabled={!addBotId}>
                {t('group.addBot')}
              </button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, marginBottom: 12 }}>
              {messagesLoading ? (
                <p className="hint" data-testid="group-messages-loading">{t('group.messagesLoading')}</p>
              ) : (
                messages.length === 0 && <p className="empty">{t('group.empty')}</p>
              )}
              {messages.map((m) => (
                <div key={m.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    <strong style={{ color: 'var(--text)' }}>{m.botId ? m.botName : t('group.you')}</strong>
                    {m.delegated ? ` · ${t('group.delegated')}` : ''}
                    {' · '}
                    {new Date(m.createdAt).toLocaleString()}
                  </div>
                  {/* v0.94c: attached-image thumbnails (lazy IPC load);
                      a missing/broken file shows a placeholder instead
                      of a broken image. */}
                  {(m.attachments ?? []).length > 0 && (
                    <div className="msg-images" style={{ marginTop: 6 }}>
                      {(m.attachments ?? []).map((att) =>
                        thumbUrls[att.id] ? (
                          <img
                            key={att.id}
                            className="msg-image-thumb"
                            src={thumbUrls[att.id]}
                            alt={att.name ?? t('group.attachedImageFallback')}
                            title={att.name ?? t('group.attachedImageFallback')}
                            data-testid={`group-thumb-${att.id}`}
                          />
                        ) : (
                          <div
                            key={att.id}
                            className="msg-image-unavailable"
                            title={att.name ?? t('group.attachedImageFallback')}
                            data-testid={`group-thumb-missing-${att.id}`}
                          >
                            <span aria-hidden="true">🖼️</span>
                            <span>{att.name ?? t('group.attachedImageFallback')}</span>
                            {thumbMissing[att.id] ? <span>{t('group.imageUnavailable')}</span> : null}
                          </div>
                        ),
                      )}
                    </div>
                  )}
                  {m.text ? (
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>
                  ) : null}
                </div>
              ))}
            </div>
            {/* v0.79a: the "replying…" line — names of the bots
                currently running in this group, shown right under the
                message list (no waiting for a new message to arrive). */}
            {statuses.length > 0 && (
              <p className="status" data-testid="group-typing" style={{ margin: '0 0 6px' }}>
                {t('group.typing', {
                  names: statuses
                    .map((s) => memberBots.find((b) => b.id === s.botId)?.name ?? s.botId)
                    .join(', '),
                })}
              </p>
            )}
            {/* v0.82: bot cut short when the app stopped — warning +
                Dismiss button (NOT "replying": the old process is dead). */}
            {interrupted.map((e) => (
              <p
                key={e.botId}
                className="hint"
                data-testid={`group-interrupted-${e.botId}`}
                style={{ margin: '0 0 6px' }}
              >
                {'⚠️ '}
                {t('group.botInterrupted', {
                  name: memberBots.find((b) => b.id === e.botId)?.name ?? e.botId,
                })}
                {' '}
                <button
                  type="button"
                  className="btn secondary"
                  data-testid={`dismiss-interrupted-${e.botId}`}
                  onClick={() => {
                    if (selectedId) void dismissInterrupted(selectedId, e.botId);
                  }}
                >
                  {t('group.botInterruptedDismiss')}
                </button>
              </p>
            ))}
            <p className="hint" style={{ margin: '0 0 6px' }}>{t('group.mentionHint')}</p>
            {/* v0.94c: chips for the picked images (remove one by one)
                + a notice when an image breaks a vision limit. */}
            {attachments.length > 0 && (
              <div className="composer-chips" style={{ marginBottom: 6, flexWrap: 'wrap' }} data-testid="group-attach-chips">
                {attachments.map((a) => (
                  <span key={a.name} className="composer-chip">
                    <span className="composer-chip-name">🖼️ {a.name}</span>
                    <span className="composer-chip-size">{formatFileSize(a.size)}</span>
                    <button
                      type="button"
                      className="composer-chip-remove"
                      aria-label={t('group.attachRemove', { name: a.name })}
                      data-testid={`group-attach-remove-${a.name}`}
                      onClick={() => removeAttachment(a.name)}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachNotice && (
              <p className="hint" data-testid="group-attach-notice" style={{ margin: '0 0 6px' }}>
                {attachNotice}
              </p>
            )}
            <div className="row">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                style={{ display: 'none' }}
                data-testid="group-attach-input"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="btn secondary"
                aria-label={t('group.attach')}
                title={t('group.attach')}
                data-testid="group-attach-button"
                onClick={() => fileInputRef.current?.click()}
              >
                📎
              </button>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void send();
                }}
                placeholder={t('group.messagePlaceholder')}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                className="btn"
                onClick={() => void send()}
                disabled={(!text.trim() && attachments.length === 0) || sending}
                data-testid="group-send-button"
              >
                {t('group.send')}
              </button>
            </div>
          </>
        )}
      </div>
      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          confirmLabel={pendingConfirm.confirmLabel}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => {
            const c = pendingConfirm;
            setPendingConfirm(null);
            c.onConfirm();
          }}
        />
      )}
    </div>
  );
}
