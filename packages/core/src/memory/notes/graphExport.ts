/**
 * Graph export cho evolving notes (v1.01, Đội T5).
 *
 * Xuất mạng note thành JSON chuẩn (nodes/edges) để UI vẽ graph, để
 * user export ra công cụ khác, hoặc để benchmark phân tích mạng:
 *
 *  - Node: một note active (mặc định) — kèm kind, tag, degree, version.
 *  - Edge: một link — kèm kind, weight, auto. Backlink không tạo edge
 *    riêng (đồ thị có hướng; UI tự suy backlink khi cần).
 *  - Timeline: sự kiện tạo / sửa / link / supersede, xếp theo thời gian.
 *  - DOT: export text Graphviz để user tự render bằng `dot`.
 *
 * Không vẽ layout ở đây — layout là việc của UI (SVG force đơn giản).
 */

import type { EvolvingNote, NoteLinkKind } from './types';
import type { EvolvingNoteStore } from './store';

/** Một node trong graph export. */
export interface GraphNode {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  status: string;
  /** Bậc: link ra + backlink. */
  degree: number;
  /** Số version đã qua (độ "tiến hoá"). */
  version: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

/** Một edge trong graph export. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: NoteLinkKind;
  weight: number;
  auto: boolean;
}

/** Toàn bộ graph export. */
export interface NotesGraphExport {
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Thống kê nhanh kèm theo export. */
  stats: {
    orphans: number;
    autoEdges: number;
    byKind: Record<string, number>;
    byLinkKind: Record<string, number>;
    /** Mật độ: edge / (node × (node − 1)) — 0 khi < 2 node. */
    density: number;
  };
}

/** Một sự kiện trong timeline của mạng note. */
export interface NoteTimelineEvent {
  at: string;
  type: 'created' | 'updated' | 'linked' | 'superseded' | 'deleted' | 'archived' | 'restored';
  noteId: string;
  noteTitle: string;
  /** Chi tiết (vd version mới, link tới note nào). */
  detail: string;
}

/** Tuỳ chọn export. */
export interface GraphExportOptions {
  scope?: { userId?: string; botId?: string };
  /** Bao gồm note superseded/archived không (mặc định: chỉ active). */
  includeNonActive?: boolean;
  /** Chỉ export subgraph quanh một note (BFS sâu `depth`, mặc định: toàn bộ). */
  centerNoteId?: string;
  depth?: number;
  /** Giới hạn node (mặc định 1000). */
  limit?: number;
}

export function exportNotesGraph(store: EvolvingNoteStore, opts: GraphExportOptions = {}): NotesGraphExport {
  let notes = store.listNotes({
    scope: opts.scope,
    status: opts.includeNonActive ? 'all' : 'active',
    limit: opts.limit ?? 1000,
  });
  // Subgraph: BFS từ note trung tâm theo link ra + backlink.
  if (opts.centerNoteId) {
    const depth = opts.depth ?? 2;
    const wanted = new Set<string>([opts.centerNoteId]);
    let frontier = [opts.centerNoteId];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const note = store.getNote(id);
        if (!note) continue;
        for (const link of note.links) {
          if (!wanted.has(link.targetId)) {
            wanted.add(link.targetId);
            next.push(link.targetId);
          }
        }
        for (const back of store.backlinks(id)) {
          if (!wanted.has(back.fromId)) {
            wanted.add(back.fromId);
            next.push(back.fromId);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    notes = notes.filter((n) => wanted.has(n.id));
  }

  const nodes: GraphNode[] = notes.map((note) => ({
    id: note.id,
    title: note.title,
    kind: note.kind,
    tags: note.tags,
    status: note.status,
    degree: store.degree(note.id),
    version: note.version,
    confidence: note.confidence,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  }));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges: GraphEdge[] = [];
  const byKind: Record<string, number> = {};
  const byLinkKind: Record<string, number> = {};
  let autoEdges = 0;
  for (const note of notes) {
    byKind[note.kind] = (byKind[note.kind] ?? 0) + 1;
    for (const link of note.links) {
      if (!nodeIds.has(link.targetId)) continue;
      edges.push({ from: note.id, to: link.targetId, kind: link.kind, weight: link.weight, auto: link.auto });
      byLinkKind[link.kind] = (byLinkKind[link.kind] ?? 0) + 1;
      if (link.auto) autoEdges++;
    }
  }
  const n = nodes.length;
  const density = n < 2 ? 0 : edges.length / (n * (n - 1));
  const orphans = nodes.filter((node) => node.degree === 0).length;
  return {
    generatedAt: new Date().toISOString(),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    stats: { orphans, autoEdges, byKind, byLinkKind, density: Number(density.toFixed(4)) },
  };
}

/** Timeline sự kiện của mạng note (tạo/sửa/link/supersede...), mới nhất trước. */
export function exportNotesTimeline(
  store: EvolvingNoteStore,
  opts: { scope?: { userId?: string; botId?: string }; limit?: number } = {},
): NoteTimelineEvent[] {
  const notes = store.listNotes({ scope: opts.scope, status: 'all', limit: 10000 });
  const events: NoteTimelineEvent[] = [];
  for (const note of notes) {
    events.push({
      at: note.createdAt,
      type: 'created',
      noteId: note.id,
      noteTitle: note.title,
      detail: `Tạo note (${note.kind}, v1).`,
    });
    for (const version of note.versions) {
      events.push({
        at: version.createdAt,
        type: 'updated',
        noteId: note.id,
        noteTitle: note.title,
        detail: `Lên v${version.version + 1} — ${version.reason}.`,
      });
    }
    for (const link of note.links) {
      const target = store.getNote(link.targetId);
      events.push({
        at: link.createdAt,
        type: 'linked',
        noteId: note.id,
        noteTitle: note.title,
        detail: `Link ${link.kind} → "${target?.title ?? link.targetId}"${link.auto ? ' (tự động)' : ''}.`,
      });
    }
    if (note.status === 'superseded') {
      events.push({
        at: note.updatedAt,
        type: 'superseded',
        noteId: note.id,
        noteTitle: note.title,
        detail: `Bị thay thế bởi note ${note.supersededBy ?? ''}.`,
      });
    }
    if (note.status === 'deleted') {
      events.push({
        at: note.updatedAt,
        type: 'deleted',
        noteId: note.id,
        noteTitle: note.title,
        detail: 'Đã xoá (mềm).',
      });
    }
    if (note.status === 'archived') {
      events.push({
        at: note.updatedAt,
        type: 'archived',
        noteId: note.id,
        noteTitle: note.title,
        detail: 'Đã archive.',
      });
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));
  return events.slice(0, opts.limit ?? 200);
}

/** Export DOT (Graphviz) — user tự render bằng `dot -Tpng`. */
export function exportNotesDot(store: EvolvingNoteStore, opts: GraphExportOptions = {}): string {
  const graph = exportNotesGraph(store, opts);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 60);
  const lines: string[] = ['digraph notes {', '  rankdir=LR;', '  node [shape=box, style=rounded];'];
  for (const node of graph.nodes) {
    const color = node.status === 'superseded' ? 'gray' : node.kind === 'preference' ? 'lightblue' : 'white';
    lines.push(`  "${node.id}" [label="${esc(node.title)}" fillcolor="${color}" style="rounded,filled"];`);
  }
  for (const edge of graph.edges) {
    const style = edge.auto ? 'dashed' : 'solid';
    lines.push(`  "${edge.from}" -> "${edge.to}" [label="${edge.kind}" style="${style}"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

/** Ma trận kề dạng text — để benchmark / debug nhanh không cần UI. */
export function adjacencyListText(store: EvolvingNoteStore, opts: GraphExportOptions = {}): string {
  const graph = exportNotesGraph(store, opts);
  const byId = new Map(graph.nodes.map((n) => [n.id, n.title]));
  const lines: string[] = [];
  for (const node of graph.nodes) {
    const outgoing = graph.edges
      .filter((e) => e.from === node.id)
      .map((e) => `${e.kind} → ${byId.get(e.to) ?? e.to}`);
    lines.push(`${node.title} [${node.kind}]${outgoing.length > 0 ? ': ' + outgoing.join(', ') : ' (không có link ra)'}`);
  }
  return lines.join('\n');
}
