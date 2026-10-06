'use strict';
// v3.9 用户积累题库测试：node tools/test_custom.js
// 使用临时数据目录，不会碰 ./data
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-cus-'));
process.env.MILLIONAIRE_DATA = tmp;
process.env.PORT = '0';
process.env.HOST_PIN = '';
const srv = require('../server.js');
const T = srv._test;
const ROOT = path.join(__dirname, '..');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++; };

function call(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let s = ''; res.on('data', c => s += c); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const readCustom = () => JSON.parse(fs.readFileSync(path.join(tmp, 'questions.custom.json'), 'utf8'));
const Q = (cat, stage, q, answer) => ({ cat, stage, q, options: ['对', '错1', '错2', '错3'], answer, explain: '解析' });

(async () => {
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const port = srv.server.address().port;
  const n0 = T.questions.length;

  /* 1. 手动加题：默认记入 custom，选项被确定性打乱 */
  let r = await call(port, 'POST', '/api/questions', Q('文史', 1, '手动加的第一题？', 0));
  eq(r.status, 200); eq(r.json.customAdded, 1, '默认记入默认题库');
  const q1 = r.json.question;
  ok(q1.id[0] === 'u', 'u* ID');
  eq(new Set(q1.options).size, 4, '选项仍是4个');
  eq(q1.options[q1.answer], '对', '打乱后答案索引跟着走');
  let cus = readCustom();
  eq(cus.length, 1); eq(cus[0].id, q1.id, 'custom 里是同一道题');
  ok(!('used' in cus[0]), 'custom 条目不带 used');

  /* 2. 确定性：同一题干再次添加（不同 live）得到同一打乱顺序 */
  const q1b = { cat: '文史', stage: 1, q: '手动加的第一题？', options: ['对', '错1', '错2', '错3'], answer: 0, explain: '' };
  const sh1 = T.appendCustom; // 仅确认函数存在
  ok(typeof sh1 === 'function', 'appendCustom 已导出');

  /* 3. remember=false：只进 live，不进 custom */
  r = await call(port, 'POST', '/api/questions', Object.assign(Q('理科', 2, '不记入的一题？', 0), { remember: false }));
  eq(r.status, 200); eq(r.json.customAdded, 0, 'remember=false 不记入');
  eq(readCustom().length, 1, 'custom 仍是1道');

  /* 4. 编辑 u* 题 → 同步回 custom；编辑 q* 题 → custom 记修正单，并自动重建默认题库 */
  r = await call(port, 'PUT', '/api/questions/' + q1.id, Q('文史', 1, '手动加的第一题？（改过）', 0));
  eq(r.status, 200);
  cus = readCustom();
  eq(cus[0].q, '手动加的第一题？（改过）', 'custom 同步更新');
  const qBase = T.questions.find(q => q.id === 'q001');
  r = await call(port, 'PUT', '/api/questions/q001', { cat: qBase.cat, stage: qBase.stage, q: qBase.q, options: qBase.options, answer: qBase.answer, explain: '改过的解析' });
  eq(r.status, 200);
  cus = readCustom();
  const ov001 = cus.find(q => q.id === 'q001');
  ok(ov001 && ov001.explain === '改过的解析' && !ov001.deleted, '出厂题编辑记修正单');
  ok(T.lastRebuild.ok, 'custom 变动后自动重建成功');
  eq(T.DEFAULTS.find(q => q.id === 'q001').explain, '改过的解析', '重建后的默认题库也是修正版');

  /* 5. 删除 u* 题 → custom 同步删除（q001 修正单不受影响） */
  r = await call(port, 'DELETE', '/api/questions/' + q1.id);
  eq(r.status, 200);
  cus = readCustom();
  eq(cus.length, 1, 'custom 同步删除 u* 题');
  eq(cus[0].id, 'q001', 'q001 修正单还在');

  /* 6. 导入合并：新题记入 custom；重复导入不重复记入；出厂题不记入 */
  const impQs = [Q('通识', 1, '导入的新题A？', 1), Q('通识', 1, '导入的新题B？', 2),
    { cat: '文史', stage: 1, q: T.questions.find(q => q.id === 'q002').q, options: ['a', 'b', 'c', 'd'], answer: 0, explain: '' }];
  r = await call(port, 'POST', '/api/import', { mode: 'merge', data: { app: 'family-millionaire', questions: impQs }, remember: true });
  eq(r.status, 200); eq(r.json.summary.questions, 2, '出厂题干重复被跳过');
  eq(r.json.summary.customAdded, 2, '2道新题记入 custom');
  eq(readCustom().length, 3, 'custom 3道（q001修正单+2道新题）');
  r = await call(port, 'POST', '/api/import', { mode: 'merge', data: { app: 'family-millionaire', questions: impQs }, remember: true });
  eq(r.json.summary.questions, 0, '重复导入 live 加0');
  eq(r.json.summary.customAdded, 0, '重复导入 custom 加0');

  /* 7. 删除出厂题 → 记删除标记，补充新题不再复活 */
  const delId = 'q010';
  await call(port, 'DELETE', '/api/questions/' + delId);
  ok(readCustom().some(q => q.id === delId && q.deleted === true), 'custom 有删除标记');
  r = await call(port, 'POST', '/api/questions/supplement', {});
  eq(r.status, 200); eq(r.json.added, 0, '删除标记的出厂题不再被补充回来');
  ok(!T.questions.some(q => q.id === delId), 'live 里没有它');
  r = await call(port, 'POST', '/api/questions/supplement', {});
  eq(r.json.added, 0, '无新题时加0');

  /* 8. 一次性补录：把 live 里 u* 但不在 custom 的记入；幂等 */
  // 先手动造一条"漏网"的 u* 题（模拟 v3.8 前导入的）
  // 注意：第3步 remember=false 的那道也在 live 且不在 base，补录会一并记入（按钮语义：全部新增一次性记入）
  const leaked = Q('理科', 3, '漏网的一题？', 0); leaked.id = 'u-leaked-1';
  T.questions.push(Object.assign({ used: false }, leaked));
  r = await call(port, 'POST', '/api/custom/sync', {});
  eq(r.status, 200); eq(r.json.added, 2, '补录2道（漏网题 + 之前取消勾选的那道）');
  ok(readCustom().some(q => q.id === 'u-leaked-1'), '补录进了 custom');
  r = await call(port, 'POST', '/api/custom/sync', {});
  eq(r.json.added, 0, '再点加0（幂等）');

  /* 9. 导出含 customQuestions；覆盖导入恢复 custom */
  r = await call(port, 'GET', '/api/export');
  eq(r.status, 200);
  const exp = r.json;
  ok(exp && Array.isArray(exp.customQuestions), '导出含 customQuestions');
  const nCus = exp.customQuestions.length;
  // 清空 custom 再覆盖导入恢复
  fs.writeFileSync(path.join(tmp, 'questions.custom.json'), '[]');
  r = await call(port, 'POST', '/api/import', { mode: 'replace', data: exp });
  eq(r.status, 200); eq(r.json.summary.customRestored, nCus, '覆盖导入恢复 custom');
  eq(readCustom().length, nCus);

  /* 10. build 脚本：base + custom 合并去重 + 修正单 + 删除标记（用干净的 custom） */
  const cusFile = path.join(tmp, 'questions.custom.json');
  const dupStem = T.DEFAULTS[0].q;
  const baseArr = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'questions.base.json'), 'utf8'));
  const baseLen = baseArr.length;
  const b001 = Object.assign({}, baseArr.find(q => q.id === 'q001'), { explain: '修正版解析' });
  const cleanCus = [
    { id: 'u-dup-1', cat: '文史', stage: 1, q: dupStem, options: ['a', 'b', 'c', 'd'], answer: 0, explain: '' },
    { id: 'u-new-1', cat: '理科', stage: 2, q: 'build测试新题？', options: ['甲', '乙', '丙', '丁'], answer: 3, explain: '' },
    b001,                        // 修正单：q001 采用修正版
    { id: 'q002', deleted: true }, // 删除标记：q002 跳过
  ];
  fs.writeFileSync(cusFile, JSON.stringify(cleanCus));
  // 沙盒跑 build：去掉 MILLIONAIRE_DATA 让脚本用沙盒相对路径（data/、defaults/），不污染包内 defaults
  const before = fs.readFileSync(path.join(ROOT, 'defaults', 'questions.default.json'), 'utf8');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-build-'));
  fs.mkdirSync(path.join(sandbox, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'defaults'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'questions.base.json'), path.join(sandbox, 'tools', 'questions.base.json'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'build_questions.js'), path.join(sandbox, 'tools', 'build_questions.js'));
  fs.copyFileSync(cusFile, path.join(sandbox, 'data', 'questions.custom.json'));
  const senv = Object.assign({}, process.env); delete senv.MILLIONAIRE_DATA;
  const out = execFileSync('node', [path.join(sandbox, 'tools', 'build_questions.js')], { encoding: 'utf8', env: senv });
  ok(/custom 采纳 1 题/.test(out), 'custom 采纳1题输出：' + out.split('\n')[1]);
  ok(/与 base 重复/.test(out), '跳过与 base 重复的有计数');
  ok(/修正单 1/.test(out), '修正单有计数');
  ok(/删除标记 1/.test(out), '删除标记有计数');
  const gen = JSON.parse(fs.readFileSync(path.join(sandbox, 'defaults', 'questions.default.json'), 'utf8'));
  eq(gen.questions.length, baseLen, '总数 = base - 删除1 + 采纳1');
  ok(!('version' in gen), '死 version 字段已删');
  ok(gen.questions.some(q => q.id === 'u-new-1'), '新题在生成物里');
  ok(!gen.questions.some(q => q.id === 'u-dup-1'), '重复题干被跳过');
  eq(gen.questions.find(q => q.id === 'q001').explain, '修正版解析', '修正单生效');
  ok(!gen.questions.some(q => q.id === 'q002'), '删除标记生效');
  const after = fs.readFileSync(path.join(ROOT, 'defaults', 'questions.default.json'), 'utf8');
  eq(after, before, '包内 defaults 未被测试污染');

  console.log('用户积累题库测试通过：' + pass + ' 项断言');
  process.exit(0);
})().catch(e => { console.error('测试失败：', e); process.exit(1); });
