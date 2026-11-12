/**
 * @open-bot/core/voice — realtime voice calls + voice memos + dictation.
 * Public surface for the voice module (imported by the desktop main
 * process; NOT re-exported from the package root index).
 */
export {
  RealtimeClient,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_DIAL_TIMEOUT_MS,
  DEFAULT_MAX_REDIAL_DELAY_MS,
  DEFAULT_MAX_SILENT_PATH_REDIALS,
} from './realtime';
export { transcribeAudio, DEFAULT_TRANSCRIPTION_MODEL, DEFAULT_TRANSCRIPTION_TIMEOUT_MS } from './memo';
export {
  DictationSession,
  transcribeDictation,
  pcm16ToWav,
  DICTATION_SAMPLE_RATE_HZ,
  DICTATION_MAX_BYTES,
} from './dictation';
export {
  VoiceCallHarness,
} from './harness';
export type { VoiceCallHarnessOptions } from './harness';
export {
  MockTtsEngine,
  SystemTtsEngine,
  TtsHarness,
  stripMarkdownForSpeech,
  parseEspeakVoices,
  rateToWpm,
  rateToSpdSay,
  TTS_MAX_CHARS,
  TTS_SPEAK_TIMEOUT_MS,
} from './tts';
export type { TtsEngine, TtsEngineStatus, TtsSpeakOptions, TtsSpeakResult, TtsStopResult, TtsVoice } from './tts';
export {
  VoiceCallSession,
  truncateToolOutput,
} from './session';
export type {
  VoiceCallSessionOptions,
  VoiceRealtimeClient,
  VoiceRealtimeClientFactory,
  VoiceSessionEvent,
  VoiceSurfaceRegistration,
  VoiceSurfaceView,
} from './session';
export {
  createVoiceCallToolSet,
  getVoiceCallToolDefinition,
  isVoiceCallToolName,
  validateVoiceCallArgs,
  VOICE_CALL_TOOL_NAMES,
} from './callTools';
export type {
  VoiceCallToolHandlers,
  VoiceCallToolSet,
  VoiceCallValidationResult,
} from './callTools';
export {
  extractFileChanges,
  buildPeekChangesResult,
  PEEK_CHANGES_LIMIT,
} from './fileChanges';
export type {
  FileChangeEntry,
  FileChangeKind,
  FileChangeSourceRecord,
  PeekChangesResult,
} from './fileChanges';
export {
  VOICE_REDIAL_MAX_ATTEMPTS,
  VOICE_REDIAL_DIAL_TIMEOUT_MS,
  VOICE_REDIAL_INITIAL_DELAY_MS,
  VOICE_REDIAL_MAX_DELAY_MS,
  VOICE_REDIAL_MAX_SILENT_PATH_REDIALS,
  VOICE_CALL_POLICY_CLOSE_CODE,
  VOICE_CALL_SUPERSEDED_CLOSE_CODE,
  VOICE_SURFACES,
  VOICE_SURFACE_GUIDANCE,
  VOICE_SURFACE_MAX_REPLY_CHARS,
  VOICE_CALL_TOOL_DEFINITIONS,
  VOICE_CALL_REQUEST_CHAR_LIMIT,
  VOICE_CALL_SEARCH_HIT_LIMIT,
  VOICE_CALL_CHIME_NOTES,
  isVoiceSurface,
} from './types';
export type {
  AudioEvent,
  DictationOptions,
  RealtimeCallbacks,
  RealtimeConfig,
  RealtimeState,
  RealtimeToolCall,
  TranscriptionOptions,
  TranscriptEvent,
  VoiceCallHarnessOutcome,
  VoiceCallHarnessOutcomeKind,
  VoiceCallToolDefinition,
  VoiceCallToolName,
  VoiceSurface,
  WebSocketFactory,
  WebSocketLike,
} from './types';
