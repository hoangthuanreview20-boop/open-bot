/**
 * MemoryBlocksView — memory block management (v0.96, Team T1).
 *
 * Lists blocks per bot (attached first, detached after), view/edit/
 * delete, attach/detach, share with all bots, read-only toggle, MemFS
 * export/import (Markdown) and consolidation. Everything local: blocks
 * live in `<workspace>/.open-bot/memory-blocks.json`, export goes to
 * `<userData>/memory-blocks/*.md`.
 *
 * Props follow the MemoryView pattern (bots + botId + onSelectBot).
 * Mounted inside MemoryView under the "Memory blocks" tab.
 */
import { useEffect, useState } from 'react';
import { useT } from '../i18n/useT';
import type { BotConfigLike, MemoryBlockView, MemoryConsolidateView } from '../types';

interface Props {
  bots: BotConfigLike[];
  botId: string | null;
  onSelectBot: (id: string) => void;
}

export default function MemoryBlocksView({ bots, botId, onSelectBot }: Props) {
  const t = useT();
  const [blocks, setBlocks] = useState<MemoryBlockView[]>([]);
  const [consolidateStatus, setConsolidateStatus] = useState<MemoryConsolidateView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newContent, setNewContent] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCharLimit, setEditCharLimit] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [shareTargetId, setShareTargetId] = useState('');

  const activeBot = bots.find((b) => b.id === botId) ?? bots[0] ?? null;

  const load = async (id: string | null) => {
    if (!id) {
      setBlocks([]);
      setConsolidateStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [list, status] = await Promise.all([
        window.openBot.listMemoryBlocks({ botId: id, includeDetached: true }),
        window.openBot.consolidateMemory({ botId: id, action: 'status' }),
      ]);
      setBlocks(list);
      setConsolidateStatus(status);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.loadError'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(activeBot?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBot?.id]);

  const refresh = () => {
    setNotice('');
    void load(activeBot?.id ?? null);
  };

  const create = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const created = await window.openBot.createMemoryBlock({
        botId: activeBot.id,
        label: newLabel.trim(),
        description: newDescription.trim(),
        content: newContent,
      });
      setBlocks((prev) => [...prev, created].sort((a, b) => a.label.localeCompare(b.label)));
      setNewLabel('');
      setNewDescription('');
      setNewContent('');
      setNotice(t('memoryBlock.created'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.createError'));
    }
  };

  const startEdit = (block: MemoryBlockView) => {
    setEditingId(block.id);
    setEditContent(block.content);
    setEditDescription(block.description);
    setEditCharLimit(String(block.charLimit));
    setConfirmDeleteId('');
    setNotice('');
  };

  const saveEdit = async (block: MemoryBlockView) => {
    if (!activeBot) return;
    setError('');
    try {
      const limit = Number(editCharLimit);
      const updated = await window.openBot.updateMemoryBlock({
        botId: activeBot.id,
        id: block.id,
        content: editContent,
        description: editDescription,
        ...(Number.isFinite(limit) && limit > 0 ? { charLimit: Math.floor(limit) } : {}),
      });
      setBlocks((prev) => prev.map((b) => (b.id === block.id ? updated : b)));
      setEditingId('');
      setNotice(t('memoryBlock.updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.saveError'));
    }
  };

  const remove = async (block: MemoryBlockView) => {
    if (!activeBot) return;
    setError('');
    try {
      const res = await window.openBot.deleteMemoryBlock({ botId: activeBot.id, id: block.id });
      if (res.deleted) {
        setBlocks((prev) => prev.filter((b) => b.id !== block.id));
        setNotice(t('memoryBlock.deleted'));
      } else {
        setError(t('memoryBlock.deleteError'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.deleteError'));
    } finally {
      setConfirmDeleteId('');
    }
  };

  const toggleAttach = async (block: MemoryBlockView, attached: boolean) => {
    if (!activeBot) return;
    setError('');
    try {
      const updated = attached
        ? await window.openBot.detachMemoryBlock({ botId: activeBot.id, blockId: block.id })
        : await window.openBot.attachMemoryBlock({ botId: activeBot.id, blockId: block.id });
      setBlocks((prev) => prev.map((b) => (b.id === block.id ? updated : b)));
      setNotice(attached ? t('memoryBlock.detachedMsg') : t('memoryBlock.attachedMsg'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.saveError'));
    }
  };

  const share = async (block: MemoryBlockView, all: boolean) => {
    if (!activeBot) return;
    setError('');
    try {
      if (all) {
        await window.openBot.shareMemoryBlock({
          botId: activeBot.id,
          blockId: block.id,
          all: true,
          botIds: bots.map((b) => b.id),
        });
      } else {
        if (!shareTargetId) return;
        await window.openBot.shareMemoryBlock({
          botId: activeBot.id,
          blockId: block.id,
          targetBotId: shareTargetId,
        });
      }
      setNotice(t('memoryBlock.sharedMsg'));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.saveError'));
    }
  };

  const toggleReadOnly = async (block: MemoryBlockView) => {
    if (!activeBot) return;
    setError('');
    try {
      const updated = await window.openBot.setMemoryBlockReadOnly({
        botId: activeBot.id,
        id: block.id,
        readOnly: !block.readOnly,
      });
      setBlocks((prev) => prev.map((b) => (b.id === block.id ? updated : b)));
      setNotice(t('memoryBlock.updated'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.saveError'));
    }
  };

  const exportAll = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const res = await window.openBot.exportMemoryBlocks({ botId: activeBot.id });
      setNotice(t('memoryBlock.exported', { count: res.files.length, dir: res.dir }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.exportError'));
    }
  };

  const importAll = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const res = await window.openBot.importMemoryBlocks({ botId: activeBot.id });
      setNotice(
        t('memoryBlock.imported', {
          imported: res.blocks.imported,
          updated: res.blocks.updated,
          skipped: res.blocks.skipped,
        }),
      );
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.importError'));
    }
  };

  const runConsolidate = async () => {
    if (!activeBot) return;
    setError('');
    try {
      const res = await window.openBot.consolidateMemory({ botId: activeBot.id, action: 'run' });
      setConsolidateStatus(res);
      setNotice(
        t('memoryBlock.consolidateDone', {
          deduped: res.deduped ?? 0,
          conflicts: res.conflictsResolved ?? 0,
          promoted: res.promoted ?? 0,
          archived: res.archived ?? 0,
        }),
      );
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('memoryBlock.consolidateError'));
    }
  };

  const isAttached = (block: MemoryBlockView): boolean =>
    activeBot !== null && block.attachedBots.includes(activeBot.id);
  const attached = blocks.filter(isAttached);
  const detached = blocks.filter((b) => !isAttached(b));
  const botName = (id: string): string => bots.find((b) => b.id === id)?.name ?? id;

  return (
    <div>
      <p className="hint">{t('memoryBlock.intro')}</p>
      <p className="hint">{t('memoryBlock.localOnly')}</p>
      {consolidateStatus && (
        <p className="hint" data-testid="memory-blocks-consolidate-status">
          {t('memoryBlock.consolidateStatus', {
            enabled: consolidateStatus.enabled
              ? t('memoryBlock.consolidateOn')
              : t('memoryBlock.consolidateOff'),
            idle: consolidateStatus.idleMinutes ?? 30,
            last: consolidateStatus.lastRunAt ?? t('memoryBlock.never'),
          })}
        </p>
      )}
      <div className="row">
        <label>
          {t('memoryBlock.bot')}
          <select
            value={activeBot?.id ?? ''}
            data-testid="memory-blocks-bot-select"
            onChange={(e) => onSelectBot(e.target.value)}
          >
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn secondary" data-testid="memory-blocks-export" onClick={() => void exportAll()} disabled={!activeBot}>
          {t('memoryBlock.export')}
        </button>
        <button className="btn secondary" data-testid="memory-blocks-import" onClick={() => void importAll()} disabled={!activeBot}>
          {t('memoryBlock.import')}
        </button>
        <button className="btn secondary" data-testid="memory-blocks-consolidate" onClick={() => void runConsolidate()} disabled={!activeBot}>
          {t('memoryBlock.consolidateRun')}
        </button>
      </div>
      {loading && <p className="hint" data-testid="memory-blocks-loading">{t('memoryBlock.loading')}</p>}
      {error && <p className="error">{error}</p>}
      {notice && <p className="hint" data-testid="memory-blocks-notice">{notice}</p>}
      {!loading && !activeBot && <p className="hint">{t('memoryBlock.noBot')}</p>}
      {activeBot && (
        <>
          <h3>{t('memoryBlock.createTitle')}</h3>
          <div className="row">
            <label style={{ flex: 1 }}>
              {t('memoryBlock.label')}
              <input
                type="text"
                value={newLabel}
                data-testid="memory-blocks-new-label"
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t('memoryBlock.labelPlaceholder')}
              />
            </label>
            <label style={{ flex: 2 }}>
              {t('memoryBlock.description')}
              <input
                type="text"
                value={newDescription}
                data-testid="memory-blocks-new-description"
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t('memoryBlock.descriptionPlaceholder')}
              />
            </label>
          </div>
          <label>
            {t('memoryBlock.content')}
            <textarea
              value={newContent}
              data-testid="memory-blocks-new-content"
              onChange={(e) => setNewContent(e.target.value)}
              rows={3}
              placeholder={t('memoryBlock.contentPlaceholder')}
            />
          </label>
          <div className="row">
            <button className="btn" data-testid="memory-blocks-create" onClick={() => void create()} disabled={newLabel.trim() === ''}>
              {t('memoryBlock.create')}
            </button>
          </div>
          {!loading && blocks.length === 0 && (
            <p className="hint" data-testid="memory-blocks-empty">{t('memoryBlock.empty')}</p>
          )}
          {attached.length > 0 && (
            <>
              <h3>{t('memoryBlock.attachedTitle')}</h3>
              <ul data-testid="memory-blocks-attached-list">
                {attached.map((block) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    attached
                    bots={bots}
                    activeBotId={activeBot.id}
                    shareTargetId={shareTargetId}
                    onShareTarget={setShareTargetId}
                    editingId={editingId}
                    editContent={editContent}
                    editDescription={editDescription}
                    editCharLimit={editCharLimit}
                    onEditContent={setEditContent}
                    onEditDescription={setEditDescription}
                    onEditCharLimit={setEditCharLimit}
                    confirmDeleteId={confirmDeleteId}
                    onStartEdit={() => startEdit(block)}
                    onSaveEdit={() => void saveEdit(block)}
                    onCancelEdit={() => setEditingId('')}
                    onToggleAttach={() => void toggleAttach(block, true)}
                    onShareAll={() => void share(block, true)}
                    onShareOne={() => void share(block, false)}
                    onToggleReadOnly={() => void toggleReadOnly(block)}
                    onConfirmDelete={() => setConfirmDeleteId(block.id)}
                    onCancelDelete={() => setConfirmDeleteId('')}
                    onDelete={() => void remove(block)}
                  />
                ))}
              </ul>
            </>
          )}
          {detached.length > 0 && (
            <>
              <h3>{t('memoryBlock.detachedTitle')}</h3>
              <ul data-testid="memory-blocks-detached-list">
                {detached.map((block) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    attached={false}
                    bots={bots}
                    activeBotId={activeBot.id}
                    shareTargetId={shareTargetId}
                    onShareTarget={setShareTargetId}
                    editingId={editingId}
                    editContent={editContent}
                    editDescription={editDescription}
                    editCharLimit={editCharLimit}
                    onEditContent={setEditContent}
                    onEditDescription={setEditDescription}
                    onEditCharLimit={setEditCharLimit}
                    confirmDeleteId={confirmDeleteId}
                    onStartEdit={() => startEdit(block)}
                    onSaveEdit={() => void saveEdit(block)}
                    onCancelEdit={() => setEditingId('')}
                    onToggleAttach={() => void toggleAttach(block, false)}
                    onShareAll={() => void share(block, true)}
                    onShareOne={() => void share(block, false)}
                    onToggleReadOnly={() => void toggleReadOnly(block)}
                    onConfirmDelete={() => setConfirmDeleteId(block.id)}
                    onCancelDelete={() => setConfirmDeleteId('')}
                    onDelete={() => void remove(block)}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}

interface BlockRowProps {
  block: MemoryBlockView;
  attached: boolean;
  bots: BotConfigLike[];
  activeBotId: string;
  shareTargetId: string;
  onShareTarget: (id: string) => void;
  editingId: string;
  editContent: string;
  editDescription: string;
  editCharLimit: string;
  onEditContent: (v: string) => void;
  onEditDescription: (v: string) => void;
  onEditCharLimit: (v: string) => void;
  confirmDeleteId: string;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onToggleAttach: () => void;
  onShareAll: () => void;
  onShareOne: () => void;
  onToggleReadOnly: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}

function BlockRow(props: BlockRowProps) {
  const t = useT();
  const { block } = props;
  const botName = (id: string): string => props.bots.find((b) => b.id === id)?.name ?? id;
  const otherBots = props.bots.filter((b) => b.id !== props.activeBotId);
  return (
    <li key={block.id} className="card" data-testid={`memory-block-row-${block.id}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{block.label}</strong>
        <span className="hint">
          {props.attached ? t('memoryBlock.attached') : t('memoryBlock.detached')}
          {block.readOnly ? ` · ${t('memoryBlock.readOnly')}` : ''}
          {block.attachedBots.length > 1
            ? ` · ${t('memoryBlock.sharedWith', { count: block.attachedBots.length })}`
            : ''}
        </span>
      </div>
      {block.description && <p className="hint">{block.description}</p>}
      {props.editingId === block.id ? (
        <>
          <label>
            {t('memoryBlock.description')}
            <input
              type="text"
              value={props.editDescription}
              data-testid={`memory-block-edit-description-${block.id}`}
              onChange={(e) => props.onEditDescription(e.target.value)}
            />
          </label>
          <textarea
            value={props.editContent}
            data-testid={`memory-block-edit-content-${block.id}`}
            onChange={(e) => props.onEditContent(e.target.value)}
            rows={4}
          />
          <label>
            {t('memoryBlock.charLimit')}
            <input
              type="number"
              value={props.editCharLimit}
              data-testid={`memory-block-edit-limit-${block.id}`}
              onChange={(e) => props.onEditCharLimit(e.target.value)}
            />
          </label>
          <div className="row">
            <button className="btn" data-testid={`memory-block-save-${block.id}`} onClick={props.onSaveEdit}>
              {t('memoryBlock.save')}
            </button>
            <button className="btn secondary" onClick={props.onCancelEdit}>
              {t('memoryBlock.cancel')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ whiteSpace: 'pre-wrap' }}>{block.content}</p>
          <p className="hint">
            {t('memoryBlock.meta', {
              version: block.version,
              used: block.content.length,
              limit: block.charLimit,
              updated: block.updatedAt.slice(0, 10),
            })}
            {block.attachedBots.length > 0
              ? ` · ${t('memoryBlock.attachedBots')}: ${block.attachedBots.map(botName).join(', ')}`
              : ''}
          </p>
          <div className="row">
            <button
              className="btn secondary"
              data-testid={`memory-block-edit-${block.id}`}
              onClick={props.onStartEdit}
              disabled={block.readOnly}
            >
              {t('memoryBlock.edit')}
            </button>
            <button
              className="btn secondary"
              data-testid={`memory-block-attach-${block.id}`}
              onClick={props.onToggleAttach}
            >
              {props.attached ? t('memoryBlock.detach') : t('memoryBlock.attach')}
            </button>
            <button
              className="btn secondary"
              data-testid={`memory-block-share-all-${block.id}`}
              onClick={props.onShareAll}
            >
              {t('memoryBlock.shareAll')}
            </button>
            {otherBots.length > 0 && (
              <label>
                {t('memoryBlock.shareTo')}
                <select
                  value={props.shareTargetId}
                  data-testid={`memory-block-share-target-${block.id}`}
                  onChange={(e) => props.onShareTarget(e.target.value)}
                >
                  <option value="">{t('memoryBlock.chooseBot')}</option>
                  {otherBots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {otherBots.length > 0 && (
              <button
                className="btn secondary"
                data-testid={`memory-block-share-one-${block.id}`}
                onClick={props.onShareOne}
                disabled={props.shareTargetId === ''}
              >
                {t('memoryBlock.share')}
              </button>
            )}
            <button
              className="btn secondary"
              data-testid={`memory-block-readonly-${block.id}`}
              onClick={props.onToggleReadOnly}
            >
              {block.readOnly ? t('memoryBlock.unsetReadOnly') : t('memoryBlock.setReadOnly')}
            </button>
            {props.confirmDeleteId === block.id ? (
              <>
                <button className="btn" data-testid={`memory-block-delete-confirm-${block.id}`} onClick={props.onDelete}>
                  {t('memoryBlock.deleteConfirm')}
                </button>
                <button className="btn secondary" onClick={props.onCancelDelete}>
                  {t('memoryBlock.cancel')}
                </button>
              </>
            ) : (
              <button
                className="btn secondary"
                data-testid={`memory-block-delete-${block.id}`}
                onClick={props.onConfirmDelete}
                disabled={block.readOnly}
              >
                {t('memoryBlock.delete')}
              </button>
            )}
          </div>
        </>
      )}
    </li>
  );
}
