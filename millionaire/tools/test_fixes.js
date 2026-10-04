'use strict';
// 针对修复项的新行为测试：node tools/test_fixes.js
// 使用临时数据目录，不会碰 ./data
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-fix-'));
process.env.MILLIONAIRE_DATA = tmp;
process.env.PORT = '0';
process.env.HOST_PIN = 'test-pin-123';
const srv = require('../server.js');
const T = srv._test;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++; };

function call(port, method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j, text: s }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  const PIN = { 'x-host-pin': 'test-pin-123' };
  const A = (a) => call(port, 'POST', '/api/action', a, PIN).then(r => r.json);
  const st = async (role, headers) => (await call(port, 'GET', '/api/state?role=' + role, undefined, headers)).json;

  /* 1. 电视视图不下发任何学段标签，主持人视图保留 */
  let tv = await st('tv', PIN);
  eq(tv.phase, 'lobby');
  ok(tv.players.every(p => !('stage' in p)), '大厅：电视视图 players 无 stage');
  let r = await A({ type: 'start', playerId: 'p1' }); ok(r.ok, '开局');
  tv = await st('tv', PIN);
  ok(!('stage' in tv.question), '答题中：电视视图 question 无 stage');
  ok(!('stage' in tv.player), '答题中：电视视图 player 无 stage');
  ok(tv.players.every(p => !('stage' in p)), '答题中：电视视图 players 无 stage');
  const host = await st('host', PIN);
  ok('stage' in host.question && 'stage' in host.player, '主持人视图保留 stage');
  ok(host.players.every(p => 'stage' in p), '主持人视图 players 保留 stage');
  r = await A({ type: 'abort' }); ok(r.ok, '中止');

  /* 2. 揭晓中重复锁定：报错文案不再是「请先选择答案」 */
  r = await A({ type: 'start', playerId: 'p1' }); ok(r.ok);
  r = await A({ type: 'select', i: 0 }); ok(r.ok);
  r = await A({ type: 'confirm' }); ok(r.ok, '锁定进入揭晓');
  r = await A({ type: 'confirm' });
  ok(!r.ok && r.error === '现在不能锁定', '揭晓中重复锁定提示「现在不能锁定」，实际：' + r.error);
  r = await A({ type: 'abort' }); ok(r.ok, '中止（顺带取消计时器）');

  /* 3. 换题：新题展示即标为已用（替代原来的 recentIds 机制） */
  r = await A({ type: 'start', playerId: 'p2' }); ok(r.ok);
  r = await A({ type: 'swap' }); ok(r.ok, '换题');
  const newId = T.game.qs[T.game.idx].id;
  ok(T.questions.find(q => q.id === newId).used === true, '换进来的新题已标为已用');
  r = await A({ type: 'abort' }); ok(r.ok);

  /* 4. 口令：timingSafeEqual + 连续失败限频 */
  let c = await call(port, 'GET', '/api/check', undefined, PIN);
  eq(c.status, 200, '正确口令通过');
  c = await call(port, 'GET', '/api/check', undefined, { 'x-host-pin': 'test-pin-124' });
  eq(c.status, 401, '等长错误口令被拒');
  for (let i = 0; i < 10; i++) {
    await call(port, 'GET', '/api/check', undefined, { 'x-host-pin': 'wrong' });
  }
  c = await call(port, 'GET', '/api/check', undefined, PIN);
  eq(c.status, 401, '连续 10 次失败后，即使正确口令也被暂时拒绝');

  /* 6. ladder 可配置：parseLadder 校验 */
  const P = T.parseLadder;
  assert.deepStrictEqual(P([1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20]), [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20]); pass++;
  assert.deepStrictEqual(P([2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40]), [2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40]); pass++;   // 节假日翻倍
  assert.deepStrictEqual(P([0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12]), [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12]); pass++; // 允许小数
  assert.strictEqual(P([1, 2, 3]), null); pass++;                       // 数量不对
  assert.strictEqual(P([1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 16]), null); pass++; // 不递增
  assert.strictEqual(P([1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, -1]), null); pass++; // 负数
  assert.strictEqual(P([1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 0]), null); pass++;  // 零
  assert.strictEqual(P('xxx'), null); pass++;
  assert.strictEqual(P(undefined), null); pass++;
  assert.deepStrictEqual(T.LADDER, T.buildLadder(20), 'config 里 maxPrize:20，按算法生成梯子'); pass++;
  assert.strictEqual(T.fallbackPrize(5), T.LADDER[4], '保险线按 LADDER 下标取，换梯自动跟随'); pass++;
  assert.strictEqual(T.fallbackPrize(9), T.LADDER[8]); pass++;

  /* 7. buildLadder：按总奖金自动生成梯子 */
  const B = T.buildLadder;
  assert.deepStrictEqual(B(200), [5, 10, 15, 25, 35, 50, 65, 85, 105, 130, 160, 200], '总额 200 还原经典梯'); pass++;
  assert.deepStrictEqual(B(50), [1, 3, 4, 6, 9, 13, 16, 21, 26, 33, 40, 50], '总额 50'); pass++;
  assert.deepStrictEqual(B(100), [3, 5, 8, 13, 18, 25, 33, 43, 53, 65, 80, 100], '总额 100'); pass++;
  [20, 50, 100, 200, 15, 1000].forEach(function (m) {
    const l = B(m);
    assert.strictEqual(l.length, 12, m + ' 元：12 级'); pass++;
    assert.strictEqual(l[11], m, m + ' 元：最后一级等于总额'); pass++;
    for (let i = 1; i < 12; i++) assert.ok(l[i] > l[i - 1], m + ' 元：第 ' + (i + 1) + ' 级递增'); pass++;
    assert.ok(l.every(x => x > 0), m + ' 元：全正数'); pass++;
  });
  assert.strictEqual(B(0), null); pass++;
  assert.strictEqual(B(-5), null); pass++;
  assert.strictEqual(B('x'), null); pass++;
  assert.strictEqual(B(undefined), null); pass++;

  console.log('\n全部通过：' + pass + ' 项断言');
  process.exit(0);
})().catch(e => { console.error('测试失败：', e.message); process.exit(1); });
