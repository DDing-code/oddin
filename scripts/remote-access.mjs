#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA_DIR, readJson } from '../lib/util.mjs';
import { RemoteAccess, runCommand } from '../lib/remote.mjs';

export async function hasRemoteGate(target) {
  try {
    const res = await fetch(`${target}/api/remote`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!res.ok) return false;
    const s = await res.json();
    return typeof s.enabled === 'boolean' && typeof s.ready === 'boolean' && s.canManage === true && s.viewer?.remote === false && s.local?.url === target && typeof s.tailscale?.state === 'string';
  } catch { return false; }
}
function printStatus(s, json) {
  if (json) { console.log(JSON.stringify(s, null, 2)); return; }
  console.log(`원격 접속: ${s.ready ? '사용 가능' : s.enabled ? '설정됨 · 연결 확인 필요' : '꺼짐'}`);
  console.log(`Tailscale: ${s.tailscale.state} · 허용 계정 ${s.allowedCount}개`);
  if (s.url) console.log(`주소: ${s.url}`);
  if (s.result) console.log(s.result.message);
  console.log(`다음 단계: ${s.next.message}`);
  if (s.next.command) console.log(s.next.command);
  if (s.next.url && s.next.url !== s.url) console.log(s.next.url);
  for (const warning of s.warnings) console.log(`안내: ${warning}`);
}
export async function main(args = process.argv.slice(2)) {
  const config = readJson(path.join(ROOT, 'config.json'), {});
  const port = Number(process.env.HUB_PORT || config.port || 7700);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('허브 포트가 올바르지 않습니다');
  const target = `http://127.0.0.1:${port}`;
  const remote = new RemoteAccess({ port, dataDir: DATA_DIR });
  const command = args.find((a) => !a.startsWith('--')) || 'status';
  const json = args.includes('--json');
  if (command === 'status') { printStatus(await remote.status({ force: true }), json); return 0; }
  if (command === 'enable') {
    // 구버전 서버에 인증 게이트가 없으므로 설치·Serve 실행보다 먼저 검사한다.
    if (!await hasRemoteGate(target)) { console.error('허브를 먼저 재시작하세요(npm run restart)'); return 2; }
    let status = await remote.status({ force: true });
    if (!status.tailscale.installed && args.includes('--install')) {
      console.log('Tailscale을 설치합니다. Windows 관리자 승인이 나오면 직접 승인해 주세요');
      const install = await runCommand('winget.exe', ['install', '--id', 'Tailscale.Tailscale', '-e', '--accept-package-agreements', '--accept-source-agreements'], { timeoutMs: 180_000 });
      if (install.code !== 0 || install.timedOut) { console.error('Tailscale 설치를 마치지 못했습니다. 설치와 관리자 승인을 확인해 주세요'); return 3; }
      status = await remote.status({ force: true });
    }
    const result = await remote.enable({ force: args.includes('--force') });
    printStatus(result, json);
    return result.result.ok ? 0 : 3;
  }
  if (command === 'disable') {
    const result = await remote.disable(); printStatus(result, json); return result.result.ok ? 0 : 1;
  }
  if (command === 'allow' || command === 'revoke') {
    const index = args.indexOf(command), value = args[index + 1];
    const settings = remote.changeLogin(value, command === 'allow');
    console.log(`허용 계정 목록을 변경했어요. 현재 ${settings.logins.length}개`);
    if (!settings.logins.length) console.log('마지막 계정을 제거해 원격 접속을 차단했어요. 계정 추가 후 다시 켜 주세요');
    return 0;
  }
  console.error('사용법: npm run remote -- status|enable [--install] [--force]|disable|allow <로그인>|revoke <로그인> [--json]');
  return 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => { console.error('원격 접속 관리 중 오류가 발생했습니다. Tailscale과 허브의 상태를 확인해 주세요'); process.exitCode = 1; });
}
