#!/usr/bin/env node
/**
 * Voice live verification runner (v0.98, Đội T5).
 *
 * Runs the whole voice-live stack check on this machine and
 * prints the structured report:
 *
 *   npm run build --workspace=@open-bot/core
 *   node scripts/voice-live-verify.mjs [--gemini] [--no-endpoints] [--no-proxy]
 *
 *   --gemini        also run the Gemini connector + Live readiness
 *                   check (slow, ~30 s; uses the real key through
 *                   the already-connected custom.gemini connector).
 *   --no-endpoints  skip the unauthenticated endpoint probes.
 *   --no-proxy      skip the local proxy probe.
 *
 * Whisper WER cases are synthesised on the fly with eSpeak NG
 * (two English sentences) when eSpeak NG + ffmpeg + whisper are
 * present; otherwise the whisper section reports the engine
 * status only. Exit code 0 when every ran section passed, 1
 * otherwise (skipped sections do not count). Never prints a key.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runVoiceLiveVerification,
  summarizeVoiceLiveVerification,
  listLocalWhisperModels,
  recommendWhisperModel,
} from '../packages/core/dist/voice/index.js';

const args = new Set(process.argv.slice(2));
const probeGemini = args.has('--gemini');
const probeEndpoints = !args.has('--no-endpoints');
const probeProxy = !args.has('--no-proxy');

function tryRun(argv) {
  try {
    return execFileSync(argv[0], argv.slice(1), { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Synthesise one reference sentence to 16 kHz mono PCM16. */
function makePcm(dir, name, text) {
  const wav = tryRun(['espeak-ng', '--stdout', '-v', 'en', '-s', '150', text]);
  if (!wav || wav.length <= 1000) return null;
  const wavPath = path.join(dir, `${name}.wav`);
  const pcmPath = path.join(dir, `${name}.pcm`);
  fs.writeFileSync(wavPath, wav);
  const converted = tryRun(['ffmpeg', '-y', '-v', 'error', '-i', wavPath, '-ar', '16000', '-ac', '1', '-f', 's16le', pcmPath]);
  if (converted === null && !fs.existsSync(pcmPath)) return null;
  return new Uint8Array(fs.readFileSync(pcmPath));
}

async function main() {
  const models = listLocalWhisperModels();
  const recommended = recommendWhisperModel(models);
  console.log(
    `whisper models on this machine: ${models.map((m) => `${m.id} (${m.sizeMb}MB${m.isDefaultPick ? ', default' : ''})`).join(', ') || '(none)'}`,
  );
  console.log(`recommended model: ${recommended ? recommended.id : '(none)'}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-bot-voice-verify-'));
  let whisperCases;
  try {
    const cases = [
      { name: 'hello-world', reference: 'hello world, this is a test of local speech recognition' },
      { name: 'quick-fox', reference: 'the quick brown fox jumps over the lazy dog' },
    ];
    whisperCases = [];
    for (const c of cases) {
      const pcm16 = makePcm(dir, c.name, c.reference);
      if (pcm16) whisperCases.push({ ...c, pcm16 });
    }
    if (whisperCases.length === 0) {
      console.log('espeak-ng/ffmpeg unavailable — whisper section will report engine status only.');
      whisperCases = undefined;
    }
    const report = await runVoiceLiveVerification({
      probeEndpoints,
      probeGemini,
      probeProxy,
      whisperCases,
      whisperThreads: 2,
    });
    console.log(summarizeVoiceLiveVerification(report));
    if (report.whisper.benchmark) {
      for (const c of report.whisper.benchmark.cases) {
        console.log(`  wer ${c.name}: "${c.hypothesis}" (WER ${c.wer}, ${c.transcribeMs}ms)`);
      }
    }
    process.exitCode = report.passedSections === report.ranSections ? 0 : 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`voice-live-verify failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
