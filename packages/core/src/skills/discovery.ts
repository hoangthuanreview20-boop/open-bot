/**
 * Skill discovery — find skills in many roots (v1.02 rescue port of
 * the v0.99 work).
 *
 * Skills live in several places: the workspace (`.agents/skills`,
 * `.claude/skills`), the user's home (same dirs), and the
 * open-bot user skills dir. `scanDiscoveryRoots` walks them in
 * priority order (workspace first) and reports every SKILL.md it
 * finds, with provenance (where it came from) so the registry can
 * explain a match. The first root wins on name collisions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One place skills are discovered from. */
export interface SkillDiscoveryRoot {
  /** Absolute directory holding skill subdirectories (or loose SKILL.md files). */
  dir: string;
  /** Where this root sits (shown in provenance). */
  source: 'workspace' | 'home' | 'user' | 'plugin';
  /** Plugin id when source === 'plugin'. */
  pluginId?: string;
}

export interface DiscoveredSkill {
  name: string;
  /** Absolute directory holding SKILL.md (or the file itself for loose files). */
  dir: string;
  /** Absolute path of SKILL.md. */
  filePath: string;
  root: SkillDiscoveryRoot;
  /** Human-readable provenance, e.g. `workspace:.agents/skills`. */
  provenance: string;
}

export interface DiscoveryScanResult {
  skills: DiscoveredSkill[];
  /** Roots that did not exist or could not be read. */
  skippedRoots: Array<{ dir: string; reason: string }>;
  /** Names found in more than one root (first root wins). */
  duplicates: string[];
}

/** Default discovery roots for a workspace + home directory. */
export function defaultDiscoveryRoots(workspaceDir: string, homeDir: string, userSkillsDir?: string): SkillDiscoveryRoot[] {
  const roots: SkillDiscoveryRoot[] = [];
  for (const sub of ['.agents/skills', '.claude/skills']) {
    roots.push({ dir: path.join(workspaceDir, sub), source: 'workspace' });
  }
  for (const sub of ['.agents/skills', '.claude/skills']) {
    roots.push({ dir: path.join(homeDir, sub), source: 'home' });
  }
  if (userSkillsDir) roots.push({ dir: userSkillsDir, source: 'user' });
  return roots;
}

/** Scan roots for SKILL.md files (workspace first, first root wins). */
export function scanDiscoveryRoots(roots: SkillDiscoveryRoot[]): DiscoveryScanResult {
  const skills: DiscoveredSkill[] = [];
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  const skippedRoots: Array<{ dir: string; reason: string }> = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      skippedRoots.push({ dir: root.dir, reason: 'missing or unreadable' });
      continue;
    }
    for (const entry of entries) {
      let filePath: string | undefined;
      let name: string | undefined;
      if (entry.isDirectory()) {
        const candidate = path.join(root.dir, entry.name, 'SKILL.md');
        try {
          if (fs.statSync(candidate).isFile()) {
            filePath = candidate;
            name = entry.name;
          }
        } catch {
          // No SKILL.md in this directory; skip.
        }
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        filePath = path.join(root.dir, entry.name);
        name = path.basename(root.dir);
      }
      if (!filePath || !name) continue;
      if (seen.has(name)) {
        if (!duplicates.includes(name)) duplicates.push(name);
        continue;
      }
      seen.set(name, root.dir);
      skills.push({
        name,
        dir: path.dirname(filePath),
        filePath,
        root,
        provenance: `${root.source}:${path.basename(root.dir)}`,
      });
    }
  }
  return { skills, skippedRoots, duplicates };
}
