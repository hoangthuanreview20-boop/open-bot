/**
 * Workflow mẫu kèm sẵn của open-bot (v0.12).
 *
 * Điều phối viên nối sau: đăng ký 2 workflow này thành tool/lệnh cho
 * agent gọi (vd tool `run_workflow` nhận `workflowId`), với runner thật
 * nối vào AgentRunner + tool registry.
 */
export { researchBriefWorkflow } from './research-brief';
export { planEditTestFixWorkflow } from './plan-edit-test-fix';
