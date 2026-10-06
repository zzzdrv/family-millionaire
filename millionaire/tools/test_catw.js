'use strict';
// 类别权重测试：node tools/test_catw.js
// 使用临时数据目录，不会碰 ./data
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// ── normCatW ──
eq(T.normCatW(undefined), null, 'undefined → null');
eq(T.normCatW(null), null, 'null → null');
eq(T.normCatW({}), null, '空对象 → null');
eq(T.normCatW({ '文史': 0, '理科': 0, '通识': 0, '二次元': 0 }), null, '全0 → null');
eq(T.normCatW({ '文史': 150, '理科': -5, '通识': 'abc' }),
  { '文史': 100, '理科': 0, '通识': 0, '二次元': 0 }, '钳制 0~100，非数字按0');
eq(T.normCatW({ '文史': 30, '理科': 70 }), { '文史': 30, '理科': 70, '通识': 0, '二次元': 0 }, '部分类别');

// ── pickGame 默认行为不变 ──
const g0 = T.pickGame(3, null);
ok(g0.ok && g0.qs.length === 12, '默认抽12题');
const g0b = T.pickGame(3);
ok(g0b.ok && g0b.qs.length === 12, '不传权重抽12题');

// ── 权重 0 的类别不出题 ──
for (let i = 0; i < 20; i++) {
  const g = T.pickGame(3, { '文史': 100, '理科': 100, '通识': 100, '二次元': 0 });
  ok(g.ok && g.qs.length === 12, '加权抽12题');
  ok(g.qs.every(q => q.cat !== '二次元'), '二次元权重0 → 一题不出');
}

// ── 单类 100 ──
const g1 = T.pickGame(3, { '文史': 100, '理科': 0, '通识': 0, '二次元': 0 });
ok(g1.ok && g1.qs.length === 12, '单类抽12题');
ok(g1.qs.every(q => q.cat === '文史'), '单类100 → 全是该类');

// ── 比例大致符合权重 ──
let nW = 0, nT = 0;
for (let i = 0; i < 60; i++) {
  const g = T.pickGame(3, { '文史': 75, '理科': 25, '通识': 0, '二次元': 0 });
  ok(g.ok, '比例抽题 ok');
  g.qs.forEach(q => { nT++; if (q.cat === '文史') nW++; });
}
const ratio = nW / nT;
ok(Math.abs(ratio - 0.75) < 0.08, '文史占比≈75%，实际 ' + ratio.toFixed(3));

// ── act: 全0拒绝 ──
T.scores.players.push({ id: 'ptest1', name: '测试', avatar: '测', color: '#123456', stage: 3 });
const r1 = T.act({ type: 'start', playerId: 'ptest1', catW: { '文史': 0, '理科': 0, '通识': 0, '二次元': 0 } });
ok(!r1.ok && /至少要选/.test(r1.error), '全0拒绝开局');

// ── act: 带权重开局 + 记住偏好 ──
const r2 = T.act({ type: 'start', playerId: 'ptest1', catW: { '文史': 100, '理科': 0, '通识': 0, '二次元': 0 }, remember: true });
ok(r2.ok, '带权重开局成功');
ok(T.game.catW && T.game.catW['文史'] === 100, 'game.catW 记录本局权重');
ok(T.game.qs.every(q => q.cat === '文史'), '本局题目服从权重');
const pl = T.scores.players.find(p => p.id === 'ptest1');
ok(pl.catW && pl.catW['二次元'] === 0, '记住选手偏好');

// ── view 暴露 catMix ──
const st = T.view('host');
eq(st.catMix, T.game.catW, 'view 下发 catMix');

console.log('test_catw: 全部通过', pass, '项');
srv.server.close();
process.exit(0);
