import { randomUUID } from 'node:crypto';
import { resolveAttachments } from './attachments.mjs';

export const INTERCEPT_CAPABILITIES = { intercept: 1 };
export function interceptError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
export function normalizeIntercept(body, validateFiles = true) {
  const invalid = (s) => { throw interceptError(400, 'INVALID_INTERCEPT', s); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('수정 지시 형식이 잘못되었습니다');
  if (typeof body.sessionId !== 'string' || !body.sessionId) invalid('대화 ID가 필요합니다');
  if (typeof body.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientRequestId)) invalid('요청 ID 형식이 잘못되었습니다');
  if (body.text !== undefined && typeof body.text !== 'string') invalid('수정 지시는 문자열이어야 합니다');
  let text = (body.text || '').trim();
  if (text.length > 20000) invalid('수정 지시는 20,000자 이하만 가능합니다');
  const list = body.attachments ?? [];
  if (!Array.isArray(list) || list.length > 4 || list.some((a) => !a || typeof a !== 'object' || typeof a.id !== 'string' || (a.name !== undefined && typeof a.name !== 'string'))) invalid('첨부 형식이 잘못되었습니다');
  let attachments;
  try { attachments = validateFiles ? resolveAttachments(list).map(({ id, name, mime, size }) => ({ id, name, mime, size })) : list.map((a) => ({ id: a.id, name: a.name ? a.name.slice(0, 120) : a.id })); }
  catch (e) { invalid(e.message); }
  if (!text && !attachments.length) invalid('수정 지시가 비어 있습니다');
  if (!text) text = '첨부한 이미지를 현재 작업의 수정 지시로 확인하세요.';
  return { sessionId: body.sessionId, clientRequestId: body.clientRequestId, text, attachments };
}
export const fingerprint = (x) => JSON.stringify([x.text, x.attachments.map((a) => [a.id, a.name])]);
export function newDelivery(key, phase, taskId = null, recorded = false) {
  return { key, phase, taskId, status: recorded ? 'recorded' : 'waiting', mode: recorded ? 'prompt' : null, messageId: randomUUID(), cliSessionId: null, turnId: null, generation: null, deliveredAt: null, error: null };
}
export function aggregateIntercept(i) {
  const ds = i.deliveries || [];
  if (i.status === 'cancelled') return i.status;
  if (ds.some((d) => d.status === 'sending')) return 'applying';
  if (ds.some((d) => d.status === 'waiting')) return 'accepted';
  const failed = ds.some((d) => ['failed', 'uncertain'].includes(d.status));
  const success = ds.some((d) => ['recorded', 'delivered'].includes(d.status));
  if (failed) return success ? 'partial' : 'failed';
  if (ds.some((d) => d.status === 'cancelled') && ds.some((d) => d.status === 'delivered')) return 'partial';
  if (ds.some((d) => d.status === 'delivered')) return 'delivered';
  if (ds.length && ds.every((d) => d.status === 'cancelled')) return 'cancelled';
  return 'accepted';
}
export function instructionText(source, after = 0) {
  const list = (source.intercepts || []).filter((i) => i.revision > after && i.status !== 'cancelled');
  if (!list.length) return '';
  return '\n# 실행 중 받은 수정 지시 (원래 목표와 완료 결과를 유지하고, 충돌하는 부분은 뒤의 지시 우선)\n' + list.map((i) => `## 수정 지시 #${i.seq}\n${i.text}${i.attachments?.length ? '\n첨부: ' + i.attachments.map((a) => a.name).join(', ') : ''}`).join('\n\n') + '\n담당 범위와 파일 소유권을 유지하고, 이미 수행한 변경을 확인한 뒤 남은 일을 이어서 처리하세요.\n';
}
