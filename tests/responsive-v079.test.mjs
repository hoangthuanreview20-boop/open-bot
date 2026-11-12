/**
 * Tests cho v0.79c — responsive / cửa sổ hẹp (UI parity §7).
 *
 * Static wiring checks (no Electron needed):
 *  - styles.css has the 1100/900/720px breakpoints, the collapsed
 *    sidebar rules, the group-layout stacking rules and the tray
 *    stacking rule.
 *  - GroupView uses the `group-layout` / `group-side` / `group-main`
 *    classes (no inline fixed-width left column anymore).
 *  - Sidebar accepts a `collapsed` prop + toggle, and App owns the
 *    `sidebarCollapsed` state (initially collapsed under 760px) and
 *    passes it down; the app body carries the `app-body` class the
 *    720px breakpoint stacks.
 *
 * The real collapsed rendering (names hidden, avatar clickable) is
 * covered by tests/sidebar-collapse-v079-renderer.test.mjs under xvfb.
 *
 * Run: node --test tests/responsive-v079.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

test('responsive: styles.css has breakpoints + collapsed + stacking rules', () => {
  const css = read('apps/desktop/src/renderer/styles.css');
  for (const bp of ['@media (max-width: 1100px)', '@media (max-width: 900px)', '@media (max-width: 720px)']) {
    assert.ok(css.includes(bp), `styles.css thiếu breakpoint ${bp}`);
  }
  // Collapsed sidebar: 64px rail, text hidden, dropdown still usable.
  assert.match(css, /\.sidebar\.collapsed\s*\{[^}]*width:\s*64px/);
  assert.ok(css.includes('.sidebar.collapsed .bot-item .name'), 'collapsed phải ẩn tên bot');
  assert.ok(css.includes('.sidebar.collapsed .sidebar-note'), 'collapsed phải ẩn ghi chú local-first');
  assert.match(css, /\.sidebar\.collapsed \.sidebar-nav-dropdown\s*\{[^}]*width:\s*220px/);
  // Group columns + tray stack at 720px.
  assert.ok(css.includes('.group-layout { flex: 1; display: flex;'), 'group-layout class');
  assert.ok(css.includes('.group-side { width: 260px;'), 'group-side class');
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.group-layout \{ flex-direction: column/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.app-body \{ flex-direction: column/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.approval-tray \{ width: auto/);
  // Bubbles widen as the window narrows.
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.msg \{ max-width: 92%/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.msg \{ max-width: 100%/);
});

test('responsive: GroupView uses layout classes, no inline fixed column', () => {
  const src = read('apps/desktop/src/renderer/components/GroupView.tsx');
  assert.ok(src.includes('className="group-layout"'), 'GroupView dùng group-layout');
  assert.ok(src.includes('className="group-side"'), 'GroupView dùng group-side');
  assert.ok(src.includes('className="group-main"'), 'GroupView dùng group-main');
  assert.ok(!src.includes('width: 260'), 'không còn cột trái inline 260px');
});

test('responsive: Sidebar collapse prop + App owns the state', () => {
  const sidebar = read('apps/desktop/src/renderer/components/Sidebar.tsx');
  assert.ok(sidebar.includes('collapsed: boolean;'), 'Sidebar nhận prop collapsed');
  assert.ok(sidebar.includes('onToggleCollapse: () => void;'), 'Sidebar nhận onToggleCollapse');
  assert.ok(sidebar.includes("className={collapsed ? 'sidebar collapsed' : 'sidebar'}"), 'aside đổi class khi gập');
  assert.ok(sidebar.includes('data-testid="sidebar-collapse-toggle"'), 'nút thu gọn có testid');
  assert.ok(sidebar.includes("title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}"), 'toggle có title theo trạng thái');
  assert.ok(sidebar.includes('sidebar.collapse'), 'dùng key i18n collapse');
  const app = read('apps/desktop/src/renderer/App.tsx');
  assert.ok(app.includes('sidebarCollapsed'), 'App có state sidebarCollapsed');
  assert.ok(app.includes('window.innerWidth < 760'), 'cửa sổ hẹp (< 760px) bắt đầu ở trạng thái gập');
  assert.ok(app.includes('collapsed={sidebarCollapsed}'), 'App truyền collapsed xuống Sidebar');
  assert.ok(app.includes('className="app-body"'), 'app body có class cho breakpoint 720px');
});
