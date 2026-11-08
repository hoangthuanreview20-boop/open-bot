import { useState } from 'react';
import type { BotConfigLike } from '../types';
import { PROVIDER_META } from './SettingsView';

interface Props {
  initial: BotConfigLike | null; // null = tạo mới
  onSave: (config: Partial<BotConfigLike> & { id?: string }) => Promise<void>;
  onCancel: () => void;
}

export default function BotForm({ initial, onSave, onCancel }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [providerId, setProviderId] = useState(initial?.providerId ?? 'xai');
  const [model, setModel] = useState(initial?.model ?? 'grok-4.7');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? '');
  const [workspaceDir, setWorkspaceDir] = useState(initial?.workspaceDir ?? '');
  const [autoApprove, setAutoApprove] = useState(initial?.autoApprove ?? false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      setError('Vui lòng nhập tên bot.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave({
        ...(initial ? { id: initial.id } : {}),
        name: name.trim(),
        providerId,
        model: model.trim(),
        systemPrompt,
        workspaceDir: workspaceDir.trim(),
        autoApprove,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không lưu được bot.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Sửa bot' : 'Tạo bot mới'}</h2>

        <div className="field">
          <label htmlFor="bot-name">Tên bot</label>
          <input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="vd: Trợ lý" />
        </div>

        <div className="field">
          <label htmlFor="bot-provider">Provider</label>
          <select id="bot-provider" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            {PROVIDER_META.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="bot-model">Model</label>
          <input id="bot-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="vd: grok-4.7" />
          <p className="hint">Để trống để dùng model mặc định của provider (trong Cài đặt).</p>
        </div>

        <div className="field">
          <label htmlFor="bot-prompt">System prompt</label>
          <textarea
            id="bot-prompt"
            rows={4}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Bot này làm gì, trả lời theo phong cách nào…"
          />
        </div>

        <div className="field">
          <label htmlFor="bot-workspace">Thư mục làm việc (workspace)</label>
          <input
            id="bot-workspace"
            value={workspaceDir}
            onChange={(e) => setWorkspaceDir(e.target.value)}
            placeholder="Để trống: dùng thư mục mặc định của app"
          />
        </div>

        <div className="field">
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            Tự động duyệt tool call (không hỏi trước)
          </label>
          <p className="hint">Bật tùy chọn này chỉ khi bạn tin tưởng bot và các công cụ của nó.</p>
        </div>

        {error && <p className="error">{error}</p>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={onCancel}>Huỷ</button>
          <button className="btn" onClick={submit} disabled={saving}>{saving ? 'Đang lưu…' : 'Lưu'}</button>
        </div>
      </div>
    </div>
  );
}
