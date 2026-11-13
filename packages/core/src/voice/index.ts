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
export {
  RealtimeSession,
  REALTIME_SESSION_DEFAULT_MAX_RECONNECTS,
  REALTIME_SESSION_DEFAULT_RECONNECT_DELAY_MS,
  REALTIME_SESSION_DEFAULT_RECONNECT_MAX_DELAY_MS,
  REALTIME_PROVIDER_INPUT_RATES,
} from './realtimeSession';
export type {
  RealtimeSessionOptions,
  RealtimeTransportFactory,
} from './realtimeSession';
export {
  OpenAiRealtimeTransport,
  GeminiLiveTransport,
  createRealtimeTransport,
  buildOpenAiRealtimeUrl,
  buildGeminiLiveUrl,
  OPENAI_REALTIME_WS_URL,
  OPENAI_REALTIME_DEFAULT_MODEL,
  OPENAI_REALTIME_DEFAULT_VOICE,
  GEMINI_LIVE_WS_URL,
  GEMINI_LIVE_DEFAULT_MODEL,
  GEMINI_LIVE_DEFAULT_VOICE,
} from './adapters';
export type {
  RealtimeTransport,
  RealtimeTransportCallbacks,
  RealtimeTransportConfig,
} from './adapters';
export {
  LocalVad,
  Pcm16Chunker,
  MockAudioSource,
  MockAudioSink,
  isValidPcm16Frame,
  pcm16Rms,
  pcm16Sample,
  resamplePcm16,
  sinePcm16Frame,
  silencePcm16Frame,
  LOCAL_VAD_DEFAULT_THRESHOLD,
  LOCAL_VAD_DEFAULT_HANGOVER_MS,
  LOCAL_VAD_WINDOW_MS,
  PCM16_BYTES_PER_SAMPLE,
} from './audio';
export type { AudioSource, AudioSink, LocalVadCallbacks } from './audio';
export {
  WhisperCliSttEngine,
  MockLocalSttEngine,
  detectLocalStt,
  WHISPER_BINARY_CANDIDATES,
  WHISPER_MODEL_CANDIDATES,
  LOCAL_STT_MAX_BYTES,
  LOCAL_STT_TIMEOUT_MS,
} from './localStt';
export type {
  LocalSttEngine,
  LocalSttStatus,
  LocalSttTranscribeOptions,
  WhisperRunner,
} from './localStt';
export {
  LocalSttPipeline,
  wordErrorRate,
  normalizeTranscriptForWer,
  STT_PIPELINE_DEFAULT_MIN_SEGMENT_MS,
  STT_PIPELINE_DEFAULT_MAX_SEGMENT_MS,
  STT_PIPELINE_DEFAULT_SAMPLE_RATE_HZ,
} from './sttPipeline';
export type {
  SttSegmentResult,
  SttPipelineCallbacks,
  SttPipelineOptions,
  WordErrorRate,
} from './sttPipeline';
export {
  TtsQueue,
  splitIntoSentences,
  TTS_ABBREVIATIONS,
  TTS_BARGE_IN_BUDGET_MS,
} from './ttsQueue';
export type {
  QueuedSentence,
  TtsQueueStopResult,
  TtsQueueCallbacks,
  TtsQueueOptions,
} from './ttsQueue';
export {
  VoiceSessionStore,
  createVoiceSessionRecord,
  newVoiceSessionId,
  sanitizeVoiceSessionId,
  isVoiceSessionRecord,
  buildVoiceTranscriptEntry,
  defaultVoiceSessionsDir,
  VOICE_PERSIST_DEFAULT_MAX_TRANSCRIPT,
  VOICE_PERSIST_DEFAULT_MAX_AGE_MS,
  VOICE_PERSIST_DEFAULT_MAX_SESSIONS,
} from './voicePersistence';
export type {
  VoiceTranscriptEntry,
  PersistedVoiceProvider,
  VoiceSessionRecord,
  VoiceSessionStoreOptions,
} from './voicePersistence';
export {
  LatencyStats,
  Backoff,
  MissingRealtimeKeyError,
  isMissingRealtimeKeyError,
  realtimeKeyMissingMessage,
  deriveTransportHealth,
  REALTIME_KEY_SETTINGS_HINT,
  TRANSPORT_SLOW_CONNECT_MS,
  TRANSPORT_SLOW_FIRST_AUDIO_MS,
} from './transportHealth';
export type {
  LatencySample,
  LatencySummary,
  BackoffOptions,
  TransportHealthStatus,
  TransportHealth,
} from './transportHealth';
export {
  resolveRealtimeApiKey,
  hasRealtimeKeyFor,
} from './adapters';
export {
  MockRealtimeTransport,
  isMockRealtimeTransport,
  MOCK_REALTIME_DEFAULT_REPLY,
} from './mockTransport';
export type {
  MockRealtimeReply,
  MockRealtimeTransportOptions,
} from './mockTransport';
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
  REALTIME_PROVIDERS,
  TURN_TAKING_MODES,
  REALTIME_MIC_SAMPLE_RATE_HZ,
  OPENAI_REALTIME_INPUT_SAMPLE_RATE_HZ,
  GEMINI_LIVE_INPUT_SAMPLE_RATE_HZ,
  REALTIME_OUTPUT_SAMPLE_RATE_HZ,
  REALTIME_FRAME_MS,
  REALTIME_FRAME_BYTES_16K,
  REALTIME_FRAME_BYTES_24K,
  isVoiceSurface,
  isRealtimeProvider,
  isTurnTakingMode,
} from './types';
export type {
  AudioEvent,
  DictationOptions,
  RealtimeCallbacks,
  RealtimeConfig,
  RealtimeProvider,
  RealtimeSessionEvent,
  RealtimeSessionEventSink,
  RealtimeSessionState,
  RealtimeState,
  RealtimeToolCall,
  TranscriptionOptions,
  TranscriptEvent,
  TurnTakingMode,
  VoiceCallHarnessOutcome,
  VoiceCallHarnessOutcomeKind,
  VoiceCallToolDefinition,
  VoiceCallToolName,
  VoiceSurface,
  WebSocketFactory,
  WebSocketLike,
} from './types';
