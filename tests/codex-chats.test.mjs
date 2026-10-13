import test from 'node:test';
import assert from 'node:assert/strict';
import { isOddinChat } from '../scripts/cleanup-codex-chats.mjs';
import { JobManager } from '../lib/jobs.mjs';

test('채팅 정리: ODDIN 내부 지시문만 선택하고 사용자 대화는 유지', () => {
  for (const preview of [
    '[AI Hub 작업] 작업 20261013-예시/t1 · 담당: codex',
    '당신은 로컬 AI 작업 허브의 플래너입니다. 사용자의 목표를 처리할 계획을 세우세요.',
    '당신은 AI 작업 허브의 보고 담당입니다.',
    '당신은 AI 작업 허브(ODDIN)의 기억 정리 담당입니다.',
    '당신은 작업마다 AI 담당을 정합니다.',
  ]) assert.equal(isOddinChat({ preview }), true, preview);
  for (const preview of ['오딘 채팅 생성 막고 정리', '오딘 버그 고쳐줘', '내 프로젝트 구현', '이 문서에는 [AI Hub 작업] 예시가 있다']) {
    assert.equal(isOddinChat({ preview }), false, preview);
  }
  assert.equal(isOddinChat({ originator: 'ai-hub', title: '이름을 바꾼 내부 채팅' }), true);
  assert.equal(isOddinChat({}), false);
});

test('임시 Codex 세션 ID는 후속 요청에서 재개하지 않는다', () => {
  assert.equal(JobManager.prototype.continuation.call({ config: {} }, {}, { assignee: 'codex' }), null);
});
