import type { ApprovalRequest } from '../types';

interface Props {
  approval: ApprovalRequest;
  onRespond: (callId: string, approved: boolean) => void;
}

function toolName(call: ApprovalRequest['call']): string {
  return String(call.name ?? call.tool ?? 'tool');
}

export default function ApprovalCard({ approval, onRespond }: Props) {
  return (
    <div className="approval" role="alert">
      <h3>⏸️ Bot muốn chạy công cụ — cần bạn duyệt</h3>
      <p style={{ margin: '0 0 8px' }}>
        <strong>{toolName(approval.call)}</strong>
      </p>
      <pre style={{ margin: '0 0 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
        {JSON.stringify(approval.call.args ?? approval.call.arguments ?? approval.call, null, 2)}
      </pre>
      <div className="row">
        <button className="btn ok" onClick={() => onRespond(approval.callId, true)}>✓ Đồng ý</button>
        <button className="btn danger" onClick={() => onRespond(approval.callId, false)}>✕ Từ chối</button>
      </div>
    </div>
  );
}
