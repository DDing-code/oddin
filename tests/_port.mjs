// 시험 서버용 빈 포트 (고정 포트를 쓰면 앞 실행이 남긴 서버·다른 시험과 부딪혀 가끔 실패했다)
import net from 'node:net';
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref(); s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
