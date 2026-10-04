'use strict';
// 后端联调测试：node tools/test_server.js
// 使用临时数据目录，不会碰 ./data
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-'));
process.env.MILLIONAIRE_DATA = tmp;
process.env.PORT = '0';
process.env.HOST_PIN = '';
const srv = require('../server.js');
const T = srv._test;

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++; };

function call(port, method, url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}) }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j, text: s, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  const A = (a) => call(port, 'POST', '/api/action', a).then(r => r.json);
  const st = async (role) => (await call(port, 'GET', '/api/state?role=' + (role || 'host'))).json;

  /* 1. 抽题：每局 12 题，每档 4 题、各 4 类各 1 题；连续两题类别不同；多次重复验证 */
  const TS = (L) => [Math.max(1, L - 1), L, Math.min(4, L + 1)];
  for (let n = 0; n < 200; n++) {
    const L = (n % 4) + 1;
    const r = T.pickGame(L);
    ok(r.ok && r.qs.length === 12, '抽满12题');
    for (let t = 0; t < 3; t++) {
      const tier = r.qs.slice(t * 4, t * 4 + 4);
      ok(tier.every(q => q.stage === TS(L)[t]), '学段档位正确：选手学段' + L + ' 第' + (t + 1) + '档');
      eq(new Set(tier.map(q => q.cat)).size, 4, '每档4类各一题');
    }
    for (let i = 0; i < 11; i++) ok(r.qs[i].cat !== r.qs[i + 1].cat, '相邻题类别不同');
    eq(new Set(r.qs.map(q => q.id)).size, 12, '不重复');
  }

  /* 2. 大厅状态与权限视图 */
  let s = await st('tv');
  eq(s.phase, 'lobby');
  eq(s.players.length, 3);
  ok(!('clients' in s), '电视视图不含主持信息');

  /* 3. 完整通关：12 题全对 → 20 元 */
  let r = await A({ type: 'start', playerId: 'p1' });
  ok(r.ok, '开始对局');
  for (let i = 0; i < 12; i++) {
    s = await st('host');
    eq(s.phase, 'question'); eq(s.idx, i);
    const tv = await st('tv');
    ok(tv.question.answer === undefined && tv.question.explain === undefined, '电视视图不泄露答案');
    r = await A({ type: 'select', i: s.question.answer }); ok(r.ok);
    r = await A({ type: 'confirm' }); ok(r.ok);
    s = await st('host'); eq(s.phase, 'revealing');
    const tv2 = await st('tv');
    ok(!tv2.reveal, '揭晓前电视拿不到答案');
    await new Promise(res => setTimeout(res, 3950));
    s = await st('tv'); eq(s.phase, 'result'); eq(s.reveal.correct, true);
    ok(typeof s.reveal.explain === 'string' && s.reveal.explain.length > 0, '揭晓后有解析');
    r = await A({ type: 'next' }); ok(r.ok);
  }
  s = await st('host');
  eq(s.phase, 'gameover'); eq(s.outcome.result, 'win'); eq(s.outcome.prize, T.LADDER[11], '通关拿满第 12 级'); eq(s.outcome.newRecord, true);
  eq(T.scores.history.length, 1);
  console.log('  通关流程 OK');

  /* 4. 答错的保险线规则 */
  async function playWrongAt(k) {
    await A({ type: 'abort' });
    await A({ type: 'start', playerId: 'p2' });
    for (let i = 0; i < k; i++) {
      const h = await st('host');
      await A({ type: 'select', i: h.question.answer }); await A({ type: 'confirm' });
      T.game.phase === 'revealing' && (await new Promise(res => setTimeout(res, 3950)));
      await A({ type: 'next' });
    }
    const h = await st('host');
    await A({ type: 'select', i: (h.question.answer + 1) % 4 }); await A({ type: 'confirm' });
    await new Promise(res => setTimeout(res, 3950));
    s = await st('host'); eq(s.reveal.correct, false);
    r = await A({ type: 'finish' }); ok(r.ok);
    return (await st('host')).outcome;
  }
  const L4 = T.LADDER[4], L8 = T.LADDER[8];   // 保险线跟当前梯子走，不写死数字
  const expect = { 0: 0, 3: 0, 4: 0, 5: L4, 7: L4, 8: L4, 9: L8, 11: L8 };
  // 为节省时间只测关键几点：第1题、第5题(下标4)、第6题(下标5)、第10题(下标9)
  for (const k of [0, 4, 5, 9]) {
    const o = await playWrongAt(k);
    eq(o.prize, expect[k], '第' + (k + 1) + '题答错应得 ' + expect[k]);
    eq(o.result, 'wrong');
  }
  console.log('  保险线规则 OK');

  /* 5. 见好就收 + 求助 */
  await A({ type: 'abort' });
  await A({ type: 'start', playerId: 'p3' });
  s = await st('host');
  r = await A({ type: 'fifty' }); ok(r.ok);
  s = await st('host');
  eq(s.removed.length, 2); ok(!s.removed.includes(s.question.answer), '50:50 不会去掉正确答案');
  eq(s.lifelines.fifty, false);
  r = await A({ type: 'fifty' }); ok(!r.ok, '50:50 只能用一次');
  r = await A({ type: 'select', i: s.removed[0] }); ok(!r.ok, '不能选被去掉的选项');
  const before = s.question.q;
  r = await A({ type: 'swap' }); ok(r.ok);
  s = await st('host');
  ok(s.question.q !== before, '换题后题目变了'); eq(s.removed.length, 0); eq(s.lifelines.swap, false);
  r = await A({ type: 'swap' }); ok(!r.ok, '换题只能用一次');
  r = await A({ type: 'confirm' }); ok(!r.ok, '没选答案不能确认');
  // 答对前 6 题再收手
  for (let i = 0; i < 6; i++) {
    const h = await st('host');
    await A({ type: 'select', i: h.question.answer }); await A({ type: 'confirm' });
    await new Promise(res => setTimeout(res, 3950));
    if (i < 5) await A({ type: 'next' });
  }
  s = await st('host');
  eq(s.phase, 'result'); eq(s.walkPrize, T.LADDER[5]);
  r = await A({ type: 'walk' }); ok(r.ok);
  s = await st('host');
  eq(s.outcome.result, 'walk'); eq(s.outcome.prize, T.LADDER[5]); eq(s.outcome.reached, 6);
  eq(T.scores.history[T.scores.history.length - 1].fifty, true);
  r = await A({ type: 'again' }); ok(r.ok, '再来一局');
  r = await A({ type: 'start', playerId: 'p1' }); ok(!r.ok, '对局中不能重新开始');
  await A({ type: 'abort' });
  s = await st('tv');
  eq(s.phase, 'lobby');
  const n0 = T.scores.history.length;
  console.log('  见好就收 / 求助 OK');

  /* 6. 记分牌统计 */
  const p1 = s.players.find(p => p.id === 'p1');
  eq(p1.best, T.LADDER[11]); eq(p1.wins, 1);
  eq(s.totalPaid, T.scores.history.reduce((a, b) => a + b.prize, 0));

  /* 7. 题库增删改 + 校验 */
  const sc = await call(port, 'GET', '/api/questions');
  eq(sc.json.questions.length, 151);
  ok(sc.json.questions.every(q => [1, 2, 3, 4].includes(q.stage) && !('level' in q)), '每道题都有学段、没有旧的 level 字段');
  const good = { cat: '通识', stage: 2, q: '测试题？', options: ['甲', '乙', '丙', '丁'], answer: 2, explain: '测试解析' };
  r = await call(port, 'POST', '/api/questions', good); eq(r.status, 200);
  const newId = r.json.question.id;
  r = await call(port, 'POST', '/api/questions', Object.assign({}, good, { options: ['甲', '甲', '丙', '丁'] })); eq(r.status, 400);
  r = await call(port, 'POST', '/api/questions', Object.assign({}, good, { cat: '体育' })); eq(r.status, 400);
  r = await call(port, 'POST', '/api/questions', Object.assign({}, good, { answer: 5 })); eq(r.status, 400);
  r = await call(port, 'POST', '/api/questions', Object.assign({}, good, { stage: 5 })); eq(r.status, 400, '学段 5 非法');
  r = await call(port, 'POST', '/api/questions', Object.assign({}, good, { stage: undefined, q: '没写学段？' })); eq(r.status, 400, '缺学段被拒绝');
  { const old = Object.assign({}, good, { stage: undefined, level: 3, q: '旧版格式的题？' }); r = await call(port, 'POST', '/api/questions', old); eq(r.status, 200, '旧版 level 兼容'); eq(r.json.question.stage, 3); await call(port, 'DELETE', '/api/questions/' + r.json.question.id); }
  r = await call(port, 'PUT', '/api/questions/' + newId, Object.assign({}, good, { q: '改过的题？' })); eq(r.status, 200);
  eq(T.questions.find(q => q.id === newId).q, '改过的题？');
  r = await call(port, 'DELETE', '/api/questions/' + newId); eq(r.status, 200);
  eq(T.questions.length, 151);
  // 删除到抽不满时给出友好提示
  const saved = T.questions.splice(0, T.questions.length);
  r = await A({ type: 'start', playerId: 'p1' }); ok(!r.ok && /题库/.test(r.error), '题库为空时提示补题');
  saved.forEach(q => T.questions.push(q));
  // 某一类被全部删光时，用其他类补满
  const kept = T.questions.filter(q => q.cat !== '理科');
  const all = T.questions.splice(0, T.questions.length); kept.forEach(q => T.questions.push(q));
  const pk = T.pickGame(3); ok(pk.ok && pk.qs.length === 12, '缺一类时仍能抽满');
  T.questions.splice(0, T.questions.length); all.forEach(q => T.questions.push(q));
  r = await call(port, 'POST', '/api/questions/reset'); eq(r.json.count, 151);
  console.log('  题库增删改 OK');

  /* 7b. 选手学段：默认值、修改、PUT 不带学段时保持不变、抽题用选手自己的学段 */
  { const pl = (await call(port, 'GET', '/api/scores')).json.players;
    eq(pl.find(p => p.id === 'p3').stage, 2, '小女儿默认初中'); eq(pl.find(p => p.id === 'p2').stage, 4, '大儿子默认大学'); eq(pl.find(p => p.id === 'p1').stage, 3, '太太默认高中');
    r = await call(port, 'PUT', '/api/players/p1', { name: '太太', avatar: '太' }); eq(r.json.player.stage, 3, 'PUT 不带学段则保持');
    r = await call(port, 'PUT', '/api/players/p1', { name: '太太', avatar: '太', stage: 9 }); eq(r.json.player.stage, 3, '非法学段回落默认');
    r = await call(port, 'PUT', '/api/players/p1', { name: '太太', avatar: '太', stage: 4 }); eq(r.json.player.stage, 4);
    r = await call(port, 'PUT', '/api/players/p1', { name: '太太', avatar: '太', stage: 3 });
    for (const [pid, L] of [['p1', 3], ['p2', 4], ['p3', 2]]) {
      await A({ type: 'abort' });
      r = await A({ type: 'start', playerId: pid }); ok(r.ok, '开始对局 ' + pid);
      const gq = T.game.qs; for (let t = 0; t < 3; t++) ok(gq.slice(t * 4, t * 4 + 4).every(q => q.stage === TS(L)[t]), pid + ' 按自己的学段抽题');
      // 换题：同分类、同学段
      const cur = T.game.qs[0]; r = await A({ type: 'swap' }); ok(r.ok, '换题');
      ok(T.game.qs[0].stage === cur.stage && T.game.qs[0].cat === cur.cat && T.game.qs[0].id !== cur.id, '换题保持同学段同分类');
      const tvq = (await st('tv')).question; ok(!('answer' in tvq) && !('explain' in tvq), '电视视图不含答案');
    }
    await A({ type: 'abort' }); }

  /* 8. 选手管理 */
  r = await call(port, 'POST', '/api/players', { name: '爸爸', avatar: '爸' }); eq(r.status, 200);
  const dadId = r.json.player.id;
  r = await call(port, 'PUT', '/api/players/' + dadId, { name: '老爸', avatar: '爸' }); eq(r.status, 200);
  r = await call(port, 'POST', '/api/players', { name: '' }); eq(r.status, 400);
  r = await call(port, 'DELETE', '/api/players/' + dadId); eq(r.status, 200);

  /* 9. 导出 → 清空 → 导入（覆盖 / 合并）*/
  const ex = await call(port, 'GET', '/api/export');
  eq(ex.status, 200); ok(/attachment/.test(ex.headers['content-disposition']));
  const backupData = JSON.parse(ex.text);
  eq(backupData.questions.length, 151); eq(backupData.version, 2); ok(backupData.players.every(p => p.stage), '导出含选手学段'); eq(backupData.history.length, n0);
  await call(port, 'POST', '/api/history/clear'); eq(T.scores.history.length, 0);
  r = await call(port, 'POST', '/api/import', { mode: 'replace', data: backupData });
  eq(r.status, 200); eq(T.scores.history.length, n0, '覆盖导入后记录恢复');
  // 合并：重复导入不应翻倍
  r = await call(port, 'POST', '/api/import', { mode: 'merge', data: backupData });
  eq(r.status, 200); eq(T.scores.history.length, n0, '合并导入不重复'); eq(r.json.summary.questions, 0);
  eq(T.scores.players.length, 3);
  // 合并：新题加入
  const extra = JSON.parse(JSON.stringify(backupData));
  extra.questions.push({ id: 'q001', cat: '文史', stage: 1, q: '合并进来的新题？', options: ['A1', 'B1', 'C1', 'D1'], answer: 0, explain: '' });
  r = await call(port, 'POST', '/api/import', { mode: 'merge', data: extra });
  eq(r.json.summary.questions, 1); eq(T.questions.length, 152);
  eq(new Set(T.questions.map(q => q.id)).size, 152, '合并时 id 冲突已处理');
  // 坏文件
  r = await call(port, 'POST', '/api/import', { mode: 'replace', data: { app: 'family-millionaire', questions: [{ cat: '文史' }] } });
  eq(r.status, 400); eq(T.questions.length, 152, '坏文件不会改动数据');
  r = await call(port, 'POST', '/api/import', { mode: 'replace', data: { app: 'other' } }); eq(r.status, 400);
  ok(fs.readdirSync(path.join(tmp, 'backups')).length > 0, '已自动生成备份文件');
  console.log('  记分牌 / 导入导出 OK');

  /* 10. 持久化：对局中途重启可恢复 */
  await A({ type: 'abort' });
  await A({ type: 'start', playerId: 'p2' });
  const saved2 = JSON.parse(fs.readFileSync(path.join(tmp, 'game.json'), 'utf8'));
  eq(saved2.game.phase, 'question'); eq(saved2.game.qs.length, 12);

  /* 11. 静态页面 */
  r = await call(port, 'GET', '/../server.js'); ok(r.status === 404 || r.status === 403);
  r = await call(port, 'GET', '/nope.html'); eq(r.status, 404);

  console.log('\n全部通过：' + pass + ' 项断言');
  srv.server.close();
  process.exit(0);
})().catch(e => { console.error('\n测试失败：', e); process.exit(1); });
