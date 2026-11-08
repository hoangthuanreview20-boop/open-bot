import { useEffect, useRef, useState } from 'react';
import type { BotConfigLike, ChatMessageView, ToolCallView } from '../types';

export type ChatStatus = 'idle' | 'thinking' | 'tool';

export interface ToolEvent {
  id: string;
  call: ToolCallView;
  result?: unknown;
  done: boolean;
}

interface Props {
  bot: BotConfigLike | null;
  messages: ChatMessageView[];
  status: ChatStatus;
  toolEvents: ToolEvent[];
  onSend: (text: string) => void;
}

function toolLabel(call: ToolCallView): string {
  return String(call.name ?? call.tool ?? 'tool');
}

export default function ChatView({ bot, messages, status, toolEvents, onSend }: Props) {
  const [input, setInput] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, toolEvents, status]);

  if (!bot) {
    return (
      <div className="main">
        <div className="empty">Chọn một bot ở cột bên trái, hoặc tạo bot mới để bắt đầu trò chuyện.</div>
      </div>
    );
  }

  const send = () => {
    const text = input.trim();
    if (!text || status !== 'idle') return;
    setInput('');
    onSend(text);
  };

  return (
    <div className="main">
      <header className="chat-header">
        <div>
          <h2>{bot.name}</h2>
          <span className="sub">{bot.providerId} · {bot.model || 'model mặc định'}{bot.autoApprove ? ' · tự duyệt tool' : ''}</span>
        </div>
      </header>

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <p className="empty">Chưa có tin nhắn nào. Hãy chào {bot.name} nhé!</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {toolEvents.map((ev) => (
          <details key={ev.id} className="tool-card" open={!ev.done}>
            <summary>
              🔧 {toolLabel(ev.call)} {ev.done ? '— xong' : '— đang chạy…'}
            </summary>
            <pre>{JSON.stringify(ev.call.args ?? ev.call.arguments ?? ev.call, null, 2)}</pre>
            {ev.done && ev.result !== undefined && (
              <pre className="result">Kết quả: {typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result, null, 2)}</pre>
            )}
          </details>
        ))}
        {status === 'thinking' && <div className="status">💭 Đang suy nghĩ…</div>}
        {status === 'tool' && <div className="status">🔧 Đang chạy công cụ…</div>}
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Nhắn cho bot… (Enter để gửi, Shift+Enter để xuống dòng)"
          disabled={status !== 'idle'}
        />
        <button className="btn" onClick={send} disabled={status !== 'idle' || !input.trim()}>
          Gửi
        </button>
      </div>
    </div>
  );
}
