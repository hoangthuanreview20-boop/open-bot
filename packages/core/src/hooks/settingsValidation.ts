/**
 * Whole-settings validation for lifecycle hooks (v1.01, T2).
 *
 * One place that checks a full hooks settings object — the command-hook
 * list plus the test-gate config — and reports every problem at once,
 * so Settings and the CLI (`open-bot hooks validate`) can show the user
 * the whole list instead of failing on the first bad entry. Pure, never
 * throws: an unparseable input is reported as issues, not an exception.
 *
 * A settings object looks like:
 *   { commands?: HookCommandSettingsEntry[], testGate?: TestGateConfig }
 * (the two files the coordinator reads: `hooks-commands.json` — an array
 * or `{ commands: [...] }` — and `hooks-test-gate.json`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeTestGateConfig, testGateCommands } from './testGate';
import type { TestGateConfig } from './testGate';
import { validateHookCommandEntry } from './shellCommandRunner';

/** One problem found in a hooks settings object. */
export interface HookSettingsIssue {
  /** Where the problem is: `commands[<i>].<field>`, `commands`, or `testGate`. */
  field: string;
  /** Human-readable problem (Vietnamese, matching the rest of the hook UI). */
  message: string;
}

/** The settings object `validateHookSettings` accepts. */
export interface HookSettingsInput {
  commands?: unknown;
  testGate?: unknown;
  /** Back-compat: a bare array is treated as the commands list. */
  [key: string]: unknown;
}

/**
 * Validate a whole hooks settings object. Returns every issue found
 * (empty array = valid). Checks:
 * - `commands` must be an array (when present) of valid command-hook
 *   entries (each entry via `validateHookCommandEntry`);
 * - hook names must be unique (last valid duplicate wins at apply time,
 *   so a duplicate is reported rather than silently dropped);
 * - `testGate`, when present, must normalise to at least one command
 *   (an object with no usable command is reported, not ignored).
 */
export function validateHookSettings(input: unknown): HookSettingsIssue[] {
  const issues: HookSettingsIssue[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    // A bare array is the legacy commands-file shape.
    if (Array.isArray(input)) {
      return validateHookCommandsList(input);
    }
    issues.push({ field: 'settings', message: 'Cấu hình hooks phải là một object.' });
    return issues;
  }
  const obj = input as HookSettingsInput;
  if (obj['commands'] !== undefined) {
    if (!Array.isArray(obj['commands'])) {
      issues.push({ field: 'commands', message: 'commands phải là một mảng.' });
    } else {
      issues.push(...validateHookCommandsList(obj['commands']));
    }
  }
  if (obj['testGate'] !== undefined) {
    issues.push(...validateTestGateInput(obj['testGate']));
  }
  return issues;
}

/** Validate just the commands list (shared by the object and bare-array shapes). */
export function validateHookCommandsList(list: unknown[]): HookSettingsIssue[] {
  const issues: HookSettingsIssue[] = [];
  const seen = new Map<string, number>();
  list.forEach((raw, i) => {
    const result = validateHookCommandEntry(raw);
    if (!result.valid || !result.entry) {
      for (const issue of result.issues) {
        issues.push({
          field: `commands[${i}].${issue.field}`,
          message: issue.message,
        });
      }
      return;
    }
    const prev = seen.get(result.entry.name);
    if (prev !== undefined) {
      issues.push({
        field: `commands[${i}].name`,
        message: `Tên hook "${result.entry.name}" bị trùng với commands[${prev}] — chỉ hook cuối cùng được dùng.`,
      });
    } else {
      seen.set(result.entry.name, i);
    }
  });
  return issues;
}

/** Validate just the test-gate config (shared by the object shape and the gate file). */
export function validateTestGateInput(input: unknown): HookSettingsIssue[] {
  if (input === null || input === undefined) return [];
  // An object that does not even try to configure a gate (no command /
  // commands key at all) is "unconfigured", not an error — the app
  // itself writes `{}` when the user clears the gate in Settings, so
  // the validator must not flag its own output.
  if (typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (obj['command'] === undefined && obj['commands'] === undefined) return [];
  }
  const normalized: TestGateConfig | null = normalizeTestGateConfig(input);
  if (!normalized) {
    return [
      {
        field: 'testGate',
        message:
          'testGate không có lệnh kiểm tra nào (cần command hoặc commands[] với ít nhất 1 lệnh).',
      },
    ];
  }
  const issues: HookSettingsIssue[] = [];
  if (testGateCommands(normalized).length === 0) {
    issues.push({
      field: 'testGate',
      message: 'testGate không có lệnh kiểm tra nào.',
    });
  }
  return issues;
}

/**
 * Read + validate the two hook config files in a state dir and return
 * every issue found (missing files = no issues: an empty config is
 * valid, the gate simply stays unconfigured). Pure I/O wrapper around
 * `validateHookSettings` — never throws.
 */
export function validateHookSettingsFiles(stateDir: string): HookSettingsIssue[] {
  const issues: HookSettingsIssue[] = [];
  try {
    const commandsPath = path.join(stateDir, 'hooks-commands.json');
    if (fs.existsSync(commandsPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(commandsPath, 'utf8'));
        issues.push(...validateHookSettings(parsed));
      } catch (err) {
        issues.push({
          field: 'commands',
          message: `Không đọc được hooks-commands.json: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    const gatePath = path.join(stateDir, 'hooks-test-gate.json');
    if (fs.existsSync(gatePath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
        issues.push(...validateTestGateInput(parsed));
      } catch (err) {
        issues.push({
          field: 'testGate',
          message: `Không đọc được hooks-test-gate.json: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } catch (err) {
    issues.push({
      field: 'settings',
      message: `Không kiểm tra được cấu hình hooks: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return issues;
}
