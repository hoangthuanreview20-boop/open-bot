/**
 * Voice memo — transcribe a short recorded audio clip to text.
 *
 * A voice memo is "record a few seconds, get the text, send it as a
 * task": the renderer captures audio with MediaRecorder (see
 * docs/v04-worker3-integration.md), the main process forwards the bytes
 * here, and this function calls the provider's OpenAI-compatible
 * speech-to-text endpoint (`POST {baseUrl}/audio/transcriptions`,
 * multipart/form-data, field `file`). That endpoint shape is what
 * OpenAI, xAI (Grok) and Ollama-compatible STT servers expose, so the
 * same call works for the user's configured provider without any
 * provider-specific code. No API key is needed for local endpoints.
 *
 * Only the transcription text is returned — the audio bytes are never
 * stored or logged.
 */
import type { TranscriptionOptions } from './types';

export const DEFAULT_TRANSCRIPTION_MODEL = 'whisper-1';
export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;

/** Transcribe recorded audio bytes. Throws on empty audio or HTTP/API error. */
export async function transcribeAudio(
  audioBytes: Uint8Array | ArrayBuffer,
  options: TranscriptionOptions,
): Promise<string> {
  const bytes = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes);
  if (bytes.length === 0) {
    throw new Error('transcribeAudio: audio rỗng — không có gì để chuyển thành text.');
  }
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('transcribeAudio: chưa cấu hình baseUrl cho provider STT.');
  }
  const model = options.model ?? DEFAULT_TRANSCRIPTION_MODEL;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('transcribeAudio: fetch không khả dụng trong môi trường này.');
  }

  const form = new FormData();
  // Blob filename/extension matters to some servers (whisper.cpp infers
  // the container from it); the renderer records webm/opus by default.
  // Dictation (voice/dictation.ts) passes audio/wav + dictation.wav.
  form.append(
    'file',
    new Blob([Buffer.from(bytes)], { type: options.audioMimeType ?? 'audio/webm' }),
    options.fileName ?? 'voice-memo.webm',
  );
  form.append('model', model);
  if (options.language) form.append('language', options.language);

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSCRIPTION_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new Error(`transcribeAudio: hết thời gian chờ sau ${timeoutMs}ms.`);
    }
    throw new Error(
      `transcribeAudio: không gọi được STT endpoint — ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(
      `transcribeAudio: STT trả về HTTP ${res.status} — ${bodyText.slice(0, 500)}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error('transcribeAudio: STT trả về phản hồi không phải JSON.');
  }
  const text =
    data && typeof data === 'object' && 'text' in data
      ? (data as { text?: unknown }).text
      : undefined;
  if (typeof text !== 'string') {
    throw new Error('transcribeAudio: STT trả về JSON thiếu trường "text".');
  }
  return text;
}
