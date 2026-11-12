/**
 * Bot avatar colour (UI-13, v0.62) — pure helpers, no React, no IPC.
 *
 * A bot's identity in the sidebar / chat header is a coloured circle
 * with its initial (no image upload — a colour is enough to tell bots
 * apart at a glance, and it needs no storage). The picker in BotForm
 * offers exactly these 8 colours; anything else stored on the bot
 * (an old value, a hand-edited settings file) falls back to the
 * default instead of rendering a broken style.
 */

/** The 8 picker colours (distinct, readable on light + dark). */
export const BOT_COLORS: string[] = [
  '#2563eb', // blue
  '#16a34a', // green
  '#7c3aed', // violet
  '#db2777', // pink
  '#ea580c', // orange
  '#0891b2', // cyan
  '#ca8a04', // amber
  '#475569', // slate
];

/** Colour used when a bot has none stored (or an unknown one). */
export const BOT_COLOR_DEFAULT = BOT_COLORS[0] as string;

/** True when the value is one of the picker colours. */
export function isBotColor(value: unknown): value is string {
  return typeof value === 'string' && BOT_COLORS.includes(value);
}

/** Display colour for a bot: its stored colour when valid, else default. */
export function botColor(color: unknown): string {
  return isBotColor(color) ? color : BOT_COLOR_DEFAULT;
}

/** Avatar letter: the first non-space character, upper-cased. */
export function botInitial(name: string): string {
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : '?';
}
