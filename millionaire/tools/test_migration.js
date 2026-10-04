'use strict';
// 旧数据升级 / 损坏文件保护测试：node tools/test_migration.js
// 每个场景用独立的临时数据目录，子进程里加载 server.js，不会碰 ./data
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const V1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'questions.v1.json'), 'utf8'));   // 旧版默认题库（只有 level）
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++; };

/** 在给定数据目录里加载 server.js，打印 questions/scores/notices 的概要 JSON */
function boot(dir) {
  const code = "const T=require(" + JSON.stringify(path.join(ROOT, 'server.js')) + ")._test;" +
    "const v=T.view('host');console.log(JSON.stringify({q:T.questions,p:T.scores.players,h:T.scores.history,notices:v.notices}));process.exit(0)";
  const out = execFileSync('node', ['-e', code], { env: Object.assign({}, process.env, { MILLIONAIRE_DATA: dir, PORT: '0', HOST_PIN: '' }), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mill-mig-'));

/* 1. 旧版（无 stage、无 defaultsVersion）的数据升级 */
{
  const d = mk();
  const qs = JSON.parse(JSON.stringify(V1.questions));
  qs.splice(10, 3);                                               // 用户删掉了 3 道旧题
  qs.push({ id: 'u1', cat: '通识', level: 2, q: '用户自己加的题？', options: ['a', 'b', 'c', 'd'], answer: 1, explain: '' });
  qs[0].q = qs[0].q + '（用户改过）';                              // 改过题干的旧题 → 学段回落为 level
  fs.writeFileSync(path.join(d, 'questions.json'), JSON.stringify({ questions: qs }));
  fs.writeFileSync(path.join(d, 'scores.json'), JSON.stringify({
    players: [{ id: 'p1', name: '太太', avatar: '太', color: '#f5a623' }, { id: 'p2', name: '大儿子', avatar: '哥', color: '#4fc3f7' }],
    history: [{ id: 'h1', ts: 1, playerId: 'p1', playerName: '太太', prize: 35, result: 'walk', reached: 5 }], recentIds: [],
  }));
  const r = boot(d);
  ok(r.q.every(q => [1, 2, 3, 4].includes(q.stage) && !('level' in q)), '所有题都有学段');
  eq(r.q.length, 100 - 3 + 1 + 51, '旧题 97 + 用户题 1 + 新增 51');
  ok(!r.q.some(q => ['q011', 'q012', 'q013'].includes(q.id)), '用户删掉的旧题不会回来');
  eq(r.q.find(q => q.id === 'u1').stage, 2, '用户题 level 2 → 初中');
  eq(r.q.find(q => q.id === 'q023').stage, 4, '默认题按新标签：q023 洛阳纸贵 = 大学');
  eq(r.q.find(q => q.id === 'q001').stage, 1, '改过题干的题回落到 level');
  ok(r.p.every(p => [1, 2, 3, 4].includes(p.stage)), '老选手补上默认学段');
  eq(r.h.length, 1, '记录原样保留');
  ok(r.notices.some(n => n.level === 'info' && /升级/.test(n.text)), '有升级提示');
  ok(fs.readdirSync(path.join(d, 'backups')).some(n => n.startsWith('questions-')), '升级前已备份');
  const saved = JSON.parse(fs.readFileSync(path.join(d, 'questions.json'), 'utf8'));
  eq(saved.defaultsVersion, 2, '写回文件带版本号');
  // 第二次启动：不再重复新增
  const r2 = boot(d);
  eq(r2.q.length, r.q.length, '再次启动不会重复加题');
  eq((r2.notices || []).filter(n => n.level === 'info').length, 0, '不再提示升级');
}

/* 2. 全新目录：直接用新版默认题库，无提示 */
{
  const d = mk();
  const r = boot(d);
  eq(r.q.length, 151); eq((r.notices || []).length, 0);
  eq(r.p.map(p => p.stage), [3, 4, 2], '默认选手学段：太太高中/大儿子大学/小女儿初中');
}

/* 3. 题库文件损坏：不覆盖、改名留证、用备份恢复 */
{
  const d = mk();
  const good = { defaultsVersion: 2, questions: JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults', 'questions.default.json'), 'utf8')).questions.slice(0, 60) };
  fs.mkdirSync(path.join(d, 'backups'));
  fs.writeFileSync(path.join(d, 'backups', 'questions-20260101-000000.json'), JSON.stringify(good));
  fs.writeFileSync(path.join(d, 'questions.json'), '{"questions": [ 这不是合法的JSON');
  const r = boot(d);
  eq(r.q.length, 60, '用最近的备份恢复');
  ok(r.notices.some(n => n.level === 'error' && /题库/.test(n.text) && /备份/.test(n.text)), '有错误提示');
  ok(fs.readdirSync(d).some(n => /^questions\.corrupt-.*\.json$/.test(n)), '损坏的原文件被改名保留');
}

/* 4. 记分牌损坏且没有备份：用默认内容，但原文件保留 */
{
  const d = mk();
  fs.writeFileSync(path.join(d, 'scores.json'), '{坏了');
  const r = boot(d);
  eq(r.p.length, 3);
  ok(r.notices.some(n => n.level === 'error' && /记分牌/.test(n.text)), '有错误提示');
  ok(fs.readdirSync(d).some(n => /^scores\.corrupt-/.test(n)), '损坏的记分牌被保留');
}

/* 5. 结构不对（合法 JSON 但没有 questions 数组）也算损坏 */
{
  const d = mk();
  fs.writeFileSync(path.join(d, 'questions.json'), '{"hello":1}');
  const r = boot(d);
  eq(r.q.length, 151);
  ok(fs.readdirSync(d).some(n => /^questions\.corrupt-/.test(n)));
}

console.log('迁移与损坏保护测试通过：' + pass + ' 项断言');
