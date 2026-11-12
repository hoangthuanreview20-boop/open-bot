// pcm-capture.worklet.js — runs inside an AudioWorklet, no DOM access.
// Converts microphone float32 samples to PCM16 at 16 kHz and posts one
// base64 frame (~100 ms) at a time to the main thread, which forwards it
// to the main process over IPC. Loaded as a bundled file asset via Vite
// `?url` (see ChatView) — same-origin 'self', so the renderer CSP
// (`script-src 'self'`) allows it in both dev and the production
// file:// build. (v0.55: it used to load from a Blob URL built from this
// source, but Chromium checks AudioWorklet.addModule against
// `script-src`, not `worker-src`, so the blob was blocked at app load.)
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.buffer.push(...new Uint8Array(pcm.buffer));
    // ~100 ms at 16 kHz mono 16-bit = 3200 bytes.
    if (this.buffer.length >= 3200) {
      const chunk = this.buffer.splice(0, 3200);
      let binary = '';
      for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
      this.port.postMessage({ audioBase64: btoa(binary) });
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
