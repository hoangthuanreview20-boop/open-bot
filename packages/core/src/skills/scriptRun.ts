/**
 * Skill scripts — run a skill's bundled script safely (v1.02 rescue
 * port of the v0.99 work).
 *
 * A skill directory may contain a `scripts/` folder with helper
 * scripts (e.g. a formatter, a checker). `runSkillScript` executes
 * one of them with a timeout and a capped output, inside the skill
 * directory (cwd is always the skill dir — the script cannot be
 * pointed elsewhere). Only scripts listed in the skill's frontmatter
 * (`scripts:`) may run; anything else is refused. No shell is used
 * (argv only), so there is no injection through arguments.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SkillScriptRunOptions {
  /** Timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Max stdout/stderr bytes kept (default 50 KB). */
  maxOutputBytes?: number;
  /** Extra environment variables (merged over a minimal env). */
  env?: Record<string, string>;
}

export interface SkillScriptResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Default script timeout (30s). */
export const DEFAULT_SKILL_SCRIPT_TIMEOUT_MS = 30_000;

/** Max script output kept (50 KB). */
export const DEFAULT_SKILL_SCRIPT_MAX_OUTPUT_BYTES = 50_000;

/**
 * Run a skill script by name (must be inside `<skillDir>/scripts/`
 * and listed in `allowedScripts`). Returns the capped result.
 */
export function runSkillScript(
  skillDir: string,
  scriptName: string,
  allowedScripts: string[],
  args: string[] = [],
  options: SkillScriptRunOptions = {},
): Promise<SkillScriptResult> {
  if (!allowedScripts.includes(scriptName)) {
    return Promise.reject(new Error(`script "${scriptName}" is not in the skill's allowed scripts`));
  }
  const scriptPath = path.resolve(skillDir, 'scripts', scriptName);
  const scriptsDir = path.resolve(skillDir, 'scripts');
  if (scriptPath !== scriptsDir && !scriptPath.startsWith(`${scriptsDir}${path.sep}`)) {
    return Promise.reject(new Error(`script path escapes the skill scripts directory: ${scriptName}`));
  }
  try {
    if (!fs.statSync(scriptPath).isFile()) {
      return Promise.reject(new Error(`skill script not found: ${scriptName}`));
    }
  } catch {
    return Promise.reject(new Error(`skill script not found: ${scriptName}`));
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_SKILL_SCRIPT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_SKILL_SCRIPT_MAX_OUTPUT_BYTES;
  return new Promise((resolve) => {
    const child = spawn(scriptPath, args, {
      cwd: skillDir,
      shell: false,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(options.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-maxOutputBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-maxOutputBytes);
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: error.message, timedOut });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}
