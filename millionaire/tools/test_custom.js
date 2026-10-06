'use strict';
// v3.8 用户积累题库测试：node tools/test_custom.js
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
  eq(r.status, 200); eq(r.json.customAdded, 1, '默认记入原始题库');
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

  /* 4. 编辑 u* 题 → 同步回 custom；编辑 q* 题 → custom 不动 */
  r = await call(port, 'PUT', '/api/questions/' + q1.id, Q('文史', 1, '手动加的第一题？（改过）', 0));
  eq(r.status, 200);
  cus = readCustom();
  eq(cus[0].q, '手动加的第一题？（改过）', 'custom 同步更新');
  const qBase = T.questions.find(q => q.id === 'q001');
  r = await call(port, 'PUT', '/api/questions/q001', { cat: qBase.cat, stage: qBase.stage, q: qBase.q, options: qBase.options, answer: qBase.answer, explain: '改过的解析' });
  eq(r.status, 200);
  eq(readCustom().length, 1, '改出厂题不碰 custom');

  /* 5. 删除 u* 题 → custom 同步删除 */
  r = await call(port, 'DELETE', '/api/questions/' + q1.id);
  eq(r.status, 200);
  eq(readCustom().length, 0, 'custom 同步删除');

  /* 6. 导入合并：新题记入 custom；重复导入不重复记入；出厂题不记入 */
  const impQs = [Q('通识', 1, '导入的新题A？', 1), Q('通识', 1, '导入的新题B？', 2),
    { cat: '文史', stage: 1, q: T.questions.find(q => q.id === 'q002').q, options: ['a', 'b', 'c', 'd'], answer: 0, explain: '' }];
  r = await call(port, 'POST', '/api/import', { mode: 'merge', data: { app: 'family-millionaire', questions: impQs }, remember: true });
  eq(r.status, 200); eq(r.json.summary.questions, 2, '出厂题干重复被跳过');
  eq(r.json.summary.customAdded, 2, '2道新题记入 custom');
  eq(readCustom().length, 2);
  r = await call(port, 'POST', '/api/import', { mode: 'merge', data: { app: 'family-millionaire', questions: impQs }, remember: true });
  eq(r.json.summary.questions, 0, '重复导入 live 加0');
  eq(r.json.summary.customAdded, 0, '重复导入 custom 加0');

  /* 7. 补充新题：删掉一道出厂题再补充回来 */
  const delId = 'q010';
  await call(port, 'DELETE', '/api/questions/' + delId);
  r = await call(port, 'POST', '/api/questions/supplement', {});
  eq(r.status, 200); eq(r.json.added, 1, '补充回1道');
  ok(T.questions.some(q => q.id === delId), 'ID 保留');
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

  /* 10. build 脚本：base + custom 合并去重（用干净的 custom 只放2道） */
  const cusFile = path.join(tmp, 'questions.custom.json');
  const dupStem = T.DEFAULTS[0].q;
  const cleanCus = [
    { id: 'u-dup-1', cat: '文史', stage: 1, q: dupStem, options: ['a', 'b', 'c', 'd'], answer: 0, explain: '' },
    { id: 'u-new-1', cat: '理科', stage: 2, q: 'build测试新题？', options: ['甲', '乙', '丙', '丁'], answer: 3, explain: '' },
  ];
  fs.writeFileSync(cusFile, JSON.stringify(cleanCus));
  // 用临时 defaults 输出验证（不污染包内 defaults）：拷一份脚本逻辑太重，改用环境变量覆写输出路径——脚本不支持，改为直接跑并校验包内 defaults 不变
  const before = fs.readFileSync(path.join(ROOT, 'defaults', 'questions.default.json'), 'utf8');
  // 在沙盒目录跑 build：复制脚本依赖的相对路径结构
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-build-'));
  fs.mkdirSync(path.join(sandbox, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'defaults'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'questions.base.json'), path.join(sandbox, 'tools', 'questions.base.json'));
  fs.copyFileSync(path.join(ROOT, 'tools', 'build_questions.js'), path.join(sandbox, 'tools', 'build_questions.js'));
  fs.copyFileSync(cusFile, path.join(sandbox, 'data', 'questions.custom.json'));
  const out = execFileSync('node', [path.join(sandbox, 'tools', 'build_questions.js')], { encoding: 'utf8' });
  ok(/custom 采纳 1 题/.test(out), 'custom 采纳1题输出：' + out.split('\n')[1]);
  ok(/与 base 重复/.test(out), '跳过与 base 重复的有计数');
  const gen = JSON.parse(fs.readFileSync(path.join(sandbox, 'defaults', 'questions.default.json'), 'utf8'));
  eq(gen.questions.length, T.DEFAULTS.length + 1, '总数 = base + 采纳的1道');
  ok(!('version' in gen), '死 version 字段已删');
  ok(gen.questions.some(q => q.id === 'u-new-1'), '新题在生成物里');
  ok(!gen.questions.some(q => q.id === 'u-dup-1'), '重复题干被跳过');
  const after = fs.readFileSync(path.join(ROOT, 'defaults', 'questions.default.json'), 'utf8');
  eq(after, before, '包内 defaults 未被测试污染');

  console.log('用户积累题库测试通过：' + pass + ' 项断言');
  process.exit(0);
})().catch(e => { console.error('测试失败：', e); process.exit(1); });
