/**
 * Pure helpers for the voice-call view + dictation UI (v0.59).
 *
 * No React, no DOM, no IPC here — ChatView / CallView own the
 * side effects, these functions own the data shaping so they can be
 * unit-tested with plain node --test (see tests/voice-v059.test.mjs).
 */

/** One transcript line shown in the call view. */
export interface CallTranscriptLine {
  id: string;
  text: string;
  /** False while the model is still revising this line. */
  isFinal: boolean;
  at: number;
}

/**
 * Append a transcript event to the call-view list. An interim event
 * updates the last line when it is still interim (same speaker turn);
 * a final event closes the current line and the next event starts a
 * new one. Returns a new array (never mutates the input).
 */
export function appendCallTranscript(
  lines: readonly CallTranscriptLine[],
  event: { text: string; isFinal: boolean; at: number },
): CallTranscriptLine[] {
  const text = event.text.trim();
  if (!text) return [...lines];
  const last = lines[lines.length - 1];
  if (last && !last.isFinal && !event.isFinal) {
    return [...lines.slice(0, -1), { ...last, text, at: event.at }];
  }
  if (last && !last.isFinal && event.isFinal) {
    return [...lines.slice(0, -1), { ...last, text, isFinal: true, at: event.at }];
  }
  return [...lines, { id: `call-${event.at}-${lines.length}`, text, isFinal: event.isFinal, at: event.at }];
}

/**
 * Merge dictation text into the chat composer. A space separates it
 * from existing text; empty dictation leaves the input untouched.
 */
export function insertDictationText(prev: string, text: string): string {
  const clean = text.trim();
  if (!clean) return prev;
  return prev ? `${prev} ${clean}` : clean;
}

/**
 * Concatenate PCM16 frames (base64, as posted by the pcm-capture
 * worklet) into one base64 buffer for `voice:dictation`. Frames are
 * decoded, joined as bytes, and re-encoded — no sample is dropped or
 * reordered. Empty input returns ''.
 */
export function concatPcm16Base64(frames: readonly string[]): string {
  const bytes: number[] = [];
  for (const frame of frames) {
    if (!frame) continue;
    const binary = atob(frame);
    for (let i = 0; i < binary.length; i++) bytes.push(binary.charCodeAt(i));
  }
  if (bytes.length === 0) return '';
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}
