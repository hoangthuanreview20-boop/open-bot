// Live TTS test (v0.82): real espeak-ng on this machine, no fake binary.
// Run: npm run build --workspace=@open-bot/core && node scripts/tts-live-v082/live-test.mjs
import { SystemTtsEngine, TtsHarness } from '../../packages/core/dist/voice/tts.js';
import assert from 'node:assert/strict';

const engine = new SystemTtsEngine();
console.log('engine:', engine.id, engine.name, 'available:', await engine.isAvailable());
assert.equal(await engine.isAvailable(), true, 'espeak-ng must be on PATH');
assert.equal(engine.id, 'espeak-ng');
const t0 = Date.now();
const r1 = await new TtsHarness().speak('Xin chào open-bot, đây là giọng đọc thật từ eSpeak.');
console.log('speak EN/VN:', JSON.stringify(r1), `${Date.now() - t0}ms`);
assert.equal(r1.spoken, true, 'real speak() must report spoken:true');
assert.equal(r1.engineId, 'espeak-ng');
const r2 = await engine.speak('Hello from open-bot', { lang: 'en' });
console.log('speak en:', JSON.stringify(r2));
assert.equal(r2.spoken, true);
const r3 = await engine.speak('   ');
console.log('speak empty:', JSON.stringify(r3));
assert.equal(r3.spoken, false);
assert.equal(r3.reason, 'empty-text');
// v0.82: voice + rate + voice list on the REAL engine.
const voices = await new TtsHarness().listVoices();
console.log('voices:', voices.length, 'first:', JSON.stringify(voices.slice(0, 3)));
assert.ok(voices.length > 0, 'real espeak-ng must list voices');
assert.ok(voices.some((v) => v.id === 'vi'), 'voice list must include vi');
const t1 = Date.now();
const r4 = await engine.speak('Xin chào, đây là giọng miền Nam, đọc nhanh hơn một chút.', { voice: 'vi-vn-x-south', rate: 1.25 });
console.log('speak voice+rate:', JSON.stringify(r4), `${Date.now() - t1}ms`);
assert.equal(r4.spoken, true);
assert.equal(r4.engineId, 'espeak-ng');
const viVoices = await engine.listVoices('vi');
console.log('voices vi filter:', viVoices.map((v) => v.id).join(','));
assert.ok(viVoices.length >= 1 && viVoices.every((v) => v.lang === 'vi'));
console.log('LIVE TTS OK');
