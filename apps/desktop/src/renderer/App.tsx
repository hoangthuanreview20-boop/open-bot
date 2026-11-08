import { useCallback, useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import ChatView, { type ChatStatus, type ToolEvent } from './components/ChatView';
import TaskPanel from './components/TaskPanel';
import ApprovalCard from './components/ApprovalCard';
import SettingsView from './components/SettingsView';
import BotForm from './components/BotForm';
import type { ApprovalRequest, BotConfigLike, ChatMessageView, TaskView } from './types';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function App() {
  const [bots, setBots] = useState<BotConfigLike[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [formBot, setFormBot] = useState<BotConfigLike | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loadError, setLoadError] = useState('');

  const selectedBotIdRef = useRef<string | null>(null);
  selectedBotIdRef.current = selectedBotId;

  const loadBots = useCallback(async () => {
    try {
      const list = await window.openBot.listBots();
      setBots(list);
      if (list.length > 0 && !selectedBotIdRef.current) {
        setSelectedBotId(list[0].id);
      }
      return list;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Không tải được danh sách bot.');
      return [];
    }
  }, []);

  const loadHistory = useCallback(async (botId: string) => {
    try {
      const rows = await window.openBot.getHistory(botId, 50);
      setMessages(rows);
    } catch {
      setMessages([]);
    }
  }, []);

  const loadTasks = useCallback(async (botId: string) => {
    setTasksLoading(true);
    try {
      setTasks(await window.openBot.listTasks(botId));
    } catch {
      setTasks([]);
    } finally {
      setTasksLoading(false);
    }
  }, []);

  // Nạp bot lần đầu.
  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  // Đổi bot -> nạp lịch sử + task.
  useEffect(() => {
    if (!selectedBotId) return;
    setMessages([]);
    setToolEvents([]);
    setApprovals([]);
    setStatus('idle');
    void loadHistory(selectedBotId);
    void loadTasks(selectedBotId);
  }, [selectedBotId, loadHistory, loadTasks]);

  // Đăng ký stream từ main (chỉ 1 lần).
  useEffect(() => {
    const offDelta = window.openBot.onChatDelta(({ botId, delta }) => {
      if (botId !== selectedBotIdRef.current) return;
      setStatus('thinking');
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
        }
        return [...prev, { id: uid(), role: 'assistant', text: delta, createdAt: Date.now() }];
      });
    });
    const offToolCall = window.openBot.onToolCall(({ botId, call }) => {
      if (botId !== selectedBotIdRef.current) return;
      setStatus('tool');
      setToolEvents((prev) => [...prev, { id: uid(), call, done: false }]);
    });
    const offToolResult = window.openBot.onToolResult(({ botId, result }) => {
      if (botId !== selectedBotIdRef.current) return;
      setStatus('thinking');
      setToolEvents((prev) => {
        // Match by call id (ToolResult.callId); fall back to the newest open event.
        let i = prev.findIndex((ev) => !ev.done && ev.call.id === result.callId);
        if (i === -1) {
          const rev = [...prev].reverse().findIndex((ev) => !ev.done);
          i = rev === -1 ? -1 : prev.length - 1 - rev;
        }
        if (i === -1) return prev;
        const next = [...prev];
        next[i] = { ...next[i], result, done: true };
        return next;
      });
    });
    const offApproval = window.openBot.onApprovalNeeded((req) => {
      if (req.botId !== selectedBotIdRef.current) return;
      setApprovals((prev) => [...prev, req]);
    });
    return () => {
      offDelta();
      offToolCall();
      offToolResult();
      offApproval();
    };
  }, []);

  const send = async (text: string) => {
    const botId = selectedBotIdRef.current;
    if (!botId) return;
    const userMsg: ChatMessageView = { id: uid(), role: 'user', text, createdAt: Date.now() };
    const assistantMsg: ChatMessageView = { id: uid(), role: 'assistant', text: '', createdAt: Date.now() };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStatus('thinking');
    setToolEvents([]);
    try {
      const res = await window.openBot.sendChat(botId, text);
      if (!res.ok) {
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { ...assistantMsg, text: `❌ Lỗi: ${res.error ?? 'Không gửi được tin nhắn.'}` },
        ]);
      } else if (res.text) {
        // Nếu main không stream (onText không bắn), dùng text trả về.
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.id === assistantMsg.id && !last.text) {
            return [...prev.slice(0, -1), { ...assistantMsg, text: res.text ?? '' }];
          }
          return prev;
        });
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev.slice(0, -1),
        { ...assistantMsg, text: `❌ Lỗi: ${e instanceof Error ? e.message : 'Không gửi được tin nhắn.'}` },
      ]);
    } finally {
      setStatus('idle');
    }
  };

  const saveBot = async (config: Partial<BotConfigLike> & { id?: string }) => {
    let saved: BotConfigLike;
    if (config.id) {
      const existing = bots.find((b) => b.id === config.id);
      if (!existing) throw new Error('Không tìm thấy bot.');
      saved = await window.openBot.updateBot({ ...existing, ...config, id: config.id });
    } else {
      saved = await window.openBot.createBot(config);
    }
    setBots((prev) => {
      const exists = prev.some((b) => b.id === saved.id);
      return exists ? prev.map((b) => (b.id === saved.id ? saved : b)) : [...prev, saved];
    });
    setSelectedBotId(saved.id);
    setFormOpen(false);
    setFormBot(null);
  };

  const deleteBot = async (bot: BotConfigLike) => {
    if (!window.confirm(`Xoá bot “${bot.name}”?\nLịch sử chat trong bộ nhớ của bot sẽ mất, file workspace vẫn giữ nguyên.`)) return;
    await window.openBot.deleteBot(bot.id);
    setBots((prev) => prev.filter((b) => b.id !== bot.id));
    if (selectedBotId === bot.id) setSelectedBotId(null);
  };

  const respondApproval = (callId: string, approved: boolean) => {
    window.openBot.respondApproval(callId, approved);
    setApprovals((prev) => prev.filter((a) => a.callId !== callId));
  };

  const selectedBot = bots.find((b) => b.id === selectedBotId) ?? null;

  return (
    <div className="app">
      <Sidebar
        bots={bots}
        selectedBotId={selectedBotId}
        onSelect={(id) => {
          setSelectedBotId(id);
          setView('chat');
        }}
        onCreate={() => {
          setFormBot(null);
          setFormOpen(true);
        }}
        onEdit={(bot) => {
          setFormBot(bot);
          setFormOpen(true);
        }}
        onDelete={(bot) => void deleteBot(bot)}
        onOpenSettings={() => setView('settings')}
      />

      <div style={{ flex: 1, display: 'flex', minWidth: 0 }}>
        {view === 'settings' ? (
          <div className="main">
            <SettingsView onBack={() => setView('chat')} />
          </div>
        ) : (
          <>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <ChatView
                bot={selectedBot}
                messages={messages}
                status={status}
                toolEvents={toolEvents}
                onSend={(text) => void send(text)}
              />
              {approvals.map((a) => (
                <ApprovalCard key={a.callId} approval={a} onRespond={respondApproval} />
              ))}
              <div style={{ padding: '0 20px 10px', background: 'var(--bg-panel)' }}>
                <button className="btn secondary" onClick={() => setShowTasks((v) => !v)}>
                  {showTasks ? 'Ẩn nhiệm vụ ▴' : 'Nhiệm vụ & routine ▾'}
                </button>
              </div>
            </div>
            {showTasks && selectedBot && (
              <div style={{ width: 340, borderLeft: '1px solid var(--border)', background: 'var(--bg-panel)', overflow: 'hidden' }}>
                <TaskPanel tasks={tasks} loading={tasksLoading} onRefresh={() => void loadTasks(selectedBot.id)} />
              </div>
            )}
          </>
        )}
      </div>

      {loadError && <p className="error" style={{ position: 'fixed', bottom: 8, right: 12 }}>{loadError}</p>}
      {formOpen && <BotForm initial={formBot} onSave={saveBot} onCancel={() => { setFormOpen(false); setFormBot(null); }} />}
    </div>
  );
}
