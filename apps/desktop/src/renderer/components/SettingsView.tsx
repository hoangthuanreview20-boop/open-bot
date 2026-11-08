import { useEffect, useState } from 'react';
import type { SettingsView as SettingsData } from '../types';

export const PROVIDER_META: Array<{ id: string; label: string; needsKey: boolean; placeholderBaseUrl: string }> = [
  { id: 'openai', label: 'OpenAI', needsKey: true, placeholderBaseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', needsKey: true, placeholderBaseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', label: 'Gemini (Google)', needsKey: true, placeholderBaseUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'xai', label: 'xAI Grok', needsKey: true, placeholderBaseUrl: 'https://api.x.ai/v1' },
  { id: 'ollama', label: 'Ollama (chạy local, không cần key)', needsKey: false, placeholderBaseUrl: 'http://localhost:11434' },
  { id: 'openai-compatible', label: 'OpenAI-compatible (tự nhập base URL)', needsKey: true, placeholderBaseUrl: 'https://api.example.com/v1' },
];

interface Props {
  onBack: () => void;
}

export default function SettingsView({ onBack }: Props) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [draft, setDraft] = useState<Record<string, { apiKey: string; baseUrl: string; defaultModel: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    window.openBot
      .getSettings()
      .then((s) => {
        setData(s);
        const d: typeof draft = {};
        for (const meta of PROVIDER_META) {
          const p = s.providers[meta.id];
          d[meta.id] = { apiKey: '', baseUrl: p?.baseUrl ?? '', defaultModel: p?.defaultModel ?? '' };
        }
        setDraft(d);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Không tải được cài đặt.'));
  }, []);

  const setField = (id: string, field: 'apiKey' | 'baseUrl' | 'defaultModel', value: string) => {
    setDraft((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    setSaved(false);
  };

  const save = async () => {
    setError('');
    try {
      const providers: Record<string, { apiKey?: string; baseUrl?: string; defaultModel?: string }> = {};
      for (const [id, v] of Object.entries(draft) as Array<
        [string, { apiKey: string; baseUrl: string; defaultModel: string }]
      >) {
        // apiKey để trống = giữ key cũ đã lưu ở main (renderer không nhận key thật về).
        providers[id] = { apiKey: v.apiKey || undefined, baseUrl: v.baseUrl, defaultModel: v.defaultModel };
      }
      const next = await window.openBot.setSettings({ providers });
      setData(next);
      setDraft((prev) => {
        const d = { ...prev };
        for (const id of Object.keys(d)) d[id] = { ...d[id], apiKey: '' };
        return d;
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Không lưu được cài đặt.');
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    setTestResult((prev) => ({ ...prev, [id]: '' }));
    try {
      // Lưu trước rồi mới test để main dùng đúng key/baseUrl vừa nhập.
      await save();
      const res = await window.openBot.testConnection(id);
      setTestResult((prev) => ({
        ...prev,
        [id]: res.ok ? '✅ Kết nối thành công.' : `❌ ${res.error ?? 'Kết nối thất bại.'}`,
      }));
    } catch (e) {
      setTestResult((prev) => ({ ...prev, [id]: `❌ ${e instanceof Error ? e.message : 'Lỗi.'}` }));
    } finally {
      setTesting(null);
    }
  };

  if (!data) return <div className="panel"><p>Đang tải cài đặt…</p>{error && <p className="error">{error}</p>}</div>;

  return (
    <div className="panel">
      <button className="btn secondary" onClick={onBack}>← Quay lại chat</button>
      <h2>Cài đặt &amp; API key</h2>
      <p style={{ color: 'var(--text-dim)' }}>
        API key chỉ lưu trong file settings.json trên máy của bạn và chỉ được gửi tới provider bạn chọn.
        Ô key để trống nghĩa là giữ key đã lưu (đã lưu sẽ hiện “Đã lưu”).
      </p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="success">Đã lưu cài đặt.</p>}

      {PROVIDER_META.map((meta) => {
        const p = data.providers[meta.id];
        const v = draft[meta.id] ?? { apiKey: '', baseUrl: '', defaultModel: '' };
        return (
          <section key={meta.id} className="card">
            <h3>{meta.label} {p?.apiKeySet && <span className="badge done">Đã lưu key</span>}</h3>
            {meta.needsKey && (
              <div className="field">
                <label htmlFor={`key-${meta.id}`}>API key</label>
                <input
                  id={`key-${meta.id}`}
                  type="password"
                  autoComplete="off"
                  value={v.apiKey}
                  onChange={(e) => setField(meta.id, 'apiKey', e.target.value)}
                  placeholder={p?.apiKeySet ? 'Đã lưu — nhập key mới để thay đổi' : 'Nhập API key'}
                />
              </div>
            )}
            <div className="field">
              <label htmlFor={`url-${meta.id}`}>Base URL</label>
              <input
                id={`url-${meta.id}`}
                value={v.baseUrl}
                onChange={(e) => setField(meta.id, 'baseUrl', e.target.value)}
                placeholder={meta.placeholderBaseUrl}
              />
            </div>
            <div className="field">
              <label htmlFor={`model-${meta.id}`}>Model mặc định</label>
              <input
                id={`model-${meta.id}`}
                value={v.defaultModel}
                onChange={(e) => setField(meta.id, 'defaultModel', e.target.value)}
                placeholder="vd: grok-4.7"
              />
            </div>
            <button className="btn secondary" onClick={() => test(meta.id)} disabled={testing === meta.id}>
              {testing === meta.id ? 'Đang kiểm tra…' : 'Test kết nối'}
            </button>
            {testResult[meta.id] && <p style={{ margin: '8px 0 0' }}>{testResult[meta.id]}</p>}
          </section>
        );
      })}

      <div className="row">
        <button className="btn" onClick={save}>Lưu cài đặt</button>
      </div>
    </div>
  );
}
