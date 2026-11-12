/**
 * STT dictation (P0-1, REA deep-dive §5.6).
 *
 * A dictation session is a push-based STT client: the caller pushes
 * raw PCM16 audio frames (`pushAudio`) and, when the user stops
 * speaking, `stop()` transcribes everything buffered so far. The audio
 * travels as PCM16 (16 kHz mono by default) — the same format the
 * realtime client uses — wrapped in a WAV container for the STT
 * endpoint.
 *
 * This reuses the STT pipeline that already exists in the repo
 * (`transcribeAudio` in voice/memo.ts — POST
 * `{baseUrl}/audio/transcriptions`, multipart/form-data): dictation only
 * builds the WAV bytes and passes `audio/wav` / `dictation.wav` through
 * the options that function already accepts. No second HTTP client, no
 * second response parser.
 */
import type { DictationOptions } from './types';
import { transcribeAudio } from './memo';

/** Default PCM16 sample rate for dictation (Hz). */
export const DICTATION_SAMPLE_RATE_HZ = 16000;
/** Max buffered PCM16 bytes per dictation session (25 MB ≈ 13 min at 16 kHz mono). */
export const DICTATION_MAX_BYTES = 25 * 1024 * 1024;

/** WAV header size in bytes (44-byte RIFF header, no extra chunks). */
const WAV_HEADER_BYTES = 44;

/**
 * Wrap raw PCM16 mono samples in a 44-byte RIFF/WAVE header so an STT
 * server can decode them. Throws when the input is not whole 16-bit
 * samples (odd byte length) or the sample rate is not a positive
 * integer. Pure function — easy to test byte-for-byte.
 */
export function pcm16ToWav(pcm16: Uint8Array, sampleRateHz = DICTATION_SAMPLE_RATE_HZ): Uint8Array {
  if (pcm16.length % 2 !== 0) {
    throw new Error('pcm16ToWav: PCM16 audio must have an even byte length (16-bit samples).');
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error('pcm16ToWav: sampleRateHz must be a positive integer.');
  }
  const dataBytes = pcm16.length;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // chunk size
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // subchunk size (PCM)
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true); // byte rate (mono 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  out.set(pcm16, WAV_HEADER_BYTES);
  return out;
}

/**
 * Transcribe one PCM16 buffer (single shot). Validates the input, wraps
 * it in WAV, and hands it to the existing `transcribeAudio` pipeline.
 */
export async function transcribeDictation(
  pcm16: Uint8Array,
  options: DictationOptions,
): Promise<string> {
  if (!(pcm16 instanceof Uint8Array)) {
    throw new Error('transcribeDictation: audio must be a Uint8Array of PCM16 samples.');
  }
  if (pcm16.length === 0) {
    throw new Error('transcribeDictation: audio rỗng — không có gì để chuyển thành text.');
  }
  if (pcm16.length % 2 !== 0) {
    throw new Error('transcribeDictation: PCM16 audio must have an even byte length (16-bit samples).');
  }
  const maxBytes = options.maxBytes ?? DICTATION_MAX_BYTES;
  if (pcm16.length > maxBytes) {
    throw new Error(
      `transcribeDictation: audio quá dài (${pcm16.length} byte, tối đa ${maxBytes}).`,
    );
  }
  const sampleRateHz = options.sampleRateHz ?? DICTATION_SAMPLE_RATE_HZ;
  const wav = pcm16ToWav(pcm16, sampleRateHz);
  return transcribeAudio(wav, {
    ...options,
    audioMimeType: 'audio/wav',
    fileName: 'dictation.wav',
  });
}

/**
 * Push-based dictation session: `pushAudio(pcm16)` per frame, then
 * `stop()` transcribes the buffered audio and clears the buffer.
 * `cancel()` drops the buffer without transcribing. One session is one
 * utterance — start a new session for the next one.
 */
export class DictationSession {
  private readonly options: DictationOptions;
  private chunks: Uint8Array[] = [];
  private bufferedBytes = 0;

  constructor(options: DictationOptions) {
    this.options = options;
  }

  /** Push one PCM16 frame. Throws on odd byte length or over the cap. */
  pushAudio(pcm16: Uint8Array): void {
    if (!(pcm16 instanceof Uint8Array)) {
      throw new Error('DictationSession: audio must be a Uint8Array of PCM16 samples.');
    }
    if (pcm16.length % 2 !== 0) {
      throw new Error('DictationSession: PCM16 audio must have an even byte length (16-bit samples).');
    }
    const maxBytes = this.options.maxBytes ?? DICTATION_MAX_BYTES;
    if (this.bufferedBytes + pcm16.length > maxBytes) {
      throw new Error(
        `DictationSession: audio quá dài (vượt ${maxBytes} byte) — dừng dictation và thử lại với đoạn ngắn hơn.`,
      );
    }
    this.chunks.push(pcm16.slice());
    this.bufferedBytes += pcm16.length;
  }

  /** Buffered PCM16 bytes so far. */
  getBufferedBytes(): number {
    return this.bufferedBytes;
  }

  /** Buffered duration in ms at the session sample rate. */
  getBufferedDurationMs(): number {
    const sampleRateHz = this.options.sampleRateHz ?? DICTATION_SAMPLE_RATE_HZ;
    return Math.round((this.bufferedBytes / 2 / sampleRateHz) * 1000);
  }

  /** Transcribe the buffered audio and clear the buffer. */
  async stop(): Promise<string> {
    if (this.bufferedBytes === 0) {
      throw new Error('DictationSession: chưa có audio — không có gì để chuyển thành text.');
    }
    const pcm16 = new Uint8Array(this.bufferedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm16.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];
    this.bufferedBytes = 0;
    return transcribeDictation(pcm16, this.options);
  }

  /** Drop the buffered audio without transcribing. */
  cancel(): void {
    this.chunks = [];
    this.bufferedBytes = 0;
  }
}
