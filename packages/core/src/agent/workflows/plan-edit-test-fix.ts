/**
 * Workflow mẫu: plan → edit → test → fix (v0.12).
 *
 * Lập kế hoạch sửa code, sửa, chạy test, nếu fail thì fix rồi test lại:
 *   plan (agent) → edit (agent) → test (tool shell_exec)
 *   → branch: test pass → end; test fail → fix (agent) → test lại.
 *
 * Cycle test → fix → test được giới hạn bởi `maxIterations: 4`
 * (tối đa 4 lần chạy node `test`, tính cả lần đầu) nên không lặp vô
 * hạn; vượt giới hạn executor trả status `max-iterations` kèm state
 * để debug/resume.
 *
 * Quy ước output của node `test`: runner thật trả chuỗi kết quả test
 * (vd stdout của `npm test`); điều kiện rẽ nhánh kiểm tra chuỗi đó
 * có chứa "fail" hay không (không phân biệt hoa/thường). Runner cũng
 * có thể đặt `stateUpdates: { testPassed: true }` và đổi điều kiện
 * thành `{ field: 'testPassed', equals: true }` — xem ghi chú ở edge.
 *
 * Chạy bằng `runWorkflow(planEditTestFixWorkflow, runner,
 * { initialState: { task: '...', files: '...' } })`.
 */
import { defineWorkflow } from '../workflow';
import type { WorkflowDefinition } from '../workflow';

export const planEditTestFixWorkflow: WorkflowDefinition = defineWorkflow({
  id: 'plan-edit-test-fix',
  name: 'Lập plan → Sửa code → Test → Fix',
  description:
    'Lập plan sửa code theo yêu cầu, sửa code, chạy test; nếu test fail thì fix rồi test lại, tối đa 4 vòng.',
  startNodeId: 'plan',
  maxIterations: 4,
  nodes: [
    {
      id: 'plan',
      kind: 'agent',
      description: 'Lập plan sửa code: các file chạm tới + thứ tự làm.',
      prompt:
        'Lập plan ngắn gọn (tối đa 8 bước) để thực hiện yêu cầu sau, ghi rõ file nào cần sửa:\n' +
        'Yêu cầu: {{task}}\nFile liên quan (nếu có): {{files}}',
    },
    {
      id: 'edit',
      kind: 'agent',
      description: 'Sửa code theo plan.',
      prompt:
        'Sửa code theo plan sau để thực hiện yêu cầu "{{task}}". ' +
        'Chỉ sửa đúng file trong plan, không đổi hành vi ngoài yêu cầu.\nPlan:\n{{plan}}',
    },
    {
      id: 'test',
      kind: 'tool',
      description: 'Chạy test để kiểm tra bản sửa.',
      toolName: 'shell_exec',
      args: { command: 'npm test 2>&1 | tail -n 50' },
    },
    {
      id: 'check',
      kind: 'branch',
      description: 'Rẽ nhánh theo kết quả test: pass thì xong, fail thì fix.',
    },
    {
      id: 'fix',
      kind: 'agent',
      description: 'Sửa lỗi theo output test rồi test lại.',
      prompt:
        'Test vừa fail. Sửa code (dựa trên plan "{{plan}}") để khắc phục lỗi sau, ' +
        'không sửa test để cho qua:\n{{test}}',
    },
    { id: 'end', kind: 'end', description: 'Test pass — xong.' },
  ],
  edges: [
    { from: 'plan', to: 'edit' },
    { from: 'edit', to: 'test' },
    { from: 'test', to: 'check' },
    { from: 'check', to: 'end', condition: { field: 'test', notContains: 'fail' }, description: 'test pass (output không chứa "fail") → xong' },
    { from: 'check', to: 'fix', condition: { field: 'test', contains: 'fail' }, description: 'test fail → fix rồi test lại' },
    { from: 'fix', to: 'test' },
  ],
});
