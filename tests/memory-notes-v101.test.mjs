/**
 * Tests for v1.01 (Đội T5) — evolving notes core:
 * packages/core/src/memory/notes/{types,similarity,store,autolink,revisit,graphExport}.ts.
 *
 * Bao phủ: tạo note (validate, scope), update versioning (lịch sử giữ
 * lại, không xoá), supersede (cũ đóng lại, mới trỏ supersedes), xoá mềm
 * + restore, link/backlink/orphan/degree, search BM25 (bỏ dấu TV, tag
 * bonus), similarity TF-IDF (note giống nhau điểm cao hơn note khác),
 * auto-link (ngưỡng suggest/auto, part-of, không tự link đã có),
 * revisit (append/merge/contradiction→conflict/no-op, resolve conflict
 * 3 hướng, revisit queue), graph export (nodes/edges/stats/DOT/timeline),
 * prompt section.
 *
 * Run after building core:
 *   npm run build --workspace=@open-bot/core
 *   node --test tests/memory-notes-v101.test.mjs
 *
 * No network. No model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EvolvingNoteStore,
  AutoLinkEngine,
  RevisitEngine,
  exportNotesGraph,
  exportNotesTimeline,
  exportNotesDot,
  adjacencyListText,
  compareNotes,
  computeIdf,
  tokenCounts,
  tokenizeNoteText,
  noteSearchText,
  normalizeNoteTag,
  NoteStoreError,
} from '../packages/core/dist/memory/notes/index.js';

const SCOPE = { userId: 'user-1', botId: 'bot-a', runId: 'run-1' };

function makeStore() {
  return EvolvingNoteStore.inMemory();
}

function makeNote(store, overrides = {}) {
  return store.createNote({
    title: 'Tôi thích phở bò',
    body: 'Tôi rất thích ăn phở bò ở Hà Nội. Phở bò là món khoái khẩu.',
    kind: 'preference',
    tags: ['an-uong', 'pho'],
    scope: SCOPE,
    ...overrides,
  });
}

// ------------------------------------------------------------------ types / similarity

test('normalizeNoteTag bỏ dấu + slug hoá tag', () => {
  assert.equal(normalizeNoteTag('Ẩm Thực Hà Nội'), 'am-thuc-ha-noi');
  assert.equal(normalizeNoteTag('  phở-bò  '), 'pho-bo');
});

test('tokenizeNoteText bỏ dấu TV + bỏ stopword', () => {
  const tokens = tokenizeNoteText('Tôi rất thích ăn phở bò ở Hà Nội');
  assert.ok(tokens.includes('pho'));
  assert.ok(tokens.includes('bo'));
  assert.ok(tokens.includes('ha'));
  assert.ok(!tokens.includes('toi'));
  assert.ok(!tokens.includes('o'));
});

test('compareNotes: note giống nhau điểm cao hơn note khác hẳn', () => {
  const a = { title: 'Phở bò Hà Nội', body: 'Tôi thích ăn phở bò buổi sáng.', tags: ['an-uong'] };
  const b = { title: 'Quán phở bò ngon', body: 'Phở bò Hà Nội rất ngon, ăn buổi sáng.', tags: ['an-uong'] };
  const c = { title: 'Lập trình TypeScript', body: 'Viết code TypeScript với vitest và node.', tags: ['lap-trinh'] };
  // Corpus đủ lớn để 'pho' là token hiếm (IDF >= 2): thêm vài doc không liên quan.
  const fillers = [
    { title: 'Du lịch Đà Lạt', body: 'Đà Lạt có khí hậu mát mẻ quanh năm.', tags: ['du-lich'] },
    { title: 'Học tiếng Anh', body: 'Luyện nghe nói tiếng Anh mỗi ngày.', tags: ['hoc-tap'] },
    { title: 'Trồng cây cảnh', body: 'Chăm sóc cây cảnh trong vườn nhà.', tags: ['vuon'] },
    { title: 'Bơi lội buổi sáng', body: 'Bơi lội giúp rèn luyện sức khoẻ.', tags: ['the-thao'] },
    { title: 'Nấu cơm gia đình', body: 'Nấu cơm tối cho gia đình.', tags: ['nau-an'] },
  ];
  const all = [a, b, c, ...fillers];
  const idf = computeIdf(all.map((d) => tokenCounts(noteSearchText(d))));
  const simAB = compareNotes(a, b, idf);
  const simAC = compareNotes(a, c, idf);
  assert.ok(simAB.score > simAC.score, `AB=${simAB.score} phải > AC=${simAC.score}`);
  assert.ok(simAB.score > 0.3);
  assert.ok(simAB.sharedRareTokens.includes('pho'));
  assert.ok(simAC.score < 0.2);
});

test('compareNotes: tag chung tăng điểm', () => {
  const a = { title: 'Ghi chú A', body: 'nội dung hoàn toàn khác biệt xyz', tags: ['chung'] };
  const b = { title: 'Ghi chú B', body: 'nội dung khác hẳn abc', tags: ['chung'] };
  const c = { title: 'Ghi chú C', body: 'nội dung khác hẳn abc', tags: ['khac'] };
  const idf = computeIdf([tokenCounts(noteSearchText(a)), tokenCounts(noteSearchText(b)), tokenCounts(noteSearchText(c))]);
  assert.ok(compareNotes(a, b, idf).score > compareNotes(a, c, idf).score);
});

// ------------------------------------------------------------------ store CRUD

test('createNote: validate rỗng + kind sai + giới hạn ký tự', () => {
  const store = makeStore();
  assert.throws(() => store.createNote({ title: '   ', body: 'x', scope: SCOPE }), NoteStoreError);
  assert.throws(() => store.createNote({ title: 't', body: '   ', scope: SCOPE }), NoteStoreError);
  assert.throws(() => store.createNote({ title: 't', body: 'x', kind: 'nope', scope: SCOPE }), NoteStoreError);
  const long = store.createNote({ title: 'x'.repeat(500), body: 'y'.repeat(30000), scope: SCOPE });
  assert.equal(long.title.length, 200);
  assert.equal(long.body.length, 20000);
});

test('createNote: tag chuẩn hoá + dedupe, confidence clamp', () => {
  const store = makeStore();
  const note = store.createNote({
    title: 't', body: 'b', tags: ['Ẩm Thực', 'am-thuc', '  ', 'x'], confidence: 5, scope: SCOPE,
  });
  assert.deepEqual(note.tags, ['am-thuc', 'x']);
  assert.equal(note.confidence, 1);
  assert.equal(note.version, 1);
  assert.equal(note.status, 'active');
});

test('updateNote: version cũ giữ lại, version tăng, updatedAt đổi', () => {
  const store = makeStore();
  const note = makeNote(store);
  const updated = store.updateNote(note.id, { body: 'Tôi thích ăn phở bò và bún chả.', reason: 'them-mon', updatedBy: 'user' });
  assert.equal(updated.version, 2);
  assert.equal(updated.versions.length, 1);
  assert.equal(updated.versions[0].body, note.body);
  assert.equal(updated.versions[0].reason, 'them-mon');
  assert.equal(updated.revisitCount, 1);
  assert.ok(updated.lastRevisitedAt);
  const history = store.noteHistory(note.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].version, 1);
});

test('updateNote: không đổi gì thì không sinh version', () => {
  const store = makeStore();
  const note = makeNote(store);
  const same = store.updateNote(note.id, { body: note.body });
  assert.equal(same.version, 1);
  assert.equal(same.versions.length, 0);
});

test('updateNote: sửa note superseded / deleted bị chặn', () => {
  const store = makeStore();
  const note = makeNote(store);
  store.deleteNote(note.id);
  assert.throws(() => store.updateNote(note.id, { body: 'x' }), NoteStoreError);
  store.restoreNote(note.id);
  const replacement = store.supersedeNote(note.id, { title: 'Mới', body: 'Nội dung mới', scope: SCOPE });
  assert.throws(() => store.updateNote(note.id, { body: 'x' }), NoteStoreError);
  assert.equal(replacement.supersedes, note.id);
});

test('supersedeNote: note cũ đóng lại, note mới kế thừa scope/tag/kind', () => {
  const store = makeStore();
  const old = makeNote(store);
  const fresh = store.supersedeNote(old.id, { title: 'Tôi thích bún chả', body: 'Giờ tôi thích bún chả hơn.', scope: SCOPE });
  const oldAfter = store.getNote(old.id);
  assert.equal(oldAfter.status, 'superseded');
  assert.equal(oldAfter.supersededBy, fresh.id);
  assert.equal(fresh.supersedes, old.id);
  assert.equal(fresh.kind, old.kind);
  assert.deepEqual(fresh.tags, old.tags);
  const superseded = store.listNotes({ scope: SCOPE, status: 'superseded' });
  assert.equal(superseded.length, 1);
});

test('deleteNote + restoreNote: xoá mềm giữ lại để hỏi lịch sử', () => {
  const store = makeStore();
  const note = makeNote(store);
  store.deleteNote(note.id);
  assert.equal(store.getNote(note.id).status, 'deleted');
  assert.equal(store.listNotes({ scope: SCOPE }).length, 0);
  assert.equal(store.listNotes({ scope: SCOPE, status: 'all' }).length, 1);
  store.restoreNote(note.id);
  assert.equal(store.getNote(note.id).status, 'active');
});

test('listNotes: lọc scope/kind/tag/status + sắp xếp', () => {
  const store = makeStore();
  makeNote(store);
  store.createNote({ title: 'Lập trình', body: 'Viết code TypeScript.', kind: 'project', tags: ['code'], scope: SCOPE });
  store.createNote({ title: 'Note bot khác', body: 'Không lọt ra.', scope: { userId: 'user-1', botId: 'bot-b', runId: 'r' } });
  assert.equal(store.listNotes({ scope: SCOPE }).length, 2);
  assert.equal(store.listNotes({ scope: SCOPE, kind: 'project' }).length, 1);
  assert.equal(store.listNotes({ scope: SCOPE, tag: 'pho' }).length, 1);
  assert.equal(store.listNotes({ scope: SCOPE, tag: 'khong-co' }).length, 0);
  // includeOtherScopes chỉ dùng cho admin/share.
  assert.equal(store.listNotes({ scope: SCOPE, includeOtherScopes: true }).length, 3);
});

// ------------------------------------------------------------------ links

test('addLink/backlink/degree/orphan: mạng link hai chiều', () => {
  const store = makeStore();
  const a = makeNote(store);
  const b = store.createNote({ title: 'Quán phở ngon', body: 'Quán phở bò ngon ở Hà Nội.', kind: 'place', tags: ['an-uong'], scope: SCOPE });
  const c = store.createNote({ title: 'TypeScript', body: 'Viết code.', kind: 'project', tags: ['code'], scope: SCOPE });
  assert.equal(store.orphanNotes(SCOPE).length, 3);
  store.addLink(a.id, b.id, 'related', { weight: 0.8 });
  assert.equal(store.degree(a.id), 1);
  assert.equal(store.degree(b.id), 1); // backlink
  assert.equal(store.backlinks(b.id).length, 1);
  assert.equal(store.backlinks(b.id)[0].fromId, a.id);
  assert.equal(store.orphanNotes(SCOPE).length, 1);
  assert.equal(store.orphanNotes(SCOPE)[0].id, c.id);
  assert.throws(() => store.addLink(a.id, a.id, 'related'), NoteStoreError);
  assert.throws(() => store.addLink(a.id, 'khong-co', 'related'), NoteStoreError);
  assert.equal(store.removeLink(a.id, b.id), true);
  assert.equal(store.removeLink(a.id, b.id), false);
  assert.equal(store.degree(a.id), 0);
});

test('addLink trùng kind thì cập nhật weight, không nhân đôi', () => {
  const store = makeStore();
  const a = makeNote(store);
  const b = store.createNote({ title: 'B', body: 'b', scope: SCOPE });
  store.addLink(a.id, b.id, 'related', { weight: 0.5 });
  store.addLink(a.id, b.id, 'related', { weight: 0.9 });
  assert.equal(store.getNote(a.id).links.length, 1);
  assert.equal(store.getNote(a.id).links[0].weight, 0.9);
});

// ------------------------------------------------------------------ search

test('search BM25: bỏ dấu TV, tag khớp được cộng điểm, xếp hạng đúng', () => {
  const store = makeStore();
  const pho = makeNote(store);
  store.createNote({ title: 'Lập trình TypeScript', body: 'Viết code TypeScript với vitest.', kind: 'project', tags: ['code'], scope: SCOPE });
  const hits = store.search('pho bo', { scope: SCOPE });
  assert.equal(hits[0].note.id, pho.id);
  assert.ok(hits[0].matchedTokens.includes('pho'));
  // Query không dấu vẫn khớp nội dung có dấu.
  const hits2 = store.search('Ha Noi', { scope: SCOPE });
  assert.ok(hits2.some((h) => h.note.id === pho.id));
  assert.equal(store.search('tu-khoa-khong-ton-tai-xyz', { scope: SCOPE }).length, 0);
});

test('stats + buildPromptSection', () => {
  const store = makeStore();
  const a = makeNote(store);
  const b = store.createNote({ title: 'B', body: 'b', scope: SCOPE });
  store.addLink(a.id, b.id, 'related');
  const stats = store.stats(SCOPE);
  assert.equal(stats.total, 2);
  assert.equal(stats.active, 2);
  assert.equal(stats.totalLinks, 1);
  assert.equal(stats.orphans, 0);
  assert.equal(stats.topHub.id, a.id);
  const section = store.buildPromptSection('phở bò', { scope: SCOPE });
  assert.ok(section.includes('phở bò'));
  assert.equal(store.buildPromptSection('zzz-khong-co', { scope: SCOPE }), '');
});

// ------------------------------------------------------------------ autolink

test('autolink: note giống nhau được gợi ý + tự gắn, note khác không', () => {
  const store = makeStore();
  const a = makeNote(store);
  const b = store.createNote({
    title: 'Quán phở bò ngon ở Hà Nội', body: 'Phở bò Hà Nội rất ngon, tôi ăn phở bò mỗi sáng.', kind: 'place', tags: ['an-uong'], scope: SCOPE,
  });
  store.createNote({ title: 'Lập trình TypeScript', body: 'Viết code TypeScript với vitest và node.', kind: 'project', tags: ['code'], scope: SCOPE });
  const engine = new AutoLinkEngine(store);
  const suggestions = engine.suggestLinksFor(b);
  assert.ok(suggestions.some((s) => s.targetId === a.id), 'phải gợi ý link tới note phở bò');
  assert.ok(!suggestions.some((s) => s.targetTitle.includes('TypeScript')));
  const auto = suggestions.find((s) => s.targetId === a.id);
  assert.ok(auto.score >= 0.35);
  assert.ok(auto.reason.length > 0);
});

test('autolink applyAutoLinks: gắn link auto + không gắn lại link đã có', () => {
  const store = makeStore();
  const a = makeNote(store);
  const b = store.createNote({
    title: 'Quán phở bò ngon ở Hà Nội', body: 'Phở bò Hà Nội rất ngon, tôi ăn phở bò mỗi sáng.', kind: 'place', tags: ['an-uong'], scope: SCOPE,
  });
  const engine = new AutoLinkEngine(store);
  const first = engine.applyAutoLinks(b.id);
  assert.ok(first.applied.length >= 1);
  assert.ok(store.getNote(b.id).links.some((l) => l.targetId === a.id && l.auto));
  const second = engine.applyAutoLinks(b.id);
  assert.equal(second.applied.length, 0); // đã có link → không gợi ý lại
});

test('autolink: part-of khi tiêu đề chứa nhau', () => {
  const store = makeStore();
  store.createNote({ title: 'Phở bò Hà Nội', body: 'Phở bò Hà Nội rất ngon.', kind: 'place', tags: ['an-uong'], scope: SCOPE });
  const child = store.createNote({ title: 'Phở bò', body: 'Phở bò là món ăn Việt Nam.', kind: 'fact', tags: ['an-uong'], scope: SCOPE });
  const engine = new AutoLinkEngine(store);
  const suggestions = engine.suggestLinksFor(child);
  assert.ok(suggestions.some((s) => s.kind === 'part-of'));
});

// ------------------------------------------------------------------ revisit

test('revisit append: thông tin mới bổ sung, version cũ giữ lại', () => {
  const store = makeStore();
  const note = makeNote(store);
  const engine = new RevisitEngine(store);
  const result = engine.applyRevisit(note.id, 'Tôi cũng thích ăn phở bò vào buổi tối.', { by: 'user' });
  assert.equal(result.decision, 'append');
  assert.equal(result.note.version, 2);
  assert.ok(result.note.body.includes('buổi tối'));
  assert.ok(result.note.body.includes('Hà Nội')); // nội dung cũ còn
  assert.equal(result.note.versions.length, 1);
});

test('revisit merge: thông tin trùng lặp cao thì gộp, không nhân đôi câu', () => {
  const store = makeStore();
  const note = makeNote(store);
  const engine = new RevisitEngine(store);
  const analysis = engine.analyze(note, 'Tôi rất thích ăn phở bò ở Hà Nội.');
  assert.equal(analysis.decision, 'merge');
  const result = engine.applyRevisit(note.id, 'Tôi rất thích ăn phở bò ở Hà Nội.');
  assert.equal(result.decision, 'merge');
  assert.equal(result.note.body, note.body); // câu đã có → không thêm
});

test('revisit contradiction: phủ định vào hàng chờ, note cũ KHÔNG đổi', () => {
  const store = makeStore();
  const note = makeNote(store);
  const engine = new RevisitEngine(store);
  const result = engine.applyRevisit(note.id, 'Tôi không còn thích ăn phở bò nữa, giờ tôi ghét phở bò.');
  assert.equal(result.decision, 'contradiction');
  assert.ok(result.conflictId);
  assert.equal(store.getNote(note.id).body, note.body);
  assert.equal(store.getNote(note.id).version, 1);
  const pending = store.listConflicts(SCOPE, 'pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].noteId, note.id);
});

test('revisit analyze: không sửa store', () => {
  const store = makeStore();
  const note = makeNote(store);
  const engine = new RevisitEngine(store);
  const analysis = engine.analyze(note, 'Tôi không thích phở bò nữa.');
  assert.equal(analysis.decision, 'contradiction');
  assert.equal(store.listConflicts(SCOPE, 'pending').length, 0);
  const noop = engine.analyze(note, 'Thời tiết hôm nay nắng đẹp ở Đà Lạt.');
  assert.equal(noop.decision, 'no-op');
});

test('resolveConflict supersede: note mới thay thế, note cũ đóng lại + kế thừa link', () => {
  const store = makeStore();
  const note = makeNote(store);
  const other = store.createNote({ title: 'Hà Nội', body: 'Thủ đô Việt Nam.', kind: 'place', scope: SCOPE });
  store.addLink(note.id, other.id, 'related');
  const engine = new RevisitEngine(store);
  const applied = engine.applyRevisit(note.id, 'Tôi không còn thích phở bò nữa.');
  const resolved = engine.resolveConflict(applied.conflictId, 'supersede', { by: 'user' });
  assert.equal(resolved.decision, 'supersede');
  assert.equal(store.getNote(note.id).status, 'superseded');
  assert.equal(resolved.note.supersedes, note.id);
  // Note mới kế thừa link của note cũ.
  assert.ok(resolved.note.links.some((l) => l.targetId === other.id));
  assert.ok(resolved.note.links.some((l) => l.kind === 'supersedes' && l.targetId === note.id));
  assert.equal(store.listConflicts(SCOPE, 'pending').length, 0);
  assert.equal(store.listConflicts(SCOPE, 'resolved').length, 1);
});

test('resolveConflict merge + keep-both', () => {
  const store = makeStore();
  const engine = new RevisitEngine(store);
  const note1 = makeNote(store);
  const c1 = engine.applyRevisit(note1.id, 'Tôi không thích phở bò nữa.');
  const merged = engine.resolveConflict(c1.conflictId, 'merge', { by: 'user' });
  assert.equal(merged.decision, 'merge');
  assert.equal(merged.note.version, 2);

  const note2 = store.createNote({ title: 'Bún chả', body: 'Tôi thích ăn bún chả.', kind: 'preference', scope: SCOPE });
  const c2 = engine.applyRevisit(note2.id, 'Tôi không thích bún chả nữa.');
  const kept = engine.resolveConflict(c2.conflictId, 'keep-both', { by: 'user' });
  assert.ok(kept.note);
  assert.equal(store.getNote(note2.id).status, 'active');
  assert.ok(kept.note.links.some((l) => l.kind === 'contradicts' && l.targetId === note2.id));
});

test('revisitQueue: note cũ + nhiều link lên đầu', () => {
  const store = makeStore();
  const engine = new RevisitEngine(store);
  const old = makeNote(store);
  const hub = store.createNote({ title: 'Hà Nội', body: 'Thủ đô.', kind: 'place', scope: SCOPE });
  store.addLink(old.id, hub.id, 'related');
  store.addLink(hub.id, old.id, 'related');
  // Giả tuổi: sửa trực tiếp updatedAt qua update (không đổi nội dung thì không sinh version).
  const queue = engine.revisitQueue(SCOPE, 10);
  assert.equal(queue.length, 2);
  assert.ok(queue[0].staleness >= queue[1].staleness);
});

// ------------------------------------------------------------------ graph export

test('graphExport: nodes/edges/stats/density + subgraph + DOT + timeline', () => {
  const store = makeStore();
  const a = makeNote(store);
  const b = store.createNote({ title: 'Quán phở', body: 'Quán phở ngon.', kind: 'place', tags: ['an-uong'], scope: SCOPE });
  const c = store.createNote({ title: 'Code', body: 'Viết code.', kind: 'project', scope: SCOPE });
  store.addLink(a.id, b.id, 'related', { weight: 0.9 });
  store.updateNote(a.id, { body: 'Tôi thích phở bò và bún chả.', reason: 'them-mon' });
  const graph = exportNotesGraph(store, { scope: SCOPE });
  assert.equal(graph.nodeCount, 3);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.stats.orphans, 1);
  assert.equal(graph.stats.byKind.preference, 1);
  assert.ok(graph.stats.density > 0);
  const nodeA = graph.nodes.find((n) => n.id === a.id);
  assert.equal(nodeA.version, 2);
  assert.equal(nodeA.degree, 1);

  const sub = exportNotesGraph(store, { scope: SCOPE, centerNoteId: a.id, depth: 1 });
  assert.equal(sub.nodeCount, 2); // a + b, không có c
  assert.ok(sub.nodes.some((n) => n.id === b.id));
  assert.ok(!sub.nodes.some((n) => n.id === c.id));

  const dot = exportNotesDot(store, { scope: SCOPE });
  assert.ok(dot.includes('digraph notes'));
  assert.ok(dot.includes('related'));

  const timeline = exportNotesTimeline(store, { scope: SCOPE });
  assert.ok(timeline.some((e) => e.type === 'created' && e.noteId === a.id));
  assert.ok(timeline.some((e) => e.type === 'updated' && e.noteId === a.id));
  assert.ok(timeline.some((e) => e.type === 'linked'));

  const adj = adjacencyListText(store, { scope: SCOPE });
  assert.ok(adj.includes('Tôi thích phở bò'));
  assert.ok(adj.includes('related'));
});
