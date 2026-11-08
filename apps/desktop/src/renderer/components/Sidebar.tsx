import type { BotConfigLike } from '../types';

interface Props {
  bots: BotConfigLike[];
  selectedBotId: string | null;
  onSelect: (botId: string) => void;
  onCreate: () => void;
  onEdit: (bot: BotConfigLike) => void;
  onDelete: (bot: BotConfigLike) => void;
  onOpenSettings: () => void;
}

export default function Sidebar({ bots, selectedBotId, onSelect, onCreate, onEdit, onDelete, onOpenSettings }: Props) {
  return (
    <aside className="sidebar">
      <h1>🤖 Open Bot</h1>
      <button className="btn" onClick={onCreate}>+ Tạo bot mới</button>
      <h2>Bot của bạn</h2>
      {bots.length === 0 && <p className="empty">Chưa có bot nào.</p>}
      {bots.map((bot) => (
        <div key={bot.id} className={`bot-item ${bot.id === selectedBotId ? 'active' : ''}`}>
          <button className="bot-item" style={{ border: 'none', padding: 0 }} onClick={() => onSelect(bot.id)} title={bot.name}>
            <span className="name">
              {bot.name}
              <span className="meta">{bot.providerId} · {bot.model || 'mặc định'}</span>
            </span>
          </button>
          <button className="icon-btn" title="Sửa bot" onClick={() => onEdit(bot)}>✏️</button>
          <button className="icon-btn" title="Xoá bot" onClick={() => onDelete(bot)}>🗑️</button>
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <button className="btn secondary" onClick={onOpenSettings}>⚙️ Cài đặt &amp; API key</button>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '4px 0 0' }}>
        Chạy local-first trên máy của bạn. API key chỉ lưu ở máy này.
      </p>
    </aside>
  );
}
