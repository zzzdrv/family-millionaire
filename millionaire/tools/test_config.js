'use strict';
// v3.10 服务设置测试：node tools/test_config.js
// 用临时 config 文件（MILLIONAIRE_CONFIG），不会碰真实 config.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-cfg-'));
process.env.MILLIONAIRE_DATA = tmp;
process.env.MILLIONAIRE_CONFIG = path.join(tmp, 'config.json');
process.env.PORT = '0';
delete process.env.HOST_PIN; delete process.env.MAX_PRIZE;   // 不用环境变量覆盖，让 config 文件说了算
fs.writeFileSync(process.env.MILLIONAIRE_CONFIG, JSON.stringify({ port: 3000, hostPin: 'oldpin', maxPrize: 20 }));

const srv = require('../server.js');
const T = srv._test;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++; };

function call(port, method, url, body, pin) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (pin !== undefined) headers['x-host-pin'] = pin;
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const readCfg = () => JSON.parse(fs.readFileSync(process.env.MILLIONAIRE_CONFIG, 'utf8'));

(async () => {
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;

  /* 1. 未带口令 → 401 */
  let r = await call(port, 'GET', '/api/config', undefined, '');
  eq(r.status, 401, 'GET 未鉴权 401');
  r = await call(port, 'POST', '/api/config', { hostPin: 'x' }, '');
  eq(r.status, 401, 'POST 未鉴权 401');

  /* 2. GET 返回当前配置（含明文口令，面板填表用） */
  r = await call(port, 'GET', '/api/config', undefined, 'oldpin');
  eq(r.status, 200);
  eq(r.json.hostPin, 'oldpin', '返回当前口令');
  eq(r.json.maxPrize, 20, '返回当前 maxPrize');
  eq(r.json.port, 0, '返回端口（测试用随机端口）');
  ok(Array.isArray(r.json.ladder) && r.json.ladder.length === 12, '返回当前奖金梯');
  eq(r.json.ladder[11], 20, '梯顶 = maxPrize');

  /* 3. 非法 maxPrize → 400，文件和内存都不动 */
  r = await call(port, 'POST', '/api/config', { maxPrize: -5 }, 'oldpin');
  eq(r.status, 400, '负数 400');
  r = await call(port, 'POST', '/api/config', { maxPrize: 'abc' }, 'oldpin');
  eq(r.status, 400, '非数字 400');
  eq(readCfg().maxPrize, 20, '文件未动');
  eq(T.ladder[11], 20, '内存奖金梯未动');

  /* 4. 改 maxPrize → 文件落盘 + 内存即时重建 */
  r = await call(port, 'POST', '/api/config', { maxPrize: 50 }, 'oldpin');
  eq(r.status, 200);
  eq(readCfg().maxPrize, 50, '文件已写');
  eq(T.ladder[11], 50, '内存奖金梯顶=50');
  eq(r.json.ladder[11], 50, '接口返回新梯');
  ok(T.ladder[0] < T.ladder[11], '梯严格递增');
  // 旧口令仍有效（这次没改口令）
  r = await call(port, 'GET', '/api/config', undefined, 'oldpin');
  eq(r.status, 200, '旧口令仍可用');

  /* 5. 改口令 → 即时生效：旧口令 401，新口令可用 */
  r = await call(port, 'POST', '/api/config', { hostPin: 'new-secret-99' }, 'oldpin');
  eq(r.status, 200);
  eq(readCfg().hostPin, 'new-secret-99', '口令落盘');
  r = await call(port, 'GET', '/api/config', undefined, 'oldpin');
  eq(r.status, 401, '旧口令已失效');
  r = await call(port, 'GET', '/api/config', undefined, 'new-secret-99');
  eq(r.status, 200, '新口令即时生效');
  eq(r.json.hostPin, 'new-secret-99', 'GET 返回新口令');

  /* 6. 显式 ladder 优先：config 里有 ladder 时，改 maxPrize 会删掉它 */
  const withLadder = readCfg(); withLadder.ladder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  fs.writeFileSync(process.env.MILLIONAIRE_CONFIG, JSON.stringify(withLadder));
  // 手动同步内存（模拟重启读入）
  srv.cfg.ladder = withLadder.ladder; T.applyPrizeConfig();
  eq(T.ladder[11], 12, '显式 ladder 生效中');
  r = await call(port, 'POST', '/api/config', { maxPrize: 30 }, 'new-secret-99');
  eq(r.status, 200);
  const after = readCfg();
  eq(after.maxPrize, 30, 'maxPrize 已写');
  ok(!('ladder' in after), '显式 ladder 已移除');
  eq(T.ladder[11], 30, '内存切换到 maxPrize 生成的梯');

  /* 7. 只改口令不碰 maxPrize → ladder 不动 */
  const ladderBefore = T.ladder.join(',');
  r = await call(port, 'POST', '/api/config', { hostPin: 'p3' }, 'new-secret-99');
  eq(r.status, 200);
  eq(T.ladder.join(','), ladderBefore, '奖金梯不动');
  eq(readCfg().maxPrize, 30, 'maxPrize 不动');

  /* 8. 口令可设任意可见 ASCII（字母数字符号，不限数字；中文不行，HTTP 头不支持） */
  r = await call(port, 'POST', '/api/config', { hostPin: 'Abc!@#123' }, 'p3');
  eq(r.status, 200);
  r = await call(port, 'GET', '/api/config', undefined, 'Abc!@#123');
  eq(r.status, 200, '混合口令可用');
  r = await call(port, 'POST', '/api/config', { hostPin: '中文口令' }, 'Abc!@#123');
  eq(r.status, 400, '中文口令被拒绝');

  /* 9. 口令留空 = 取消口令 */
  r = await call(port, 'POST', '/api/config', { hostPin: '' }, 'Abc!@#123');
  eq(r.status, 200);
  r = await call(port, 'GET', '/api/config');
  eq(r.status, 200, '无口令时免鉴权');

  console.log('服务设置测试通过：' + pass + ' 项断言');
  process.exit(0);
})().catch(e => { console.error('测试失败：', e); process.exit(1); });
