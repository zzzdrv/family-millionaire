'use strict';
/**
 * 家庭百万富翁 —— 零依赖本地服务
 *   电视：  http://<笔记本局域网IP>:3000/        （只负责显示）
 *   主持人：http://<笔记本局域网IP>:3000/host    （手机/电脑操作）
 * 数据全部存放在 ./data 目录下的 JSON 文件里，备份只要拷贝这个目录。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = process.env.MILLIONAIRE_DATA ? path.resolve(process.env.MILLIONAIRE_DATA) : path.join(ROOT, 'data');
const BACKUPS = path.join(DATA, 'backups');
const F_Q = path.join(DATA, 'questions.json');
const F_S = path.join(DATA, 'scores.json');
const F_G = path.join(DATA, 'game.json');
const F_DEF = path.join(ROOT, 'defaults', 'questions.default.json');

const CATS = ['文史', '理科', '通识', '二次元'];
const STAGES = ['小学', '初中', '高中', '大学'];   // 题目/选手的学段，序号 1~4
const VERSION = '3.7';                            // 程序版本：数据页底部显示，发版时改这里一处即可
const DEFAULT_STAGE = 3;                          // 选手没设置学段时的默认值（高中）
const DEFAULTS_VERSION = 2;                       // 默认题库版本：2 = 带学段标签（题目数量见 defaults/questions.default.json，不写死）
const clampStage = (n) => Math.max(1, Math.min(4, n));
/** 选手学段 L 的三档题目分别取哪个学段：简单档 L-1，中间档 L，最后档 L+1（两端夹住） */
const tierStages = (L) => [clampStage(L - 1), clampStage(L), clampStage(L + 1)];
const DEFAULT_LADDER = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20];
/** 校验 config.json 里的 ladder：12 个递增的正数（允许小数）。不合法返回 null，用默认梯 */
function parseLadder(v) {
  if (!Array.isArray(v) || v.length !== 12) return null;
  const xs = v.map(Number);
  if (xs.some(x => !Number.isFinite(x) || x <= 0)) return null;
  for (let i = 1; i < 12; i++) if (xs[i] <= xs[i - 1]) return null;
  return xs;
}
/** 按总奖金自动生成梯子：以经典 200 梯的形状（各级占总额比例）缩放，取整后强制递增 */
const LADDER_SHAPE = [0.025, 0.05, 0.075, 0.125, 0.175, 0.25, 0.325, 0.425, 0.525, 0.65, 0.8, 1];
function buildLadder(maxPrize) {
  const M = Number(maxPrize);
  if (!Number.isFinite(M) || M <= 0) return null;
  const unit = M >= 20 ? 1 : 0.5;   // 小总额允许 5 毛一档
  const out = [];
  for (let i = 0; i < 11; i++) {
    let v = Math.round(M * LADDER_SHAPE[i] / unit) * unit;
    v = Math.round(v * 100) / 100;   // 去浮点毛刺
    if (v <= 0) v = unit;
    if (i > 0 && v <= out[i - 1]) v = Math.round((out[i - 1] + unit) * 100) / 100;
    out.push(v);
  }
  out.push(M);
  return out;
}
const SAFE = [4, 8];            // 保险线所在题目（从0开始）：第5题、第9题
const REVEAL_MS = 3800;         // 锁定答案后的悬念时间
const PALETTE = ['#f5a623', '#4fc3f7', '#f06292', '#81c784', '#ba68c8', '#ff8a65'];
const MAX_PLAYERS = 6;

/* ───────────── 配置 ───────────── */
const cfg = { port: 3000, hostPin: '' };
try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))); } catch (e) { /* 没有配置文件就用默认值 */ }
if (process.env.PORT) cfg.port = Number(process.env.PORT);
if (process.env.HOST_PIN !== undefined) cfg.hostPin = process.env.HOST_PIN;
if (process.env.MAX_PRIZE !== undefined) cfg.maxPrize = process.env.MAX_PRIZE;
cfg.hostPin = String(cfg.hostPin || '');
// 奖金梯优先级：显式 ladder 数组 > maxPrize 自动生成 > 默认
const _explicit = parseLadder(cfg.ladder);
let LADDER;
if (_explicit) {
  LADDER = _explicit;
} else {
  if (cfg.ladder !== undefined) console.log('⚠️  config.json 里的 ladder 不合法（需要 12 个递增的正数），已忽略');
  const _built = cfg.maxPrize !== undefined ? buildLadder(cfg.maxPrize) : null;
  if (_built) {
    LADDER = _built;
  } else {
    if (cfg.maxPrize !== undefined) console.log('⚠️  config.json 里的 maxPrize 不合法（需要正数），已使用默认奖金梯');
    LADDER = DEFAULT_LADDER;
  }
}

/* ───────────── 文件读写 + 自动备份 ───────────── */
function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, f);
}
const lastBackup = {};
function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
/** 写入前留一份带时间戳的备份（同一文件 60 秒内只留一份，最多保留 40 份） */
function backup(f, force) {
  try {
    if (!fs.existsSync(f)) return;
    const base = path.basename(f, '.json');
    const now = Date.now();
    if (!force && lastBackup[base] && now - lastBackup[base] < 60000) return;
    lastBackup[base] = now;
    fs.mkdirSync(BACKUPS, { recursive: true });
    fs.copyFileSync(f, path.join(BACKUPS, base + '-' + stamp(new Date(now)) + '.json'));
    const olds = fs.readdirSync(BACKUPS).filter(n => n.startsWith(base + '-')).sort();
    while (olds.length > 40) fs.unlinkSync(path.join(BACKUPS, olds.shift()));
  } catch (e) { console.error('备份失败：', e.message); }
}

/* ───────────── 数据：题库 / 记分 ───────────── */
const DEFAULTS = (readJson(F_DEF, { questions: [] }).questions) || [];
const clone = o => JSON.parse(JSON.stringify(o));
const uid = (p) => (p || 'u') + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

const notices = [];   // 启动时发现的问题/升级说明，主持人面板会显示出来
/** 读取 JSON；文件存在但损坏时不再覆盖：先改名留证，再尝试用最近的备份恢复 */
function loadStrict(f, label, valid) {
  if (!fs.existsSync(f)) return { data: null, missing: true };
  let data = null;
  try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { data = null; }
  if (data && valid(data)) return { data };
  const bad = f.replace(/\.json$/, '') + '.corrupt-' + stamp(new Date()) + '.json';
  try { fs.renameSync(f, bad); } catch (e) { /* 改名失败也不要中断启动 */ }
  let restored = null, from = '';
  try {
    const base = path.basename(f, '.json') + '-';
    const olds = fs.readdirSync(BACKUPS).filter(n => n.startsWith(base) && n.endsWith('.json')).sort().reverse();
    for (const n of olds) {
      try { const d = JSON.parse(fs.readFileSync(path.join(BACKUPS, n), 'utf8')); if (valid(d)) { restored = d; from = n; break; } } catch (e) { /* 试下一份 */ }
    }
  } catch (e) { /* 没有备份目录 */ }
  notices.push({ level: 'error', text: label + '文件损坏，已改名保存为 ' + path.basename(bad) + '。' + (restored ? '已自动用备份 ' + from + ' 恢复。' : '没有可用的备份，已使用默认内容；损坏的原文件仍在 data 目录里，可以请人帮忙修复。') });
  return { data: restored };
}

let questions;
let qMeta = { defaultsVersion: DEFAULTS_VERSION };
/** 把旧版题目（只有难度 level）补上学段：优先用默认题库里同 id 同题干的学段，否则 level 原样当学段 */
function migrateQuestions(list) {
  const defById = {}; DEFAULTS.forEach(d => { defById[d.id] = d; });
  let n = 0;
  list.forEach(q => {
    if ([1, 2, 3, 4].includes(Number(q.stage))) { q.stage = Number(q.stage); delete q.level; return; }
    const d = defById[q.id];
    q.stage = (d && d.q === q.q) ? d.stage : ([1, 2, 3].includes(Number(q.level)) ? Number(q.level) : DEFAULT_STAGE);
    delete q.level; n++;
  });
  return n;
}
{
  const r = loadStrict(F_Q, '题库', j => j && Array.isArray(j.questions));
  if (r.data) {
    questions = r.data.questions;
    qMeta.defaultsVersion = Number(r.data.defaultsVersion) || 1;
    const tagged = migrateQuestions(questions);
    questions.forEach(q => { if (q.used !== true) q.used = false; });   // 老数据没有 used 字段，默认可用
    if (qMeta.defaultsVersion < DEFAULTS_VERSION) {
      // 旧版升级：备份 → 补上新增的默认题（原 100 题里被你删掉的不会回来）
      backup(F_Q, true);
      const have = new Set(questions.map(q => q.q.trim())), ids = new Set(questions.map(q => q.id));
      const old100 = new Set(); for (let i = 1; i <= 100; i++) old100.add('q' + String(i).padStart(3, '0'));
      let added = 0;
      DEFAULTS.forEach(d => {
        if (old100.has(d.id) || have.has(d.q.trim())) return;
        const c = clone(d); if (ids.has(c.id)) c.id = uid('u');
        questions.push(c); ids.add(c.id); have.add(c.q.trim()); added++;
      });
      qMeta.defaultsVersion = DEFAULTS_VERSION;
      writeJson(F_Q, { defaultsVersion: DEFAULTS_VERSION, questions });
      notices.push({ level: 'info', text: '题库已升级：给 ' + tagged + ' 道旧题补上了学段标签，新增 ' + added + ' 道新题（升级前的题库已备份）。可以到「题库」里检查和修改学段。' });
    } else if (tagged) { writeJson(F_Q, { defaultsVersion: qMeta.defaultsVersion, questions }); }
  } else {
    questions = clone(DEFAULTS);
    writeJson(F_Q, { defaultsVersion: DEFAULTS_VERSION, questions });
  }
}
function saveQuestions(force) { backup(F_Q, force); writeJson(F_Q, { defaultsVersion: qMeta.defaultsVersion, questions }); }
/** 题目一旦被展示就标记为已用，不再参与抽题（全家一起看，全局烧题） */
function markUsed(id) {
  const q = questions.find(x => x.id === id);
  if (q && !q.used) { q.used = true; saveQuestions(); }
}

let scores = loadStrict(F_S, '记分牌', j => j && Array.isArray(j.players)).data;
if (!scores || !Array.isArray(scores.players)) {
  scores = {
    players: [
      { id: 'p1', name: '太太', avatar: '太', color: PALETTE[0], stage: 3 },
      { id: 'p2', name: '大儿子', avatar: '哥', color: PALETTE[1], stage: 4 },
      { id: 'p3', name: '小女儿', avatar: '妹', color: PALETTE[2], stage: 2 },
    ],
    history: [], recentIds: [],
  };
  writeJson(F_S, scores);
}
scores.history = Array.isArray(scores.history) ? scores.history : [];
scores.recentIds = Array.isArray(scores.recentIds) ? scores.recentIds : [];
scores.players.forEach(p => { if (![1, 2, 3, 4].includes(Number(p.stage))) p.stage = DEFAULT_STAGE; else p.stage = Number(p.stage); });
function saveScores(force) { backup(F_S, force); writeJson(F_S, scores); }

/* ───────────── 校验 ───────────── */
function normQuestion(o) {
  if (!o || typeof o !== 'object') return { err: '格式不对' };
  const cat = String(o.cat || '').trim();
  if (!CATS.includes(cat)) return { err: '分类必须是：' + CATS.join(' / ') };
  let stage = Number(o.stage);
  if (o.stage === undefined && [1, 2, 3].includes(Number(o.level))) stage = Number(o.level);   // 兼容旧版备份：难度 1/2/3 当作学段
  if (![1, 2, 3, 4].includes(stage)) return { err: '学段必须是 ' + STAGES.join(' / ') };
  const q = String(o.q == null ? '' : o.q).trim();
  if (!q) return { err: '题目不能为空' };
  if (q.length > 200) return { err: '题目太长（最多200字）' };
  if (!Array.isArray(o.options) || o.options.length !== 4) return { err: '必须有 4 个选项' };
  const options = o.options.map(x => String(x == null ? '' : x).trim());
  if (options.some(x => !x)) return { err: '4 个选项都要填' };
  if (options.some(x => x.length > 60)) return { err: '选项太长（最多60字）' };
  if (new Set(options).size !== 4) return { err: '选项不能重复' };
  const answer = Number(o.answer);
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) return { err: '请选择正确答案' };
  const explain = String(o.explain == null ? '' : o.explain).trim();
  if (explain.length > 500) return { err: '解析太长（最多500字）' };
  return { q: { id: o.id ? String(o.id) : '', cat, stage, q, options, answer, explain, flag: !!o.flag, used: !!o.used } };
}
/* 出题类别权重：{文史:0~100, 理科:0~100, 通识:0~100, 二次元:0~100}。
 * undefined/null → null（用默认：每档每类各一题）；全 0 或非法 → null（调用方判错）。 */
function normCatW(o) {
  if (o === undefined || o === null) return null;
  if (typeof o !== 'object') return null;
  const w = {}; let sum = 0;
  for (const c of CATS) {
    let v = Number(o[c]);
    if (!Number.isFinite(v) || v < 0) v = 0;
    v = Math.min(100, v);
    w[c] = v; sum += v;
  }
  return sum > 0 ? w : null;
}

function normPlayer(o, keepId) {
  if (!o || typeof o !== 'object') return { err: '格式不对' };
  const name = String(o.name == null ? '' : o.name).trim();
  if (!name) return { err: '名字不能为空' };
  if (name.length > 12) return { err: '名字最多12个字' };
  let avatar = String(o.avatar == null ? '' : o.avatar).trim();
  if (!avatar) avatar = name.slice(0, 1);
  avatar = Array.from(avatar).slice(0, 2).join('');
  const color = /^#[0-9a-f]{6}$/i.test(String(o.color || '')) ? String(o.color) : '';
  let stage = Number(o.stage);
  if (![1, 2, 3, 4].includes(stage)) stage = DEFAULT_STAGE;
  const p = { id: keepId || (o.id ? String(o.id) : ''), name, avatar, color, stage };
  const cw = normCatW(o.catW);
  if (cw) p.catW = cw;   // 选手记住的出题偏好；PUT 没带 catW 时由调用方保留旧值
  return { p };
}
function normRecord(o) {
  if (!o || typeof o !== 'object') return null;
  const prize = Number(o.prize);
  if (!Number.isFinite(prize) || prize < 0) return null;
  const result = ['win', 'wrong', 'walk'].includes(o.result) ? o.result : 'wrong';
  return {
    id: o.id ? String(o.id) : uid('h'),
    ts: Number(o.ts) || Date.now(),
    playerId: String(o.playerId || ''),
    playerName: String(o.playerName || '').slice(0, 12),
    prize, result,
    reached: Math.max(0, Math.min(12, Number(o.reached) || 0)),
    wrongAt: Number(o.wrongAt) || 0,
    fifty: !!o.fifty, swap: !!o.swap,
    stage: [1, 2, 3, 4].includes(Number(o.stage)) ? Number(o.stage) : 0,
  };
}

/* ───────────── 抽题 ───────────── */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** stage = 选手学段(1~4)。三档题目的学段依次是 L-1 / L / L+1。
 *  catW 为空 → 每档每类各一题（旧行为）；不为空 → 按权重随机抽类别（0 权重的类不出）。
 *  只从未用过的题里抽（used=true 的题是之前对局里展示过的，全家都看过答案了）。 */
function pickGame(stage, catW) {
  const ts = tierStages(clampStage(Number(stage) || DEFAULT_STAGE));
  const w = normCatW(catW);   // null = 默认均等
  const used = new Set();
  const take = (fn) => {
    const all = questions.filter(q => !used.has(q.id) && !q.used && fn(q));
    if (!all.length) return null;
    const q = all[Math.floor(Math.random() * all.length)];
    used.add(q.id);
    return q;
  };
  const sampleCat = () => {   // 按权重抽一个类别
    const total = CATS.reduce((s, c) => s + w[c], 0);
    let r = Math.random() * total;
    for (const c of CATS) { r -= w[c]; if (r < 0) return c; }
    return CATS[CATS.length - 1];
  };
  const tiers = [];
  for (let t3 = 0; t3 < 3; t3++) {
    const level = ts[t3];
    const tier = [];
    const pushOne = (cat) => {
      let q = take(x => x.stage === level && x.cat === cat);
      if (!q && w) {   // 该类在该档没题了，按权重在别的类里补
        for (const c2 of shuffle(CATS.filter(c => c !== cat && w[c] > 0))) {
          q = take(x => x.stage === level && x.cat === c2);
          if (q) break;
        }
      }
      if (q) tier.push(q);
    };
    if (!w) {
      for (const cat of shuffle(CATS.slice())) pushOne(cat);
    } else {
      for (let s = 0; s < 4; s++) pushOne(sampleCat());
    }
    while (tier.length < 4) {      // 某类题目不够时补齐
      const cnt = {}; tier.forEach(t => { cnt[t.cat] = (cnt[t.cat] || 0) + 1; });
      let q = null;
      // 默认：补最少的类；加权：0 权重的类靠后，优先补有权重里最少的类
      const order = w
        ? CATS.slice().sort((a, b) => ((w[a] > 0 ? 0 : 1) - (w[b] > 0 ? 0 : 1)) || ((cnt[a] || 0) - (cnt[b] || 0)))
        : CATS.slice().sort((a, b) => (cnt[a] || 0) - (cnt[b] || 0));
      for (const cat of order) {
        q = take(x => x.stage === level && x.cat === cat);
        if (q) break;
      }
      q = q || take(x => Math.abs(x.stage - level) === 1 && (!w || w[x.cat] > 0))
            || take(x => !w || w[x.cat] > 0)
            || take(() => true);
      if (!q) return { ok: false, error: '可用题目不够 12 道（玩过的题不会再出现）。请到「题库」添加新题，或把已用题目重新设为可用。' };
      tier.push(q);
    }
    tiers.push(shuffle(tier));
  }
  // 档与档交界处，避免连续两题同类别
  for (let t = 0; t < 2; t++) {
    const last = tiers[t][3];
    if (tiers[t + 1][0].cat === last.cat) {
      const j = tiers[t + 1].findIndex((x, i) => i > 0 && x.cat !== last.cat);
      if (j > 0) [tiers[t + 1][0], tiers[t + 1][j]] = [tiers[t + 1][j], tiers[t + 1][0]];
    }
  }
  const qs = [].concat(...tiers).map(q => ({ id: q.id, cat: q.cat, stage: q.stage, q: q.q, options: q.options.slice(), answer: q.answer, explain: q.explain }));
  return { ok: true, qs };
}

/* ───────────── 对局状态机 ───────────── */
// phase: lobby 大厅 | question 答题中 | revealing 揭晓中 | result 已揭晓 | gameover 本局结束
let game = { phase: 'lobby' };
let muted = false;
let revealTimer = null;

function loadGame() {
  const j = readJson(F_G, null);
  if (!j) return;
  muted = !!j.muted;
  const g = j.game;
  if (g && ['question', 'revealing', 'result', 'gameover'].includes(g.phase) && Array.isArray(g.qs) && g.qs.length === 12 && g.idx >= 0 && g.idx < 12) {
    g.qs.forEach(q => { if (!q.stage) q.stage = q.level || DEFAULT_STAGE; });   // 兼容旧版存档
    game = g;
    if (game.phase === 'revealing') resolveAnswer();
  }
}
function saveGame() { try { writeJson(F_G, { muted, game }); } catch (e) { console.error('保存对局失败：', e.message); } }

const fallbackPrize = (i) => (i > 8 ? LADDER[8] : i > 4 ? LADDER[4] : 0);   // 第 i 题答错时退回的奖金
function walkPrizeNow() {
  if (game.phase === 'question' || game.phase === 'revealing') return game.idx > 0 ? LADDER[game.idx - 1] : 0;
  if (game.phase === 'result' && game.lastCorrect) return LADDER[game.idx];
  return 0;
}
function playerStats(p) {
  const h = scores.history.filter(r => r.playerId === p.id);
  return {
    id: p.id, name: p.name, avatar: p.avatar, color: p.color, stage: p.stage,
    catW: p.catW || null,   // 记住的出题偏好（主持人面板用）
    best: h.reduce((m, r) => Math.max(m, r.prize), 0),
    games: h.length,
    wins: h.filter(r => r.result === 'win').length,
    total: h.reduce((s, r) => s + r.prize, 0),
  };
}
const totalPaid = () => scores.history.reduce((s, r) => s + r.prize, 0);

function resolveAnswer() {
  if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  const q = game.qs[game.idx];
  game.lastCorrect = game.selected === q.answer;
  game.phase = 'result';
}

function endGame(result, prize, reached) {
  const before = scores.history.filter(r => r.playerId === game.playerId).reduce((m, r) => Math.max(m, r.prize), 0);
  const rec = {
    id: uid('h'), ts: Date.now(), playerId: game.playerId, playerName: game.playerName,
    prize, result, reached, wrongAt: result === 'wrong' ? game.idx + 1 : 0,
    fifty: !game.lifelines.fifty, swap: !game.lifelines.swap, stage: game.playerStage || 0,
    catMix: game.catW || null,   // 本局出题权重，复盘备查
  };
  scores.history.push(rec);
  saveScores();
  game.phase = 'gameover';
  game.outcome = { result, prize, reached, newRecord: prize > 0 && prize > before, before };
}

function startGame(playerId, catW, remember) {
  const pl = scores.players.find(p => p.id === playerId);
  if (!pl) return { ok: false, error: '找不到这位选手' };
  let w = null;
  if (catW === undefined || catW === null) {
    w = normCatW(pl.catW);   // 没指定就用选手记住的偏好（没有则默认均等）
  } else {
    w = normCatW(catW);
    if (!w) return { ok: false, error: '至少要选一个出题类别' };
  }
  if (remember && w) { pl.catW = w; saveScores(); }
  const pick = pickGame(pl.stage, w);
  if (!pick.ok) return pick;
  game = {
    phase: 'question', playerId: pl.id, playerName: pl.name, playerAvatar: pl.avatar, playerColor: pl.color, playerStage: pl.stage,
    catW: w,   // 本局出题权重（null = 默认均等），存档备查
    qs: pick.qs, usedIds: pick.qs.map(q => q.id), idx: 0, selected: null, removed: [],
    lifelines: { fifty: true, swap: true }, lastCorrect: null, outcome: null, startedAt: Date.now(),
  };
  markUsed(pick.qs[0].id);   // 第 1 题展示即烧掉
  return { ok: true };
}

function act(a) {
  const g = game;
  const bad = (m) => ({ ok: false, error: m });
  switch (a && a.type) {
    case 'start': {
      if (g.phase !== 'lobby' && g.phase !== 'gameover') return bad('本局还没结束');
      return startGame(String(a.playerId || ''), a.catW, !!a.remember);
    }
    case 'again': {
      if (g.phase !== 'gameover') return bad('现在不能再来一局');
      return startGame(g.playerId, g.catW || undefined);   // 沿用上局的出题设置
    }
    case 'select': {
      if (g.phase !== 'question') return bad('现在不能选答案');
      const i = Number(a.i);
      if (![0, 1, 2, 3].includes(i)) return bad('选项不对');
      if (g.removed.includes(i)) return bad('这个选项已被去掉');
      g.selected = i; return { ok: true };
    }
    case 'unselect': {
      if (g.phase !== 'question') return bad('现在不能取消');
      g.selected = null; return { ok: true };
    }
    case 'confirm': {
      if (g.phase !== 'question') return bad('现在不能锁定');
      if (g.selected == null) return bad('请先选择答案');
      g.phase = 'revealing';
      if (revealTimer) clearTimeout(revealTimer);
      revealTimer = setTimeout(() => { revealTimer = null; if (game.phase === 'revealing') { resolveAnswer(); commit(); } }, REVEAL_MS);
      return { ok: true };
    }
    case 'fifty': {
      if (g.phase !== 'question') return bad('现在不能使用');
      if (!g.lifelines.fifty) return bad('50:50 已经用过了');
      if (g.selected != null) return bad('请先取消已选的答案');
      const q = g.qs[g.idx];
      const wrong = [0, 1, 2, 3].filter(i => i !== q.answer);
      g.removed = shuffle(wrong).slice(0, 2).sort();
      g.lifelines.fifty = false; return { ok: true };
    }
    case 'swap': {
      if (g.phase !== 'question') return bad('现在不能使用');
      if (!g.lifelines.swap) return bad('换题已经用过了');
      if (g.selected != null) return bad('请先取消已选的答案');
      const cur = g.qs[g.idx];
      const recent = new Set(scores.recentIds);
      const used = new Set(g.usedIds);
      const cands = (fn) => questions.filter(q => !used.has(q.id) && fn(q));
      let pool = cands(q => q.stage === cur.stage && q.cat === cur.cat);
      if (!pool.length) pool = cands(q => q.stage === cur.stage);
      if (!pool.length) return bad('题库里没有可以替换的题了');
      const fresh = pool.filter(q => !recent.has(q.id));
      const src = (fresh.length ? fresh : pool);
      const n = src[Math.floor(Math.random() * src.length)];
      g.qs[g.idx] = { id: n.id, cat: n.cat, stage: n.stage, q: n.q, options: n.options.slice(), answer: n.answer, explain: n.explain };
      g.usedIds.push(n.id);
      markUsed(n.id);   // 换进来的题展示即烧掉（替代原来的 recentIds 写入）
      g.removed = [];
      g.lifelines.swap = false; return { ok: true };
    }
    case 'next': {
      if (g.phase !== 'result' || !g.lastCorrect) return bad('现在不能进入下一题');
      if (g.idx >= 11) { endGame('win', LADDER[11], 12); return { ok: true }; }
      g.idx += 1; g.selected = null; g.removed = []; g.lastCorrect = null; g.phase = 'question';
      markUsed(g.qs[g.idx].id);   // 新题展示即烧掉
      return { ok: true };
    }
    case 'walk': {
      if (g.phase === 'question') { endGame('walk', g.idx > 0 ? LADDER[g.idx - 1] : 0, g.idx); return { ok: true }; }
      if (g.phase === 'result' && g.lastCorrect && g.idx < 11) { endGame('walk', LADDER[g.idx], g.idx + 1); return { ok: true }; }
      return bad('现在不能见好就收');
    }
    case 'finish': {
      if (g.phase !== 'result' || g.lastCorrect) return bad('现在不能结算');
      endGame('wrong', fallbackPrize(g.idx), g.idx); return { ok: true };
    }
    case 'lobby': {
      if (g.phase !== 'gameover') return bad('本局还没结束');
      game = { phase: 'lobby' }; return { ok: true };
    }
    case 'abort': {
      if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
      game = { phase: 'lobby' }; return { ok: true };
    }
    case 'mute': { muted = !!a.value; return { ok: true }; }
    default: return bad('未知操作');
  }
}

/* ───────────── 视图（电视 / 主持人看到的内容不同）───────────── */
function view(role) {
  const host = role === 'host';
  const g = game;
  const out = {
    phase: g.phase, muted, ladder: LADDER, safe: SAFE,
    players: scores.players.map(playerStats),
    totalPaid: totalPaid(),
    avail: questions.filter(q => !q.used).length,   // 题库可用题数（大厅展示，烧光前有预期）
    recent: scores.history.slice(-5).reverse().map(r => ({ playerName: r.playerName, prize: r.prize, result: r.result, ts: r.ts })),
  };
  if (host) { out.clients = { tv: countClients('tv'), host: countClients('host') }; out.notices = notices; }
  else {
    // 电视视图不下发任何学段标签（电视页本来也不渲染，只是不让数据出门）
    out.players = out.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, color: p.color, best: p.best, games: p.games, wins: p.wins, total: p.total }));
  }
  if (g.phase === 'lobby') return out;

  out.player = { id: g.playerId, name: g.playerName, avatar: g.playerAvatar, color: g.playerColor };
  out.catMix = g.catW || null;   // 本局出题权重（主持人面板展示，电视端忽略）
  out.idx = g.idx;
  out.lifelines = g.lifelines;
  out.selected = g.selected;
  out.removed = g.removed;
  out.lastCorrect = g.lastCorrect;
  out.outcome = g.outcome || null;
  out.walkPrize = walkPrizeNow();
  out.fallback = fallbackPrize(g.idx);
  const q = g.qs[g.idx];
  out.question = { cat: q.cat, q: q.q, options: q.options };
  if (host) {
    out.player.stage = g.playerStage || 0;
    out.question.stage = q.stage;
    out.question.answer = q.answer;
    out.question.explain = q.explain;
    out.question.id = q.id;
  }
  if (g.phase === 'result') out.reveal = { answer: q.answer, correct: g.lastCorrect, explain: q.explain };
  return out;
}

/* ───────────── SSE 推送 ───────────── */
const clients = new Set();
const countClients = (role) => { let n = 0; clients.forEach(c => { if (c.role === role) n++; }); return n; };
function broadcast() {
  if (!clients.size) return;
  const cache = {};
  clients.forEach(c => {
    try {
      cache[c.role] = cache[c.role] || 'data: ' + JSON.stringify(view(c.role)) + '\n\n';
      c.res.write(cache[c.role]);
    } catch (e) { clients.delete(c); }
  });
}
let bcTimer = null;
function scheduleBroadcast() { if (bcTimer) return; bcTimer = setTimeout(() => { bcTimer = null; broadcast(); }, 40); }
function commit() { saveGame(); broadcast(); }
setInterval(() => { clients.forEach(c => { try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); } }); }, 15000);

/* ───────────── HTTP 工具 ───────────── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, code, obj, headers) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('内容太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('JSON 格式不对')); }
    });
    req.on('error', reject);
  });
}
const pinFails = {};   // 口令试错限频：ip -> { n, until }
/** 主持人口令校验：timingSafeEqual 防时序攻击 + 连续失败 10 次后静默 5 分钟 */
function authed(req, u) {
  if (!cfg.hostPin) return true;
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  const rec = pinFails[ip];
  if (rec && rec.until > now) return false;
  const pin = req.headers['x-host-pin'] || u.searchParams.get('pin') || '';
  let ok = false;
  try {
    const a = Buffer.from(String(pin), 'utf8'), b = Buffer.from(cfg.hostPin, 'utf8');
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { ok = false; }
  if (ok) { delete pinFails[ip]; return true; }
  const r = pinFails[ip] || { n: 0, until: 0 };
  r.n += 1;
  if (r.n >= 10) { r.until = now + 5 * 60 * 1000; r.n = 0; }
  pinFails[ip] = r;
  if (Object.keys(pinFails).length > 500) { for (const k in pinFails) delete pinFails[k]; }
  return false;
}
function lanIPs() {
  const r = [];
  const ifs = os.networkInterfaces();
  // 虚拟网卡（WireGuard / Docker / VPN 等）：电视连不上这些网段，列出来只会添乱
  const SKIP = /^(wg|docker|br-|veth|tailscale|tun|tap|vEthernet|ham)/i;
  Object.keys(ifs).forEach(k => {
    if (SKIP.test(k)) return;
    (ifs[k] || []).forEach(a => { if (a.family === 'IPv4' && !a.internal) r.push({ name: k, address: a.address }); });
  });
  r.sort((a, b) => (b.address.startsWith('192.168.') ? 1 : 0) - (a.address.startsWith('192.168.') ? 1 : 0));
  return r;
}

/* ───────────── 导入导出 ───────────── */
function buildExport() {
  return { app: 'family-millionaire', version: 2, exportedAt: new Date().toISOString(), questions, players: scores.players, history: scores.history, recentIds: scores.recentIds };
}
function applyImport(mode, data) {
  if (!data || typeof data !== 'object') throw new Error('文件内容不对');
  if (data.app && data.app !== 'family-millionaire') throw new Error('这不是本游戏的备份文件');
  const errors = [];
  let qs = null, pls = null, hist = null;
  if (data.questions !== undefined) {
    if (!Array.isArray(data.questions)) throw new Error('questions 必须是数组');
    qs = [];
    data.questions.forEach((o, i) => {
      const r = normQuestion(o);
      if (r.err) errors.push('第' + (i + 1) + '道题：' + r.err); else qs.push(r.q);
    });
  }
  if (data.players !== undefined) {
    if (!Array.isArray(data.players)) throw new Error('players 必须是数组');
    pls = [];
    data.players.forEach((o, i) => {
      const r = normPlayer(o);
      if (r.err) errors.push('第' + (i + 1) + '位选手：' + r.err); else pls.push(r.p);
    });
  }
  if (data.history !== undefined) {
    if (!Array.isArray(data.history)) throw new Error('history 必须是数组');
    hist = [];
    data.history.forEach((o, i) => {
      const r = normRecord(o);
      if (!r) errors.push('第' + (i + 1) + '条记录格式不对'); else hist.push(r);
    });
  }
  if (errors.length) throw new Error('备份文件有问题，没有导入：\n' + errors.slice(0, 6).join('\n') + (errors.length > 6 ? '\n……共 ' + errors.length + ' 处' : ''));
  if (qs === null && pls === null && hist === null) throw new Error('文件里没有找到题库、选手或记录');

  backup(F_Q, true); backup(F_S, true);
  const summary = {};
  const fixIds = (arr, existing, prefix) => {
    const seen = new Set(existing);
    arr.forEach(x => { if (!x.id || seen.has(x.id)) x.id = uid(prefix); seen.add(x.id); });
  };
  const assignColors = (arr) => arr.forEach((p, i) => { if (!p.color) p.color = PALETTE[i % PALETTE.length]; });

  if (mode === 'replace') {
    if (qs) { fixIds(qs, [], 'u'); questions = qs; qMeta.defaultsVersion = DEFAULTS_VERSION; summary.questions = qs.length; }
    if (pls) { fixIds(pls, [], 'p'); assignColors(pls); scores.players = pls.slice(0, MAX_PLAYERS); summary.players = scores.players.length; }
    if (hist) { scores.history = hist; summary.history = hist.length; }
    if (Array.isArray(data.recentIds)) scores.recentIds = data.recentIds.map(String).slice(-24);
  } else {
    if (qs) {
      const keys = new Set(questions.map(q => q.q.trim()));
      const ids = new Set(questions.map(q => q.id));
      let n = 0;
      qs.forEach(q => {
        if (keys.has(q.q)) return;
        if (!q.id || ids.has(q.id)) q.id = uid('u');
        ids.add(q.id); keys.add(q.q); questions.push(q); n++;
      });
      summary.questions = n;
    }
    const idMap = {};                // 导入文件里的选手 id → 本地选手 id（按名字合并）
    if (pls) {
      let n = 0;
      pls.forEach(p => {
        const ex = scores.players.find(x => x.name === p.name);
        if (ex) { idMap[p.id] = ex.id; return; }
        if (scores.players.length >= MAX_PLAYERS) return;
        const nid = (!p.id || scores.players.some(x => x.id === p.id)) ? uid('p') : p.id;
        idMap[p.id] = nid;
        scores.players.push({ id: nid, name: p.name, avatar: p.avatar, color: p.color || PALETTE[scores.players.length % PALETTE.length], stage: p.stage });
        n++;
      });
      summary.players = n;
    }
    if (hist) {
      const have = new Set(scores.history.map(r => r.id));
      let n = 0;
      hist.forEach(r => {
        if (have.has(r.id)) return;
        if (idMap[r.playerId]) r.playerId = idMap[r.playerId];
        have.add(r.id); scores.history.push(r); n++;
      });
      scores.history.sort((a, b) => a.ts - b.ts);
      summary.history = n;
    }
  }
  saveQuestions(); saveScores();
  return summary;
}

/* ───────────── API ───────────── */
async function api(req, res, u) {
  const p = u.pathname;
  const m = req.method;

  // 电视读取状态不需要口令
  if (p === '/api/state' && m === 'GET') {
    const role = u.searchParams.get('role') === 'host' ? 'host' : 'tv';
    if (role === 'host' && !authed(req, u)) return send(res, 401, { error: '需要口令' });
    return send(res, 200, view(role));
  }
  if (!authed(req, u)) return send(res, 401, { error: '需要口令' });

  if (p === '/api/check' && m === 'GET') return send(res, 200, { ok: true });
  if (p === '/api/info' && m === 'GET') {
    return send(res, 200, { port: cfg.port, lan: lanIPs(), pin: !!cfg.hostPin, dataDir: DATA, cats: CATS, stages: STAGES, defaultsCount: DEFAULTS.length, version: VERSION });
  }
  if (p === '/api/export' && m === 'GET') {
    const d = new Date();
    const name = '百万富翁备份-' + stamp(d).slice(0, 13) + '.json';
    return send(res, 200, JSON.stringify(buildExport(), null, 1), { 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name) });
  }

  const body = (m === 'POST' || m === 'PUT') ? await readBody(req, 20 * 1024 * 1024).catch(e => { send(res, 400, { error: e.message }); return null; }) : {};
  if (body === null) return;

  if (p === '/api/action' && m === 'POST') {
    const r = act(body);
    if (r.ok) commit();
    return send(res, r.ok ? 200 : 400, { ok: r.ok, error: r.error, state: view('host') });
  }

  /* 题库 */
  if (p === '/api/questions' && m === 'GET') return send(res, 200, { questions, cats: CATS, stages: STAGES });
  if (p === '/api/questions' && m === 'POST') {
    const r = normQuestion(body);
    if (r.err) return send(res, 400, { error: r.err });
    r.q.id = uid('u');
    questions.push(r.q); saveQuestions(); scheduleBroadcast();
    return send(res, 200, { question: r.q });
  }
  if (p === '/api/questions/reset' && m === 'POST') {
    backup(F_Q, true);
    questions = clone(DEFAULTS); qMeta.defaultsVersion = DEFAULTS_VERSION; saveQuestions(true); scheduleBroadcast();
    return send(res, 200, { count: questions.length });
  }
  if (p === '/api/questions/reuse' && m === 'POST') {
    // 把已用题目重新设为可用：不传 ids 则全部恢复，传 ids 数组则只恢复这些
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
    let n = 0;
    questions.forEach(q => { if (q.used && (!ids || ids.indexOf(q.id) >= 0)) { q.used = false; n++; } });
    if (n) saveQuestions();
    scheduleBroadcast();
    return send(res, 200, { ok: true, count: n });
  }
  let mm = p.match(/^\/api\/questions\/([^/]+)$/);
  if (mm) {
    const id = decodeURIComponent(mm[1]);
    const i = questions.findIndex(q => q.id === id);
    if (i < 0) return send(res, 404, { error: '找不到这道题' });
    if (m === 'PUT') {
      const r = normQuestion(body);
      if (r.err) return send(res, 400, { error: r.err });
      r.q.id = id; questions[i] = r.q; saveQuestions();
      return send(res, 200, { question: r.q });
    }
    if (m === 'DELETE') { questions.splice(i, 1); saveQuestions(); return send(res, 200, { ok: true }); }
  }

  /* 记分牌 / 选手 */
  if (p === '/api/scores' && m === 'GET') {
    return send(res, 200, {
      players: scores.players.map(playerStats), totalPaid: totalPaid(),
      history: scores.history.slice().reverse().slice(0, 300), historyCount: scores.history.length,
    });
  }
  if (p === '/api/players' && m === 'POST') {
    if (scores.players.length >= MAX_PLAYERS) return send(res, 400, { error: '最多 ' + MAX_PLAYERS + ' 位选手' });
    const r = normPlayer(body);
    if (r.err) return send(res, 400, { error: r.err });
    r.p.id = uid('p');
    if (!r.p.color) r.p.color = PALETTE.find(c => !scores.players.some(x => x.color === c)) || PALETTE[scores.players.length % PALETTE.length];
    scores.players.push(r.p); saveScores(); scheduleBroadcast();
    return send(res, 200, { player: r.p });
  }
  mm = p.match(/^\/api\/players\/([^/]+)$/);
  if (mm) {
    const id = decodeURIComponent(mm[1]);
    const i = scores.players.findIndex(x => x.id === id);
    if (i < 0) return send(res, 404, { error: '找不到这位选手' });
    if (m === 'PUT') {
      const r = normPlayer(body, id);
      if (r.err) return send(res, 400, { error: r.err });
      if (!r.p.color) r.p.color = scores.players[i].color;
      if (body.stage === undefined) r.p.stage = scores.players[i].stage;
      if (body.catW === undefined && scores.players[i].catW) r.p.catW = scores.players[i].catW;   // 编辑选手时保留出题偏好；传 catW:null 可清除
      scores.players[i] = r.p;
      scores.history.forEach(h => { if (h.playerId === id) h.playerName = r.p.name; });
      saveScores(); scheduleBroadcast();
      return send(res, 200, { player: r.p });
    }
    if (m === 'DELETE') {
      if (scores.players.length <= 1) return send(res, 400, { error: '至少保留一位选手' });
      scores.players.splice(i, 1); saveScores(); scheduleBroadcast();
      return send(res, 200, { ok: true });
    }
  }
  mm = p.match(/^\/api\/history\/([^/]+)$/);
  if (mm && m === 'DELETE') {
    const id = decodeURIComponent(mm[1]);
    const i = scores.history.findIndex(x => x.id === id);
    if (i < 0) return send(res, 404, { error: '找不到这条记录' });
    scores.history.splice(i, 1); saveScores(); scheduleBroadcast();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/history/clear' && m === 'POST') {
    backup(F_S, true);
    scores.history = []; scores.recentIds = []; saveScores(true); scheduleBroadcast();
    return send(res, 200, { ok: true });
  }

  /* 导入 */
  if (p === '/api/import' && m === 'POST') {
    try {
      const mode = body.mode === 'replace' ? 'replace' : 'merge';
      const summary = applyImport(mode, body.data);
      scheduleBroadcast();
      return send(res, 200, { ok: true, mode, summary });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  return send(res, 404, { error: '没有这个接口' });
}

/* ───────────── SSE 入口 ───────────── */
function sse(req, res, u) {
  const role = u.searchParams.get('role') === 'host' ? 'host' : 'tv';
  if (role === 'host' && !authed(req, u)) { res.writeHead(401); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const c = { res, role };
  clients.add(c);
  res.write('data: ' + JSON.stringify(view(role)) + '\n\n');
  req.on('close', () => { clients.delete(c); scheduleBroadcast(); });
  scheduleBroadcast();
}

/* ───────────── 静态文件 ───────────── */
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0b1a52" stroke="#ffc83d" stroke-width="4"/><text x="32" y="43" font-size="32" font-weight="900" text-anchor="middle" fill="#ffc83d" font-family="sans-serif">¥</text></svg>';
function serveStatic(req, res, p) {
  if (p === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' }); return res.end(ICON); }
  if (p === '/' || p === '/tv') p = '/tv.html';
  if (p === '/host') p = '/host.html';
  const file = path.normalize(path.join(PUB, decodeURIComponent(p)));
  if (!file.startsWith(PUB + path.sep) && file !== PUB) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, '没有找到页面', { 'Content-Type': 'text/plain; charset=utf-8' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

/* ───────────── 启动 ───────────── */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/events') return sse(req, res, u);
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    return serveStatic(req, res, u.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: '服务器出错了：' + e.message });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('\n端口 ' + cfg.port + ' 已被占用。可能游戏已经开着了，或换个端口：在 config.json 里改 "port"。\n');
  else console.error(e);
  process.exit(1);
});

if (require.main === module) {
  loadGame();
  server.listen(cfg.port, '0.0.0.0', () => {
    const ips = lanIPs();
    console.log('\n==================  家庭百万富翁 已启动  ==================');
    if (!ips.length) console.log('（没有检测到局域网地址，请确认已连上 Wi-Fi）');
    ips.forEach(ip => {
      console.log('  [' + ip.name + ']');
      console.log('    电视打开：    http://' + ip.address + ':' + cfg.port + '/');
      console.log('    主持人面板：  http://' + ip.address + ':' + cfg.port + '/host');
    });
    console.log('  本机测试：      http://localhost:' + cfg.port + '/   和   /host');
    if (cfg.hostPin) console.log('  主持人口令已开启');
    console.log('  数据目录：      ' + DATA);
    console.log('  奖金梯：        ' + LADDER.join(' → '));
    console.log('  关闭游戏：      在这个窗口按 Ctrl+C');
    console.log('===========================================================\n');
  });
}
module.exports = { server, cfg, _test: { act, view, pickGame, normCatW, applyImport, DEFAULTS, get game() { return game; }, get questions() { return questions; }, get scores() { return scores; }, LADDER, DEFAULT_LADDER, parseLadder, buildLadder, fallbackPrize } };
