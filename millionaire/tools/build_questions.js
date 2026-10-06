'use strict';
/* v3.9：纯逻辑脚本，不再内含题目。
 * 读 tools/questions.base.json（出厂题） + data/questions.custom.json（用户积累）
 * → 校验 → 按题干去重 → 写 defaults/questions.default.json
 * custom.json 里 id 为 q* 的条目是"修正单"：面板编辑出厂题时写入同 ID 修正版，
 * build 时优先采用；{ id:'q*', deleted:true } 是删除标记，该出厂题直接跳过。
 * 用法：node tools/build_questions.js  （在项目根目录跑）
 * 注意：服务端在 custom 变动后会自动跑本脚本并热加载，面板用户一般不需要手动跑。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* 数据目录跟 server.js 保持一致：测试时用 MILLIONAIRE_DATA 指向临时目录，避免污染真实文件 */
const DATA = process.env.MILLIONAIRE_DATA ? path.resolve(process.env.MILLIONAIRE_DATA) : path.join(ROOT, 'data');
const F_BASE = path.join(ROOT, 'tools', 'questions.base.json');
const F_CUS = path.join(DATA, 'questions.custom.json');
const F_OUT = process.env.MILLIONAIRE_DATA ? path.join(DATA, 'questions.default.json') : path.join(ROOT, 'defaults', 'questions.default.json');

const CATS = ['文史', '理科', '通识', '二次元'];

function fail(m) { console.error('校验失败：' + m); process.exit(1); }

function loadArr(f, required, name) {
  if (!fs.existsSync(f)) {
    if (required) fail('找不到 ' + f);
    return [];
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { fail(f + ' 不是合法 JSON：' + e.message); }
  if (!Array.isArray(j)) fail(f + ' 顶层必须是数组（' + name + '）');
  return j;
}

function check(q, where) {
  if (!q || typeof q !== 'object') fail(where + '：不是对象');
  if (!CATS.includes(q.cat)) fail(where + '：cat 非法（' + q.cat + '）');
  if (![1, 2, 3, 4].includes(q.stage)) fail(where + '：stage 非法（' + q.stage + '）');
  const stem = String(q.q == null ? '' : q.q).trim();
  if (!stem) fail(where + '：题干为空');
  if (!Array.isArray(q.options) || q.options.length !== 4) fail(where + '：必须有 4 个选项');
  const options = q.options.map(o => String(o == null ? '' : o).trim());
  if (options.some(o => !o)) fail(where + '：选项不能为空');
  if (new Set(options).size !== 4) fail(where + '：选项重复');
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) fail(where + '：answer 非法');
  return { stem, options };
}

function norm(q, stem, options, fallbackId) {
  const o = {
    id: q.id ? String(q.id) : fallbackId,
    cat: q.cat,
    stage: q.stage,
    q: stem,
    options,
    answer: q.answer,
    explain: String(q.explain == null ? '' : q.explain).trim(),
  };
  if (q.flag) o.flag = true;
  return o;
}

const base = loadArr(F_BASE, true, 'base');
const custom = loadArr(F_CUS, false, 'custom');

/* custom 分流：q* ID 的是出厂题修正单/删除标记，其余是用户积累题（u*） */
const overrides = new Map();
const ucustoms = [];
custom.forEach((q, i) => {
  if (!q || typeof q !== 'object') fail('custom[' + i + ']：不是对象');
  const id = q.id == null ? '' : String(q.id);
  if (q.deleted === true && id) { overrides.set(id, { deleted: true }); return; }
  if (id && id[0] === 'q') { overrides.set(id, q); return; }
  ucustoms.push(q);
});

const out = [];
const seen = new Set();
let nOverride = 0, nTomb = 0;
base.forEach((q, i) => {
  const id = q.id ? String(q.id) : 'q' + String(i + 1).padStart(3, '0');
  const ov = overrides.get(id);
  if (ov && ov.deleted) { nTomb++; return; }          // 出厂题被用户删除：跳过
  const src = ov || q;
  const where = ov ? 'override ' + id : 'base[' + i + ']';
  const { stem, options } = check(src, where);
  if (seen.has(stem)) fail(where + ' 题干重复：' + stem.slice(0, 40));
  seen.add(stem);
  if (ov) nOverride++;
  out.push(norm(src, stem, options, id));
});

const baseStems = new Set(seen);   // 出厂题干（含修正版），u* 题撞上的一律跳过
let customOk = 0, skipBase = 0, skipDup = 0;
ucustoms.forEach((q, i) => {
  const { stem, options } = check(q, 'custom[' + i + ']');
  if (baseStems.has(stem)) { skipBase++; return; }   // base 优先
  if (seen.has(stem)) { skipDup++; return; }          // custom 内部重复
  seen.add(stem);
  customOk++;
  out.push(norm(q, stem, options, 'u' + Date.now().toString(36) + '-' + i));
});

// 统计
const grid = {}, pos = [0, 0, 0, 0];
out.forEach(q => {
  const k = q.cat + q.stage;
  grid[k] = (grid[k] || 0) + 1;
  pos[q.answer]++;
});

fs.mkdirSync(path.dirname(F_OUT), { recursive: true });
fs.writeFileSync(F_OUT, JSON.stringify({ app: 'family-millionaire', questions: out }, null, 1));

console.log('已生成 ' + out.length + ' 题 → ' + F_OUT);
console.log('其中 base ' + base.length + ' 题（含修正单 ' + nOverride + '、删除标记 ' + nTomb + '），' +
  'custom 采纳 ' + customOk + ' 题，custom 跳过 ' + skipBase + '（与 base 重复）+ ' + skipDup + '（custom 内重复）');
console.log('各格数量（类别+学段）：', grid);
console.log('答案位置分布 A/B/C/D：', pos.join('/'));
const minPos = Math.min(...pos);
if (minPos < out.length * 0.15) console.log('⚠️  答案位置分布偏斜，最少的一项只有 ' + minPos + ' 题');
