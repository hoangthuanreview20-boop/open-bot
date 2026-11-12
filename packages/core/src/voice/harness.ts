/**
 * Voice-call harness (P0-1, REA deep-dive §5.4–§5.5).
 *
 * The harness is the server side of a voice call: the realtime client
 * keeps the audio connection, and the harness executes the voice-call
 * tools and classifies every outcome as `served` / `unknown_tool` /
 * `invalid_input`. It also owns the *surface register* — the screen the
 * user is looking at while on the call (desk/web/phone/carplay/
 * headphones) — so spoken replies stay as short as that surface
 * requires.
 *
 * The harness never touches the agent's general tool registry: it only
 * runs the voice-call toolset (voice/callTools.ts) through handlers
 * bound by its caller. The desktop main process binds those handlers
 * to the coordinator; this module stays dependency-free.
 */
import type {
  VoiceCallHarnessOutcome,
  VoiceCallToolDefinition,
  VoiceSurface,
} from './types';
import {
  VOICE_SURFACE_GUIDANCE,
  VOICE_SURFACE_MAX_REPLY_CHARS,
  VOICE_SURFACES,
  isVoiceSurface,
} from './types';
import {
  createVoiceCallToolSet,
  type VoiceCallToolHandlers,
  type VoiceCallToolSet,
} from './callTools';

export interface VoiceCallHarnessOptions {
  /** Screen the user is looking at. Default 'desk'. */
  surface?: VoiceSurface;
}

export class VoiceCallHarness {
  private readonly toolset: VoiceCallToolSet;
  private surface: VoiceSurface;

  constructor(handlers: VoiceCallToolHandlers = {}, options: VoiceCallHarnessOptions = {}) {
    this.toolset = createVoiceCallToolSet(handlers);
    this.surface = options.surface ?? 'desk';
  }

  // -- surface register ---------------------------------------------------

  /** The surface the user is currently on. */
  getSurface(): VoiceSurface {
    return this.surface;
  }

  /** Record the surface the user is now looking at. Throws on an
   *  unknown surface — the register never holds a value it cannot
   *  explain to the model. */
  setSurface(surface: unknown): void {
    if (!isVoiceSurface(surface)) {
      throw new Error(
        `VoiceCallHarness: unknown surface ${JSON.stringify(surface)} — expected one of ${VOICE_SURFACES.join(', ')}.`,
      );
    }
    this.surface = surface;
  }

  /** Max spoken-reply length (chars) for the current surface. */
  getMaxReplyChars(): number {
    return VOICE_SURFACE_MAX_REPLY_CHARS[this.surface];
  }

  /** The instruction for the current surface, for the realtime session
   *  instructions (see `buildSessionInstructions`). */
  getSurfaceGuidance(): string {
    return VOICE_SURFACE_GUIDANCE[this.surface];
  }

  /**
   * Build the session instructions for a voice call: the bot's base
   * instructions plus the surface guidance for the surface on record.
   * The model shapes its spoken replies from this, so the surface is
   * part of the prompt — not a comment in the UI.
   */
  buildSessionInstructions(baseInstructions: string): string {
    const base = (baseInstructions ?? '').trim();
    const guidance = this.getSurfaceGuidance();
    return base ? `${base}\n\n[Voice surface: ${this.surface}] ${guidance}` : guidance;
  }

  /**
   * Shorten a spoken reply to what the current surface allows: cut at
   * the last word boundary at or before the surface max, and mark the
   * cut with an ellipsis. Text already within the limit is returned
   * unchanged. This is a safety net for replies the model made too
   * long — the surface guidance in the instructions is the first line
   * of defence.
   */
  shortenForSurface(text: string): string {
    const max = this.getMaxReplyChars();
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    const trimmed = (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd();
    return `${trimmed}…`;
  }

  // -- tool execution -----------------------------------------------------

  /** The voice-call tool definitions, in OpenAI Realtime `function`
   *  shape, for the `session.update` tools list. Only these ten tools
   *  are ever offered to the model during a voice call. */
  toRealtimeFunctionDefinitions(): Array<Record<string, unknown>> {
    return this.toolset.definitions.map((d: VoiceCallToolDefinition) => ({
      type: 'function',
      name: d.name,
      description: d.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(d.parameters).map(([key, param]) => [
            key,
            {
              type: 'string',
              description: `Max ${param.charLimit} characters.`,
            },
          ]),
        ),
        required: Object.entries(d.parameters)
          .filter(([, param]) => param.required)
          .map(([key]) => key),
      },
    }));
  }

  /**
   * Execute one voice-call tool and classify the outcome:
   * `served` (ran, `output` holds the result), `unknown_tool` (no such
   * voice-call tool, or no handler bound for it in this call), or
   * `invalid_input` (arguments failed validation, or the tool failed
   * while running — see `error`). Never throws for a bad tool call.
   */
  async executeTool(name: string, args: unknown): Promise<VoiceCallHarnessOutcome> {
    return this.toolset.execute(name, args);
  }
}
