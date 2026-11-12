/**
 * Workflow mẫu: research → brief (v0.12).
 *
 * Nghiên cứu một chủ đề rồi tổng hợp thành brief ngắn:
 *   search (tool web_search) → read (tool web_fetch, 2 nguồn song song)
 *   → synthesize (agent) → end.
 *
 * Chạy bằng `runWorkflow(researchBriefWorkflow, runner, { initialState: { topic } })`.
 * Runner thật (điều phối viên nối sau): node `tool` → tool trong
 * registry (`web_search`, `web_fetch`); node `agent` → AgentRunner với
 * `node.prompt`. Template `{{topic}}` được executor render từ state
 * trước khi gọi runner.
 */
import { defineWorkflow } from '../workflow';
import type { WorkflowDefinition } from '../workflow';

export const researchBriefWorkflow: WorkflowDefinition = defineWorkflow({
  id: 'research-brief',
  name: 'Nghiên cứu → Brief',
  description:
    'Tìm kiếm thông tin về một chủ đề, đọc 2 nguồn, rồi tổng hợp thành brief ngắn có nguồn dẫn.',
  startNodeId: 'search',
  maxIterations: 3,
  nodes: [
    {
      id: 'search',
      kind: 'tool',
      description: 'Tìm kiếm các nguồn về chủ đề.',
      toolName: 'web_search',
      args: { query: '{{topic}}' },
    },
    {
      id: 'read',
      kind: 'parallel',
      description: 'Đọc song song 2 nguồn đầu tiên tìm được.',
      branches: ['read-source-1', 'read-source-2'],
    },
    {
      id: 'read-source-1',
      kind: 'tool',
      description: 'Đọc nguồn thứ nhất.',
      toolName: 'web_fetch',
      args: { url: '{{search.results.0.url}}' },
    },
    {
      id: 'read-source-2',
      kind: 'tool',
      description: 'Đọc nguồn thứ hai.',
      toolName: 'web_fetch',
      args: { url: '{{search.results.1.url}}' },
    },
    {
      id: 'synthesize',
      kind: 'agent',
      description: 'Tổng hợp brief từ các nguồn đã đọc.',
      prompt:
        'Tổng hợp một brief ngắn (tối đa 10 gạch đầu dòng) về chủ đề "{{topic}}" ' +
        'dựa trên các nguồn sau, ghi rõ nguồn dẫn cho từng ý chính:\n' +
        'Nguồn 1: {{read-source-1}}\nNguồn 2: {{read-source-2}}',
    },
    { id: 'end', kind: 'end', description: 'Brief đã xong.' },
  ],
  edges: [
    { from: 'search', to: 'read' },
    { from: 'read', to: 'synthesize' },
    { from: 'synthesize', to: 'end' },
  ],
});
