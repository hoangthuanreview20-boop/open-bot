/**
 * Evolving notes tools cho @open-bot/tools (v1.01, Đội T5).
 *
 * Agent tự làm việc với evolving notes bằng tool call:
 *  - notes_create          — tạo note mới (+ auto-link gợi ý) (needsApproval: true)
 *  - notes_update          — sửa note (version cũ được giữ) (needsApproval: true)
 *  - notes_search          — BM25 search note (đọc)
 *  - notes_list            — liệt kê note / orphan / hub (đọc)
 *  - notes_get             — xem chi tiết note + version history + backlink (đọc)
 *  - notes_link            — thêm/xoá link giữa hai note (needsApproval: true)
 *  - notes_suggest_links   — gợi ý link cho một note (đọc)
 *  - notes_graph           — export graph JSON / DOT / timeline (đọc)
 *  - notes_revisit         — revisit note bằng thông tin mới: append/merge/
 *                            contradiction (vào hàng chờ) / supersede (needsApproval: true)
 *  - notes_conflicts       — liệt kê / duyệt conflict (duyệt needsApproval: true)
 *  - notes_benchmark_run   — chạy benchmark memory synthetic trên store
 *                            IN-MEMORY riêng (không đụng kho note thật) (đọc)
 *  - notes_import          — import long-term memories / graph facts thành
 *                            note (needsApproval: true)
 *
 * QUY TẮC BẢO VỆ: mọi ghi đều qua store (validate + versioning + scope);
 * mâu thuẫn không bao giờ được agent tự áp — revisit đẩy vào hàng chờ,
 * chỉ user duyệt trong UI mới thành note. Tool không bao giờ trả version
 * history đầy đủ (chỉ khi notes_get với includeVersions) để tránh tràn
 * context.
 */

import type {
  AutoLinkEngine,
  EvolvingNoteStore,
  LongTermMemory,
  NoteLinkKind,
  RevisitEngine,
  TemporalGraphStore,
  Tool,
} from '@open-bot/core';
import {
  AutoLinkEngine as AutoLinkEngineCtor,
  EvolvingNoteStore as EvolvingNoteStoreCtor,
  RevisitEngine as RevisitEngineCtor,
  exportNotesDot,
  exportNotesGraph,
  exportNotesTimeline,
  generateBenchmarkSuite,
  buildBenchmarkReportJson,
  buildBenchmarkReportMarkdown,
  importFromGraphFacts,
  importFromLongTerm,
  publicNote,
  runBenchmarkOnStore,
} from '@open-bot/core';

function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool['definition'] {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

function errorResult(message: string): string {
  return `Error: ${message}`;
}

function getStringArg(args: Record<string, unknown>, name: string, required = true): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) throw new Error(`Missing required argument: "${name}"`);
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getOptionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string, got ${typeof value}`);
  }
  return value;
}

function getNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument "${name}" must be a number, got ${typeof value}`);
  }
  return value;
}

function getStringArrayArg(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Argument "${name}" must be an array of strings.`);
  }
  return value as string[];
}

export interface MemoryNotesToolOptions {
  /** Note store của workspace (bắt buộc để tool chạy). */
  notesStore?: EvolvingNoteStore;
  /** Long-term memory store (để notes_import từ long-term). */
  longTermStore?: LongTermMemory;
  /** Temporal graph store (để notes_import từ graph). */
  graphStore?: TemporalGraphStore;
  /** userId hiện tại (từ profile.json); vắng = không lọc theo user. */
  getUserId?: () => string | undefined;
}

export function createMemoryNotesTools(opts: MemoryNotesToolOptions = {}): Tool[] {
  const userIdOf = (): string | undefined => {
    try {
      const id = opts.getUserId?.();
      return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const needStore = (): EvolvingNoteStore => {
    if (!opts.notesStore) {
      throw new Error('evolving notes chưa được hỗ trợ trong phiên này (host phải truyền notesStore vào createMemoryNotesTools).');
    }
    return opts.notesStore;
  };
  const scopeOf = (ctx: { botId: string; runId?: string }) => ({
    userId: userIdOf() ?? '',
    botId: ctx.botId,
    runId: ctx.runId ?? '',
  });
  const autoLink = () => new AutoLinkEngineCtor(needStore());
  const revisit = () => new RevisitEngineCtor(needStore());

  const notesCreate: Tool = {
    definition: toolDef(
      'notes_create',
      'Create one evolving note (Zettelkasten-style): title + free text + kind + tags. The store auto-suggests links to related existing notes (similarity); pass autoLink=true to attach auto links above threshold. Needs user approval first.',
      {
        title: { type: 'string', description: 'Tiêu đề note (tối đa 200 ký tự).' },
        body: { type: 'string', description: 'Nội dung note (tối đa 20000 ký tự).' },
        kind: { type: 'string', description: '"fact" | "preference" | "event" | "project" | "person" | "place" | "idea" | "other" (mặc định "fact").' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag (tối đa 20).' },
        confidence: { type: 'number', description: 'Độ tin cậy 0..1 (mặc định 0.8).' },
        autoLink: { type: 'boolean', description: 'true = tự gắn link auto vượt ngưỡng 0.55 (mặc định false — chỉ gợi ý).' },
      },
      ['title', 'body'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const note = s.createNote({
          title: getStringArg(args, 'title'),
          body: getStringArg(args, 'body'),
          kind: (getOptionalStringArg(args, 'kind') ?? 'fact') as Parameters<EvolvingNoteStore['createNote']>[0]['kind'],
          tags: getStringArrayArg(args, 'tags'),
          confidence: getNumberArg(args, 'confidence'),
          scope: scopeOf(ctx),
          createdBy: `agent:${ctx.botId}`,
        });
        let applied: unknown[] = [];
        let suggested: unknown[] = [];
        if (args.autoLink === true) {
          const result = autoLink().applyAutoLinks(note.id);
          applied = result.applied;
          suggested = result.suggested;
        } else {
          suggested = autoLink().suggestLinksFor(note);
        }
        return JSON.stringify({ note: publicNote(note, { includeBody: true }), autoLinksApplied: applied, linkSuggestions: suggested }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesUpdate: Tool = {
    definition: toolDef(
      'notes_update',
      'Update a note: the old content is kept as a version (history is never deleted). Use notes_revisit instead when the new info may contradict the old note. Needs user approval first.',
      {
        noteId: { type: 'string', description: 'Id note cần sửa.' },
        title: { type: 'string', description: 'Tiêu đề mới (vắng = giữ nguyên).' },
        body: { type: 'string', description: 'Nội dung mới (vắng = giữ nguyên).' },
        kind: { type: 'string', description: 'Loại mới (vắng = giữ nguyên).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag mới (thay toàn bộ).' },
        reason: { type: 'string', description: 'Lý do sửa — ghi vào version history.' },
      },
      ['noteId'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const s = needStore();
        const updated = s.updateNote(getStringArg(args, 'noteId'), {
          ...(getOptionalStringArg(args, 'title') !== undefined ? { title: getOptionalStringArg(args, 'title') } : {}),
          ...(getOptionalStringArg(args, 'body') !== undefined ? { body: getOptionalStringArg(args, 'body') } : {}),
          ...(getOptionalStringArg(args, 'kind') !== undefined
            ? { kind: getOptionalStringArg(args, 'kind') as Parameters<EvolvingNoteStore['updateNote']>[1]['kind'] }
            : {}),
          ...(getStringArrayArg(args, 'tags') !== undefined ? { tags: getStringArrayArg(args, 'tags') } : {}),
          reason: getOptionalStringArg(args, 'reason') ?? 'update',
          updatedBy: 'agent',
        });
        return JSON.stringify({ note: publicNote(updated, { includeBody: true }) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesSearch: Tool = {
    definition: toolDef(
      'notes_search',
      'BM25 search over evolving notes (local, no model). Returns ranked notes with scores and matched tokens. Read-only.',
      {
        query: { type: 'string', description: 'Câu hỏi / từ khoá cần tìm.' },
        topK: { type: 'number', description: 'Số kết quả tối đa (mặc định 10, tối đa 50).' },
        kind: { type: 'string', description: 'Lọc theo loại note.' },
      },
      ['query'],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const topK = Math.max(1, Math.min(50, getNumberArg(args, 'topK') ?? 10));
        const hits = s.search(getStringArg(args, 'query'), {
          scope: scopeOf(ctx),
          topK,
          ...(getOptionalStringArg(args, 'kind') ? { kind: getOptionalStringArg(args, 'kind') as 'fact' } : {}),
        });
        return JSON.stringify({
          query: getStringArg(args, 'query'),
          hits: hits.map((h) => ({ ...publicNote(h.note, { includeBody: true }), score: Number(h.score.toFixed(4)), matchedTokens: h.matchedTokens })),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesList: Tool = {
    definition: toolDef(
      'notes_list',
      'List evolving notes (active by default) or orphans (notes with no links) — use orphans=true to find notes not yet connected to the network. Read-only.',
      {
        status: { type: 'string', description: '"active" | "superseded" | "archived" | "deleted" | "all" (mặc định "active").' },
        kind: { type: 'string', description: 'Lọc theo loại note.' },
        tag: { type: 'string', description: 'Lọc theo tag.' },
        orphans: { type: 'boolean', description: 'true = chỉ note không có link nào.' },
        limit: { type: 'number', description: 'Số mục tối đa (mặc định 50, tối đa 500).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const limit = Math.max(1, Math.min(500, getNumberArg(args, 'limit') ?? 50));
        if (args.orphans === true) {
          const orphans = s.orphanNotes(scopeOf(ctx)).slice(0, limit);
          return JSON.stringify({ orphans: orphans.map((n) => publicNote(n, { includeBody: false })) }, null, 2);
        }
        const notes = s.listNotes({
          scope: scopeOf(ctx),
          status: (getOptionalStringArg(args, 'status') ?? 'active') as 'active',
          ...(getOptionalStringArg(args, 'kind') ? { kind: getOptionalStringArg(args, 'kind') as 'fact' } : {}),
          ...(getOptionalStringArg(args, 'tag') ? { tag: getOptionalStringArg(args, 'tag') } : {}),
          limit,
        });
        return JSON.stringify({ notes: notes.map((n) => publicNote(n, { includeBody: false })), stats: s.stats(scopeOf(ctx)) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesGet: Tool = {
    definition: toolDef(
      'notes_get',
      'Get one note in detail: current content + version history + outgoing links + backlinks. Read-only.',
      {
        noteId: { type: 'string', description: 'Id note.' },
        includeVersions: { type: 'boolean', description: 'true = kèm toàn bộ version history (mặc định false).' },
      },
      ['noteId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const note = s.getNote(getStringArg(args, 'noteId'));
        if (!note) return errorResult(`Không tìm thấy note: ${getStringArg(args, 'noteId')}.`);
        return JSON.stringify({
          note: publicNote(note, { includeBody: true, includeVersions: args.includeVersions === true }),
          backlinks: s.backlinks(note.id),
          degree: s.degree(note.id),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesLink: Tool = {
    definition: toolDef(
      'notes_link',
      'Add or remove a link between two notes (related / supports / contradicts / supersedes / part-of). Linking is how the note network grows — prefer linking over duplicating content. Needs user approval first.',
      {
        noteId: { type: 'string', description: 'Id note nguồn.' },
        targetId: { type: 'string', description: 'Id note đích.' },
        kind: { type: 'string', description: 'Loại link: "related" | "supports" | "contradicts" | "supersedes" | "part-of".' },
        action: { type: 'string', description: '"add" (mặc định) hoặc "remove".' },
      },
      ['noteId', 'targetId', 'kind'],
    ),
    needsApproval: true,
    async execute(args) {
      try {
        const s = needStore();
        const noteId = getStringArg(args, 'noteId');
        const targetId = getStringArg(args, 'targetId');
        const kind = getStringArg(args, 'kind') as NoteLinkKind;
        if (getOptionalStringArg(args, 'action') === 'remove') {
          const removed = s.removeLink(noteId, targetId, kind);
          return JSON.stringify({ removed }, null, 2);
        }
        const note = s.addLink(noteId, targetId, kind, { weight: 1, auto: false });
        return JSON.stringify({ note: publicNote(note, { includeBody: false }) }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesSuggestLinks: Tool = {
    definition: toolDef(
      'notes_suggest_links',
      'Suggest links for a note from similarity to other notes (TF-IDF + tags). Returns suggestions with scores and reasons; nothing is applied. Read-only.',
      {
        noteId: { type: 'string', description: 'Id note cần gợi ý link.' },
      },
      ['noteId'],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const s = needStore();
        const note = s.getNote(getStringArg(args, 'noteId'));
        if (!note) return errorResult(`Không tìm thấy note: ${getStringArg(args, 'noteId')}.`);
        const suggestions = autoLink().suggestLinksFor(note);
        return JSON.stringify({ noteId: note.id, suggestions }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesGraph: Tool = {
    definition: toolDef(
      'notes_graph',
      'Export the note network: JSON nodes/edges, DOT (Graphviz) text, or timeline of note events. Read-only.',
      {
        format: { type: 'string', description: '"json" (mặc định) | "dot" | "timeline".' },
        centerNoteId: { type: 'string', description: 'Chỉ export subgraph quanh note này.' },
        depth: { type: 'number', description: 'Độ sâu BFS cho subgraph (mặc định 2).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const format = getOptionalStringArg(args, 'format') ?? 'json';
        if (format === 'dot') {
          return exportNotesDot(s, {
            scope: scopeOf(ctx),
            ...(getOptionalStringArg(args, 'centerNoteId') ? { centerNoteId: getOptionalStringArg(args, 'centerNoteId') } : {}),
            ...(getNumberArg(args, 'depth') !== undefined ? { depth: getNumberArg(args, 'depth') } : {}),
          });
        }
        if (format === 'timeline') {
          return JSON.stringify({ events: exportNotesTimeline(s, { scope: scopeOf(ctx) }) }, null, 2);
        }
        return JSON.stringify(exportNotesGraph(s, {
          scope: scopeOf(ctx),
          ...(getOptionalStringArg(args, 'centerNoteId') ? { centerNoteId: getOptionalStringArg(args, 'centerNoteId') } : {}),
          ...(getNumberArg(args, 'depth') !== undefined ? { depth: getNumberArg(args, 'depth') } : {}),
        }), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesRevisit: Tool = {
    definition: toolDef(
      'notes_revisit',
      'Revisit a note with new information: append (new info), merge (near-duplicate), contradiction (goes to a review queue — the old note is NOT changed), or supersede (new note replaces the old one). Use mode="analyze" to classify without applying. Needs user approval first when applying.',
      {
        noteId: { type: 'string', description: 'Id note cần revisit.' },
        newText: { type: 'string', description: 'Thông tin mới.' },
        mode: { type: 'string', description: '"apply" (mặc định) hoặc "analyze" (chỉ phân loại, không sửa).' },
      },
      ['noteId', 'newText'],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const noteId = getStringArg(args, 'noteId');
        const newText = getStringArg(args, 'newText');
        const note = s.getNote(noteId);
        if (!note) return errorResult(`Không tìm thấy note: ${noteId}.`);
        if (getOptionalStringArg(args, 'mode') === 'analyze') {
          const analysis = revisit().analyze(note, newText);
          return JSON.stringify({ analysis }, null, 2);
        }
        const result = revisit().applyRevisit(noteId, newText, { by: `agent:${ctx.botId}` });
        return JSON.stringify({
          decision: result.decision,
          explanation: result.explanation,
          ...(result.note ? { note: publicNote(result.note, { includeBody: true }) } : {}),
          ...(result.conflictId ? { conflictId: result.conflictId } : {}),
        }, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesConflicts: Tool = {
    definition: toolDef(
      'notes_conflicts',
      'List pending note conflicts (new info contradicting an old note) or resolve one: supersede (new info wins), merge (combine), keep-both (keep both notes, linked as contradicts). Resolving needs user approval first.',
      {
        action: { type: 'string', description: '"list" (mặc định) | "resolve" | "dismiss".' },
        conflictId: { type: 'string', description: 'Id conflict (khi resolve/dismiss).' },
        resolution: { type: 'string', description: '"supersede" | "merge" | "keep-both" (khi resolve).' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const action = getOptionalStringArg(args, 'action') ?? 'list';
        if (action === 'list') {
          return JSON.stringify({ conflicts: s.listConflicts(scopeOf(ctx), 'pending') }, null, 2);
        }
        if (action === 'dismiss') {
          const item = s.dismissConflict(getStringArg(args, 'conflictId'), `agent:${ctx.botId}`);
          return JSON.stringify({ dismissed: item }, null, 2);
        }
        if (action === 'resolve') {
          const resolution = getStringArg(args, 'resolution') as 'supersede' | 'merge' | 'keep-both';
          const result = revisit().resolveConflict(getStringArg(args, 'conflictId'), resolution, { by: `agent:${ctx.botId}` });
          return JSON.stringify({
            decision: result.decision,
            explanation: result.explanation,
            ...(result.note ? { note: publicNote(result.note, { includeBody: true }) } : {}),
          }, null, 2);
        }
        return errorResult(`action phải là "list", "resolve" hoặc "dismiss".`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesBenchmarkRun: Tool = {
    definition: toolDef(
      'notes_benchmark_run',
      'Run the self-measured memory benchmark (LongMemEval-style, synthetic data generated locally from a seed — no copyrighted dataset): ingest generated documents into a FRESH in-memory note store, run recall, measure Recall@k / accuracy / MRR. Never touches the real note store. Read-only.',
      {
        seed: { type: 'number', description: 'Seed sinh dữ liệu (mặc định 10101 — cùng seed cho cùng bộ task).' },
        personas: { type: 'number', description: 'Số persona sinh (mặc định 10 → 60 task).' },
        topK: { type: 'number', description: 'Số kết quả recall mỗi task (mặc định 10).' },
        format: { type: 'string', description: '"json" (mặc định) hoặc "markdown".' },
      },
      [],
    ),
    needsApproval: false,
    async execute(args) {
      try {
        const seed = getNumberArg(args, 'seed') ?? 10101;
        const personas = Math.max(1, Math.min(50, getNumberArg(args, 'personas') ?? 10));
        const topK = Math.max(1, Math.min(20, getNumberArg(args, 'topK') ?? 10));
        const suite = generateBenchmarkSuite({ seed, personas });
        const store = EvolvingNoteStoreCtor.inMemory();
        const result = await runBenchmarkOnStore(suite, store, { topK });
        if (getOptionalStringArg(args, 'format') === 'markdown') {
          return buildBenchmarkReportMarkdown(result, suite);
        }
        return JSON.stringify(buildBenchmarkReportJson(result, suite), null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  const notesImport: Tool = {
    definition: toolDef(
      'notes_import',
      'Import long-term memories and/or temporal graph facts as evolving notes (one note per entry/fact). Already-imported items are skipped, so re-running is safe. Needs user approval first.',
      {
        source: { type: 'string', description: '"longterm" | "graph" | "both" (mặc định "both").' },
      },
      [],
    ),
    needsApproval: true,
    async execute(args, ctx) {
      try {
        const s = needStore();
        const source = getOptionalStringArg(args, 'source') ?? 'both';
        const scope = scopeOf(ctx);
        const results: Record<string, unknown> = {};
        if ((source === 'longterm' || source === 'both') && opts.longTermStore) {
          results.longterm = importFromLongTerm(s, opts.longTermStore, { botId: scope.botId, userId: scope.userId });
        }
        if ((source === 'graph' || source === 'both') && opts.graphStore) {
          results.graph = importFromGraphFacts(s, opts.graphStore, { botId: scope.botId, userId: scope.userId });
        }
        if (Object.keys(results).length === 0) {
          return errorResult('Không có nguồn nào để import (host chưa truyền longTermStore/graphStore).');
        }
        return JSON.stringify(results, null, 2);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  };

  return [
    notesCreate,
    notesUpdate,
    notesSearch,
    notesList,
    notesGet,
    notesLink,
    notesSuggestLinks,
    notesGraph,
    notesRevisit,
    notesConflicts,
    notesBenchmarkRun,
    notesImport,
  ];
}

/** Unbound placeholder (same shape as MEMORY_GRAPH_TOOLS). */
export const MEMORY_NOTES_TOOLS: Tool[] = createMemoryNotesTools();

/** Tên các tool evolving notes (để coordinator/registry kiểm tra). */
export const MEMORY_NOTES_TOOL_NAMES = [
  'notes_create',
  'notes_update',
  'notes_search',
  'notes_list',
  'notes_get',
  'notes_link',
  'notes_suggest_links',
  'notes_graph',
  'notes_revisit',
  'notes_conflicts',
  'notes_benchmark_run',
  'notes_import',
] as const;
