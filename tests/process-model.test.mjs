import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/process-model.js', import.meta.url), 'utf8');
// 저장소는 모듈 방식이므로 공통 스크립트의 공용 모듈 분기를 별도 문맥에서 읽는다
const context = { module: { exports: {} } };
vm.runInNewContext(source, context);
const M = context.module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const at = (s) => new Date(Date.UTC(2026, 9, 3) + s * 1000).toISOString();
const tool = (id, name = 'Bash', s = 0, extra = {}) => ({ kind: 'tool', callId: id, name, at: at(s), startedAt: at(s), status: 'done', endedAt: at(s + 1), input: { command: 'npm test' }, ...extra });
const job = (extra = {}) => ({ id: 'j', mode: 'codex', status: 'running', startedAt: at(0), tasks: [{ id: 't1', title: '구현', assignee: 'codex', status: 'running', startedAt: at(0) }], ...extra });
const prompt = (extra = {}) => ({ id: 'p', jobId: 'j', taskId: 't1', createdAt: at(2), kind: 'approval', status: 'pending', ...extra });

test('브라우저 전역과 공용 모듈에 같은 계산 함수를 노출한다', () => {
  const browser = { window: {} }; vm.runInNewContext(source, browser);
  assert.deepEqual(Object.keys(browser.window.ProcessModel), Object.keys(M));
});

test('도구 종류는 명령·읽기·검색·수정과 그 외 종류를 구분한다', () => {
  for (const [kind, names] of Object.entries({ cmd: ['Bash', 'PowerShell', 'commandExecution', 'exec_command'], edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'fileChange'], read: ['Read'], search: ['Grep', 'Glob', 'ToolSearch'], web: ['WebFetch', 'WebSearch', 'Fetch'], mcp: ['MCP 자료'], ask: ['AskUserQuestion'], plan: ['ExitPlanMode'], agent: ['Agent', 'Task'], other: ['기타', ''] })) for (const name of names) assert.equal(M.toolKind(name), kind, name);
});

test('호출 시작·종료는 최초 위치와 입력을 보존하며 한 항목으로 합친다', () => {
  const start = tool('a', 'Bash', 0, { status: 'running', endedAt: null });
  const end = { kind: 'tool', callId: 'a', at: at(3), status: 'done', endedAt: at(3), output: '성공' };
  const records = [start, { kind: 'message', at: at(1), text: '설명' }, end], before = JSON.stringify(records);
  const result = M.mergeCalls(records);
  assert.equal(result.length, 2); assert.equal(result[0].at, at(0)); assert.equal(result[0].output, '성공'); assert.equal(result[0].input.command, 'npm test');
  assert.equal(JSON.stringify(records), before);
});

test('종료만 남은 호출·불투명 호출 식별자·예전 기록도 보존한다', () => {
  const list = M.itemsFor([tool('범위/exec-1'), tool('다른범위/exec-1'), { kind: 'tool', name: 'Read', at: at(2), detail: 'a.txt' }, { kind: 'tool', name: 'Read', at: at(3), detail: 'a.txt' }], [], 'j/t1');
  assert.equal(list.length, 4); assert.notEqual(list[2].id, list[3].id);
  assert.equal(list[2].callId, undefined);
});

test('숨김 기록·경고·대기는 단계 수에서 제외하고 호출별 명령·수정·오류를 센다', () => {
  const records = ['init', 'turn', 'memory', 'raw', 'result'].map((kind) => ({ kind, at: at(0) }));
  records.push(tool('a', 'Bash', 1, { status: 'running' }), tool('a', 'Bash', 1, { status: 'error' }), tool('b', 'Edit', 2), { kind: 'thinking', at: at(3), text: '**Inspecting.**' }, { kind: 'message', at: at(4), text: '설명' }, { kind: 'intercept', at: at(5), text: '지시' }, { kind: 'tool_error', at: at(6), text: '문제' }, { kind: 'error', at: at(7), text: '실패' }, { kind: 'stderr', at: at(8), text: '경고' }, { kind: 'waiting', at: at(9), waiting: true });
  const list = M.itemsFor(records, [prompt({ createdAt: at(10) })]);
  assert.deepEqual(plain(M.counts(list)), { steps: 8, commands: 1, edits: 1, errors: 3 });
  assert.equal(list.some((e) => ['init', 'turn', 'memory', 'raw', 'result'].includes(e.kind)), false);
});

test('명령 종료 코드는 명시 값·흡수한 오류·출력 끝에서 읽는다', () => {
  assert.equal(M.exitCode({ exitCode: 0 }), 0); assert.equal(M.exitCode({ exit_code: -1 }), -1);
  assert.equal(M.exitCode({ errorText: 'exit 2: 실패', output: 'exit 3' }), 2);
  assert.equal(M.exitCode({ output: '출력\nexit 3\n' }), 3);
  assert.equal(M.exitCode({ output: 'exit 9\n다른 출력' }), null);
  assert.equal(M.exitCode({ output: '설명', exitCode: '잘못됨' }), null);
});

test('2초 이내 직전 실패 명령의 종료 코드 오류는 그 카드로 흡수한다', () => {
  const result = M.itemsFor([tool('a', 'Bash', 0, { status: 'error', endedAt: at(4) }), { kind: 'tool_error', at: at(6), text: 'exit 7: 실패' }]);
  assert.equal(result.length, 1); assert.equal(result[0].exitCode, 7);
  assert.deepEqual(plain(M.counts(result)), { steps: 1, commands: 1, edits: 0, errors: 1 });
});

test('결과 없이 닫힌 호출과 실제 명령 오류 출력을 구분한다', () => {
  for (const output of ['', '도구 결과를 받기 전에 실행이 종료되었습니다', '작업이 중지되었습니다', '새 턴이 시작되어 이전 도구 결과를 확인할 수 없습니다']) assert.equal(M.missingResult({ status: 'error', output }), true);
  assert.equal(M.missingResult({ status: 'error', output: '실제 명령 실패' }), false);
  assert.equal(M.missingResult({ status: 'done', output: '' }), false);
  assert.equal(M.missingResult({ status: 'error', output: '', errorText: 'exit 1: 실패' }), false);
});

test('성공·다른 종류·2초 초과·중간 항목이 있는 오류는 흡수하지 않는다', () => {
  for (const [prev, middle, error] of [
    [tool('a'), [], { kind: 'tool_error', at: at(2), text: 'exit 1: 실패' }],
    [tool('a', 'Edit', 0, { status: 'error' }), [], { kind: 'tool_error', at: at(2), text: 'exit 1: 실패' }],
    [tool('a', 'Bash', 0, { status: 'error' }), [], { kind: 'tool_error', at: at(4), text: 'exit 1: 실패' }],
    [tool('a', 'Bash', 0, { status: 'error' }), [{ kind: 'message', at: at(1), text: '설명' }], { kind: 'error', at: at(2), text: 'exit 1: 실패' }],
    [tool('a', 'Bash', 0, { status: 'error' }), [], { kind: 'tool_error', at: at(2), text: '다른 오류' }],
  ]) assert.equal(M.itemsFor([prev, ...middle, error]).length, 2 + middle.length);
});

test('생각 요약은 제목 표식·공백·마침표만 정리하고 번역·대소문자 변경을 하지 않는다', () => {
  assert.equal(M.thinkingTitle('  ## **Inspecting reference docs.** \n\n **checking tests**.  '), 'Inspecting reference docs\nchecking tests');
  assert.equal(M.thinkingTitle('Fix v1.2?\n# Another title'), 'Fix v1.2?\nAnother title');
  assert.equal(M.thinkingTitle('## **Checking tests.** ##'), 'Checking tests');
  const list = M.itemsFor([{ kind: 'thinking', text: 'A' }, { kind: 'thinking', text: 'B' }]);
  assert.equal(M.groupItems(list, 'j/t1').length, 2);
});

test('연속 읽기·검색 3개부터 묶고 2개는 개별 항목으로 둔다', () => {
  const list = M.itemsFor([tool('a', 'Read'), tool('b', 'Grep', 1), tool('c', 'Read', 2)]);
  const grouped = M.groupItems(list, 'j/t1'); assert.equal(grouped.length, 1);
  assert.equal(grouped[0].label, '파일 2개 읽음 · 검색 1회'); assert.equal(grouped[0].startedAt, at(0)); assert.equal(grouped[0].endedAt, at(3));
  assert.equal(M.groupItems(list.slice(0, 2), 'j/t1').length, 2);
  assert.equal(M.counts(list).steps, 3);
});

test('설명·생각·승인·경고는 읽기 묶음의 경계를 만든다', () => {
  for (const kind of ['message', 'thinking', 'stderr', 'prompt']) {
    const list = [tool('a', 'Read'), tool('b', 'Read'), { kind, id: 'x', at: at(2), text: '설명' }, tool('c', 'Read')].map((e) => ({ ...e, toolKind: e.kind === 'tool' ? 'read' : undefined }));
    assert.equal(M.groupItems(list, 'j/t1').some((e) => e.kind === 'group'), false);
  }
});

test('묶음은 0인 종류를 빼고 실행·오류 상태를 보존한다', () => {
  const reads = M.itemsFor([tool('a', 'Read'), tool('b', 'Read'), tool('c', 'Read', 2, { status: 'running', endedAt: null })]);
  const group = M.groupItems(reads, 'j/t1')[0]; assert.equal(group.label, '파일 3개 읽음'); assert.equal(group.status, 'running');
  const searches = M.itemsFor([tool('a', 'Grep'), tool('b', 'Glob'), tool('c', 'ToolSearch', 2, { status: 'error' })]);
  assert.equal(M.groupItems(searches, 'j/t1')[0].label, '검색 3회'); assert.equal(M.groupItems(searches, 'j/t1')[0].status, 'error');
});

test('겹쳐 실행된 읽기 묶음은 가장 늦은 종료까지 소요를 계산한다', () => {
  const list = M.itemsFor([tool('a', 'Read', 0, { endedAt: at(8) }), tool('b', 'Read', 1), tool('c', 'Read', 2)]);
  assert.equal(M.groupItems(list, 'j/t1')[0].endedAt, at(8));
});

test('흩어진 경고는 첫 위치에 모으며 원문을 변경하지 않고 400자로 자른다', () => {
  const records = [{ kind: 'message', at: at(0), text: '설명' }, { kind: 'stderr', at: at(1), text: '가'.repeat(500) }, tool('a', 'Bash', 2), { kind: 'stderr', at: at(3), text: '두 번째' }];
  const list = M.itemsFor(records), rows = M.groupItems(list, 'j/t1');
  assert.equal(rows.length, 3); assert.equal(rows[1].label, '경고 2건'); assert.equal(rows[1].items[0].text.length, 400); assert.equal(records[1].text.length, 500);
});

test('승인 요청을 생성 시각에 삽입하고 기존 항목의 순서는 보존한다', () => {
  const items = M.itemsFor([tool('a', 'Bash', 0), { kind: 'message', at: at(3), text: '설명' }], [prompt()]);
  assert.deepEqual(plain(items.map((e) => e.kind)), ['tool', 'prompt', 'message']);
  assert.equal(items[1].prompt.status, 'pending');
  assert.equal(M.itemsFor([], [prompt({ status: 'answered' })])[0].id, M.itemsFor([], [prompt()])[0].id);
});

test('대기 기록은 ±5초 안에 요청이 있을 때 숨기고 응답 대기 종료도 숨긴다', () => {
  const waiting = { kind: 'waiting', at: at(10), waiting: true };
  for (const s of [5, 15]) assert.equal(M.itemsFor([waiting], [prompt({ createdAt: at(s) })]).some((e) => e.kind === 'waiting'), false);
  assert.equal(M.itemsFor([waiting], [prompt({ createdAt: at(16) })]).find((e) => e.kind === 'waiting').text, '사용자 응답 기다리는 중');
  assert.equal(M.itemsFor([{ ...waiting, waiting: false }]).length, 0);
});

test('섹션은 계획 다음 작업 순서이고 요청·호출은 섹션을 넘어서 합치지 않는다', () => {
  const j = job({ mode: 'auto', planner: 'claude', tasks: [{ id: 't2', title: '둘', assignee: 'claude', status: 'done' }, { id: 't1', title: '하나', assignee: 'codex', status: 'running' }] });
  const logs = new Map([['j/plan', [{ kind: 'message', at: at(0), text: '계획' }]], ['j/t1', [tool('same')]], ['j/t2', [tool('same', 'Edit')]]]);
  const model = M.build(j, logs, [prompt({ taskId: undefined }), prompt({ id: 'p2', taskId: 't2' }), prompt({ id: 'other', jobId: '다른작업' })]);
  assert.deepEqual(plain(model.sections.map((s) => s.taskId)), ['plan', 't2', 't1']);
  assert.deepEqual(plain(model.counts), { steps: 5, commands: 1, edits: 1, errors: 0 }); assert.equal(model.multi, true);
  assert.equal(model.sections[0].items.filter((e) => e.kind === 'prompt').length, 1);
});

test('계획 승인만 있어도 계획 섹션을 만들며 계획 없는 단일 작업은 머리가 필요 없다', () => {
  const plan = M.build(job({ mode: 'auto', status: 'planning', tasks: [] }), {}, [prompt({ taskId: 'plan', kind: 'plan' })]);
  assert.equal(plan.sections[0].title, '계획'); assert.equal(plan.sections[0].waiting, true);
  const single = M.build(job(), { 'j/t1': [tool('a')] }); assert.equal(single.multi, false); assert.equal(single.sections.length, 1);
});

test('미리보기는 최근 갱신을 고르며 명령 첫 줄과 담당을 보여 준다', () => {
  const logs = { 'j/t1': [tool('a', 'Bash', 0, { endedAt: at(5), input: { command: 'npm test\ngit status' } }), { kind: 'message', at: at(2), text: '설명' }, { kind: 'stderr', at: at(7), text: '경고' }] };
  const model = M.build(job(), logs); assert.equal(model.preview.text, 'npm test'); assert.equal(model.preview.mono, true); assert.equal(model.preview.assignee, 'codex');
  assert.equal(M.preview([]), null);
});

test('미리보기는 긴 설명을 한 줄로 자르고 수정 지시·승인도 포함한다', () => {
  assert.equal(M.preview([{ kind: 'message', at: at(1), text: '가\n'.repeat(200) }]).text.length, 160);
  assert.equal(M.preview([{ kind: 'intercept', at: at(1), text: '지시' }]).text, '지시');
  assert.equal(M.preview([{ kind: 'prompt', at: at(1), prompt: { title: '질문' } }]).text, '질문');
});

test('기록 없는 완료 작업은 숨기고 실행 중이면 시작하는 줄을 표시한다', () => {
  assert.equal(M.build(job({ status: 'done' }), {}).visible, false);
  assert.equal(M.build(job({ status: 'queued', tasks: [] }), {}).visible, false);
  for (const status of ['planning', 'running', 'reporting']) assert.equal(M.build(job({ status }), {}).visible, true);
  assert.equal(M.build(job({ status: 'done' }), { 'j/t1': [{ kind: 'result' }] }).visible, false);
});

test('승인·작업 대기와 완료·실패·중단 상태를 요약한다', () => {
  assert.equal(M.build(job(), {}, [prompt()]).status, 'waiting');
  assert.equal(M.build(job({ waiting: true }), {}).status, 'waiting');
  assert.equal(M.build(job({ tasks: [{ id: 't1', waiting: true }] }), {}).status, 'waiting');
  for (const status of ['done', 'partial', 'failed']) assert.equal(M.build(job({ status }), {}).status, status);
  for (const status of ['cancelled', 'interrupted']) assert.equal(M.build(job({ status }), {}).status, 'stopped');
  for (const status of ['done', 'failed', 'cancelled', 'interrupted', 'skipped']) assert.equal(M.terminal(status), true);
  assert.equal(M.terminal('running'), false);
});

test('경과·소요·상대 시간은 초·분·시간 경계와 잘못된 시각을 처리한다', () => {
  assert.equal(M.elapsed(at(0), at(2.4), true), '2.4초');
  assert.equal(M.elapsed(at(0), at(10), true), '10초');
  assert.equal(M.elapsed(at(0), at(65)), '1분 05초');
  assert.equal(M.elapsed(at(0), at(3665)), '1시간 1분');
  assert.equal(M.offset(at(0), at(65)), '+1:05'); assert.equal(M.offset(at(0), at(3665)), '+1:01:05');
  assert.equal(M.elapsed(at(5), at(1)), '0초'); assert.equal(M.offset('잘못됨', at(1)), ''); assert.equal(M.elapsed(null, at(1)), '');
});

test('200개가 넘는 기록도 묶기 전 수와 안정적인 항목 식별자를 유지한다', () => {
  const records = Array.from({ length: 450 }, (_, i) => ({ kind: 'message', at: at(i), text: `단계 ${i}` }));
  const result = M.build(job(), { 'j/t1': records }); assert.equal(result.counts.steps, 450);
  assert.equal(result.sections[0].rows.length, 450); assert.equal(result.sections[0].items[250].id, 'j/t1#l250');
});

test('전체 계산은 입력 기록·요청·작업을 변경하지 않는다', () => {
  const j = job(), records = { 'j/t1': [tool('a'), { kind: 'stderr', text: '경고' }] }, requests = [prompt()];
  const before = JSON.stringify([j, records, requests]); M.build(j, records, requests); assert.equal(JSON.stringify([j, records, requests]), before);
});

function renderer() {
  const events = {}, nodes = new Map(), state = { jobs: new Map(), logs: new Map(), loadedLogs: new Set(), open: new Set() };
  const p = { map: new Map(), toolOpen: new Set(), toolFull: new Set() };
  const thread = { addEventListener: (kind, fn) => { events[kind] = fn; } };
  const document = { getElementById: (id) => nodes.get(id) || null, querySelectorAll: () => [], querySelector: () => null, addEventListener: (kind, fn) => { events[kind] = fn; } };
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const scope = vm.createContext({ window: { ProcessModel: M, addEventListener() {} }, document, S: state, P: p, $: () => thread, esc: escape, icon: (name) => `<span class="ico" data-icon="${name}"></span>`, md: escape, hm: (s) => s ? '09:00' : '', dur: M.elapsed, stIcon: (s) => `<span class="st">${s}</span>`, ST_KO: { cancelled: '중지됨', interrupted: '중단됨' }, MutationObserver: class { observe() {} }, setInterval() {}, rerenderJob: (id) => { scope.lastRender = scope.window.hubJobProcess(state.jobs.get(id)); }, queueRerender() {}, CSS: { escape: (s) => s } });
  const helpers = fs.readFileSync(new URL('../public/prompts.js', import.meta.url), 'utf8');
  vm.runInContext(`const CAT_KO = { command:'명령 실행', file:'파일 변경', permission:'추가 권한', network:'네트워크 접근' }; const ACT_KO = { allow:'허용함', allow_session:'이 작업 동안 허용함', deny:'거절함', approve:'승인함', revise:'수정 요청함', reject:'거절함' };\n${helpers.slice(helpers.indexOf('  const baseName'), helpers.indexOf('  const headline'))}\n${helpers.slice(helpers.indexOf('  function answerText'), helpers.indexOf('  function rowHtml'))}\n${helpers.slice(helpers.indexOf('  const TOOL_KIND'), helpers.indexOf('  const baseLogHtml'))}\nwindow.hubPrompts = { P, toolCard, lineHtml, diffHtml, cutText, TOOL_KIND, rowSummary, answerText, kindOfPrompt, toolSummary, diffCounts };`, scope);
  vm.runInContext(fs.readFileSync(new URL('../public/process.js', import.meta.url), 'utf8'), scope);
  const render = (j, records = []) => { state.jobs.set(j.id, j); state.logs.set(`${j.id}/t1`, records); state.loadedLogs.add(`${j.id}/t1`); return scope.window.hubJobProcess(j); };
  return { render, state, p, scope, events, nodes };
}

test('화면 렌더러는 기본 접힘과 머리 요약·단일 작업 타임라인을 연결한다', () => {
  const r = renderer(), j = job();
  let html = r.render(j, [tool('a')]); assert.match(html, /추론 과정/); assert.match(html, /1단계/); assert.match(html, /명령 1/); assert.doesNotMatch(html, /class="proc-body"/);
  r.state.open.add('proc:j'); html = r.render(j, [tool('a')]); assert.match(html, /class="proc-body"/); assert.doesNotMatch(html, /class="proc-sec-h"/); assert.match(html, /aria-controls=/);
});

test('명령 출력 펼침은 전문·폴더·긴 출력·종료 코드·키보드 스크롤을 표시한다', () => {
  const r = renderer(); r.state.open.add('proc:j'); r.p.toolOpen.add('a');
  const records = [tool('a', 'Bash', 0, { status: 'error', input: { command: 'npm test\ngit status', cwd: 'F:/자료' }, output: Array.from({ length: 20 }, (_, i) => `출력 ${i}`).join('\n') + '\nexit 2' })];
  let html = r.render(job(), records);
  for (const pattern of [/tc-cmd/, /F:\/자료/, /전체 보기 \(21줄\)/, /종료 코드 2/, /tabindex="0"/, /\+1줄/]) assert.match(html, pattern);
  r.p.toolFull.add('a'); html = r.render(job(), records); assert.doesNotMatch(html, /전체 보기/); assert.match(html, /출력 19/);
});

test('파일 수정 펼침은 차이 수치와 긴 차이의 전체 보기·출력 대체를 표시한다', () => {
  const r = renderer(); r.state.open.add('proc:j'); r.p.toolOpen.add('a');
  const records = [tool('a', 'Edit', 0, { diff: [{ path: 'public/app.js', unified: Array.from({ length: 45 }, (_, i) => `+줄 ${i}`).join('\n') }] })];
  const html = r.render(job(), records); assert.match(html, /\+45/); assert.match(html, /전체 보기 \(45줄\)/); assert.match(html, /파일 변경 내용/); assert.doesNotMatch(html, />\+줄 44</);
  assert.match(r.render(job(), [tool('a', 'Edit', 0, { output: '수정 완료' })]), /수정 완료/);
});

test('승인 요청은 카드 끝 기록 없이 대기·거절·만료를 같은 타임라인에서 보여 준다', () => {
  const r = renderer(); r.state.open.add('proc:j');
  r.p.map.set('p', prompt({ category: 'command', detail: { command: 'npm test' } }));
  let html = r.render(job()); assert.match(html, /명령 실행 승인 대기/); assert.match(html, /data-pr-focus="p"/); assert.doesNotMatch(html, /class="prs"/);
  r.p.map.set('p', prompt({ status: 'answered', category: 'command', answer: { action: 'deny', message: '사유' }, detail: { command: 'npm test' } }));
  html = r.render(job()); assert.match(html, /거절함 · 사유/); assert.match(html, /aria-controls=/);
  r.p.map.set('p', prompt({ status: 'expired', answer: { automatic: true } })); assert.match(r.render(job()), /답이 없어 AI가 판단해 진행/);
});

test('긴 타임라인은 최근 200개만 표시하고 버튼으로 200개씩 더 보여 준다', () => {
  const r = renderer(); r.state.open.add('proc:j');
  const records = Array.from({ length: 450 }, (_, i) => ({ kind: 'message', at: at(i), text: `기록 ${i}` }));
  let html = r.render(job(), records); assert.match(html, /이전 250단계 보기/); assert.doesNotMatch(html, />기록 249</); assert.match(html, />기록 250</);
  const button = { dataset: { procPrevious: 'j/t1' }, disabled: false, id: '이전버튼', hasAttribute: (name) => name === 'data-proc-previous' };
  r.events.click({ target: { closest: (selector) => selector === '.proc' ? { dataset: { proc: 'j' } } : selector === 'button' ? button : null } });
  html = r.scope.lastRender; assert.match(html, /이전 50단계 보기/); assert.match(html, />기록 50</);
});

test('모두 펼치기·접기는 섹션·묶음·도구에 적용하고 전체 출력 상태는 보존한다', () => {
  const r = renderer(); r.state.open.add('proc:j'); r.p.toolFull.add('a');
  const j = job({ mode: 'both', tasks: [{ id: 't1', title: '하나', status: 'done', assignee: 'codex' }, { id: 't2', title: '둘', status: 'done', assignee: 'claude' }] });
  r.render(j, [tool('a', 'Read'), tool('b', 'Read'), tool('c', 'Read')]);
  const button = { dataset: { procAll: 'j' }, id: 'procall-j', disabled: false, hasAttribute: (name) => name === 'data-proc-all' };
  const event = { target: { closest: (selector) => selector === '.proc' ? { dataset: { proc: 'j' } } : selector === 'button' ? button : null } };
  r.events.click(event); assert.equal(r.state.open.has('proc:j/t1'), true); assert.equal(r.p.toolOpen.has('a'), true); assert.equal(r.state.open.has('proc:j/t1#ga'), true);
  r.events.click(event); assert.equal(r.state.open.has('proc:j/t1'), false); assert.equal(r.p.toolOpen.has('a'), false); assert.equal(r.state.open.has('proc:j'), true); assert.equal(r.p.toolFull.has('a'), true);
});

test('위로 스크롤한 상태의 새 단계만 알리고 바닥에서는 알약을 숨긴다', () => {
  const r = renderer(); r.state.open.add('proc:j'); r.render(job(), [{ kind: 'message', at: at(0), text: '처음' }]);
  const body = { scrollHeight: 300, scrollTop: 20, clientHeight: 100 }; r.nodes.set('procb-j', body);
  let html = r.render(job(), [{ kind: 'message', at: at(0), text: '처음' }, { kind: 'message', at: at(1), text: '추가' }]);
  assert.match(html, /새 단계 1개 ↓/); assert.match(html, /data-proc-new="j" >새 단계/);
  body.scrollTop = 200; html = r.render(job(), [{ kind: 'message', at: at(0), text: '처음' }, { kind: 'message', at: at(1), text: '추가' }]);
  assert.match(html, /data-proc-new="j" hidden/);
});

test('예전 도구 기록도 타임라인의 기존 줄 렌더러로 보인다', () => {
  const r = renderer(); r.state.open.add('proc:j');
  const html = r.render(job(), [{ kind: 'tool', name: 'Bash', detail: 'git status', at: at(1) }]);
  assert.match(html, /k-legacy/); assert.match(html, /git status/); assert.match(html, /1단계/);
});

test('도구 본문에서 Esc는 카드만 접고 그 밖에서는 과정 블록을 접는다', () => {
  const r = renderer(); r.state.open.add('proc:j'); r.p.toolOpen.add('a'); r.render(job(), [tool('a', 'Bash', 0, { output: '결과' })]);
  const proc = { dataset: { proc: 'j' } }, button = { dataset: { procTool: 'a' }, id: '카드머리' }, card = { querySelector: () => button };
  r.events.keydown({ key: 'Escape', target: { closest: (selector) => selector === '.proc' ? proc : selector === '.tc-b' ? { closest: () => card } : null }, preventDefault() {}, stopPropagation() {} });
  assert.equal(r.p.toolOpen.has('a'), false); assert.equal(r.state.open.has('proc:j'), true);
  r.events.keydown({ key: 'Escape', target: { closest: (selector) => selector === '.proc' ? proc : null }, preventDefault() {}, stopPropagation() {} });
  assert.equal(r.state.open.has('proc:j'), false);
});

test('오른쪽 작업 클릭과 추론 과정에서 보기 버튼은 블록·해당 섹션을 연다', () => {
  for (const source of ['패널', '버튼']) {
    const r = renderer(); r.render(job());
    r.events.click({ target: { closest: (selector) => source === '패널' && selector === '[data-goto][data-task]' ? { dataset: { goto: 'j', task: 't1' } } : source === '버튼' && selector === '[data-proc-show]' ? { dataset: { procShow: 'j/t1' } } : null } });
    assert.equal(r.state.open.has('proc:j'), true); assert.equal(r.state.open.has('proc:j/t1'), true);
  }
});

test('명령 표시: 셸 껍데기를 벗기고 실제 명령만', () => {
  const ps = String.raw`"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "node -e \"console.log(1)\""`;
  assert.equal(M.displayCommand(ps), 'node -e "console.log(1)"');
  assert.equal(M.displayCommand("/usr/bin/bash -lc 'npm test'"), 'npm test');
  assert.equal(M.displayCommand('cmd /c dir'), 'dir');
  assert.equal(M.displayCommand('git status'), 'git status');
  const preview = M.preview([{ kind: 'tool', toolKind: 'cmd', input: { command: ps }, at: '2026-10-03T00:00:00Z' }]);
  assert.equal(preview.text, 'node -e "console.log(1)"');
});

test('최종 결과와 같은 마지막 설명은 추론 과정에서 뺀다', () => {
  const job = { id: 'j', mode: 'codex', status: 'done', tasks: [{ id: 't1', title: 'x', assignee: 'codex', status: 'done', resultText: '최종 요약입니다' }] };
  const logs = { 'j/t1': [
    { kind: 'message', text: '확인하겠습니다', at: '2026-10-03T00:00:01Z' },
    { kind: 'message', text: '최종 요약입니다', at: '2026-10-03T00:00:09Z' },
  ] };
  const m = M.build(job, logs, []);
  assert.equal(JSON.stringify(Array.from(m.sections[0].items, (e) => e.text)), JSON.stringify(['확인하겠습니다']));
});
