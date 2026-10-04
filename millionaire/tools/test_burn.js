'use strict';
// 烧题机制测试：node tools/test_burn.js
// 玩过的题全局标记为已用，不再参与抽题；主持人可重新设为可用
// 使用临时数据目录，不会碰 ./data
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-burn-'));
process.env.MILLIONAIRE_DATA = tmp;
process.env.PORT = '0';
process.env.HOST_PIN = '';
const srv = require('../server.js');
const T = srv._test;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const isUsed = (id) => T.questions.find(q => q.id === id).used === true;

(async () => {
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  const A = (a) => call(port, 'POST', '/api/action', a).then(r => r.json);
  const st = async (role) => (await call(port, 'GET', '/api/state?role=' + role)).json;
  const ansOf = async () => (await st('host')).question.answer;

  /* 1. 开局即烧第 1 题 */
  let r = await A({ type: 'start', playerId: 'p1' }); ok(r.ok, '开局');
  const q1 = T.game.qs[0].id;
  ok(isUsed(q1), '第 1 题展示即标为已用');

  /* 2. 下一题即烧新题 */
  r = await A({ type: 'select', i: await ansOf() }); ok(r.ok);
  r = await A({ type: 'confirm' }); ok(r.ok);
  await sleep(4200);
  r = await A({ type: 'next' }); ok(r.ok, '进入第 2 题');
  const q2 = T.game.qs[1].id;
  ok(isUsed(q2), '第 2 题展示即标为已用');
  const q3 = T.game.qs[2].id;   // 先记下，abort 后 game 就没了
  const burnedIds = [q1, q2];
  r = await A({ type: 'abort' }); ok(r.ok, '中止');
  ok(!isUsed(q3), '没展示到的第 3 题不烧');

  /* 3. 抽题避开已用题 */
  for (let i = 0; i < 30; i++) {
    const p = T.pickGame(3);
    ok(p.ok, '能抽满 12 题');
    ok(p.qs.every(q => burnedIds.indexOf(q.id) < 0), '30 次抽题都没抽到已用题');
  }

  /* 4. 换题烧新题 */
  r = await A({ type: 'start', playerId: 'p2' }); ok(r.ok);
  r = await A({ type: 'swap' }); ok(r.ok, '换题');
  ok(isUsed(T.game.qs[T.game.idx].id), '换进来的题标为已用');
  r = await A({ type: 'abort' }); ok(r.ok);

  /* 5. 大厅视图带可用题数 */
  const tvl = await st('tv');
  const availNow = T.questions.filter(q => !q.used).length;
  ok(tvl.avail === availNow, '电视大厅可用题数正确：' + tvl.avail);

  /* 6. 单题切换 + 批量恢复 */
  const someId = T.questions.find(q => !q.used).id;
  const q0 = T.questions.find(q => q.id === someId);
  r = await call(port, 'PUT', '/api/questions/' + someId, { cat: q0.cat, stage: q0.stage, q: q0.q, options: q0.options, answer: q0.answer, explain: q0.explain || '', flag: false, used: true }).then(x => x.json);
  ok(r.question.used === true, 'PUT 可标为已用');
  r = await call(port, 'POST', '/api/questions/reuse', { ids: [someId] }).then(x => x.json);
  ok(r.ok && r.count === 1, '按 ids 恢复 1 道');
  ok(!isUsed(someId), '该题恢复可用');
  const usedCount = T.questions.filter(q => q.used).length;
  r = await call(port, 'POST', '/api/questions/reuse', {}).then(x => x.json);
  ok(r.ok && r.count === usedCount, '全部恢复：' + r.count + ' 道');
  ok(T.questions.every(q => !q.used), '题库全可用');

  /* 7. 烧光：开不了局，报错指引加题/恢复 */
  T.questions.forEach(q => { q.used = true; });
  r = await A({ type: 'start', playerId: 'p1' });
  ok(!r.ok && r.error.indexOf('可用题目不够') >= 0, '题库烧光时开局失败并指引，实际：' + r.error);
  r = await call(port, 'POST', '/api/questions/reuse', {}).then(x => x.json);
  ok(r.count === T.questions.length, '一键全部恢复');
  r = await A({ type: 'start', playerId: 'p1' });
  ok(r.ok, '恢复后能正常开局');
  r = await A({ type: 'abort' }); ok(r.ok);

  /* 8. 新增题目默认可用 */
  r = await call(port, 'POST', '/api/questions', { cat: '通识', stage: 2, q: '烧题测试新增？', options: ['甲', '乙', '丙', '丁'], answer: 0, explain: '' }).then(x => x.json);
  ok(r.question.used === false, '新增题目默认可用');
  await call(port, 'DELETE', '/api/questions/' + r.question.id);

  console.log('\n全部通过：' + pass + ' 项断言');
  process.exit(0);
})().catch(e => { console.error('测试失败：', e.message); process.exit(1); });
