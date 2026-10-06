'use strict';
// 新部署测试：MILLIONAIRE_DATA 指向空目录，不设 MILLIONAIRE_CONFIG，
// 启动后 data/config.json 应自动创建，内容为默认值
// 运行：node tools/test_config_fresh.js（必须单独进程跑）
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mill-fresh-'));
process.env.MILLIONAIRE_DATA = tmp;
delete process.env.MILLIONAIRE_CONFIG;
delete process.env.HOST_PIN;
delete process.env.MAX_PRIZE;
delete process.env.PORT;

const srv = require('../server.js');

let pass = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); pass++; };

(async () => {
  await new Promise(r => srv.server.listen(0, '127.0.0.1', r));
  const f = path.join(tmp, 'config.json');
  assert.ok(fs.existsSync(f), 'data/config.json 已自动创建'); pass++;
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  eq(c.port, 3000, '默认端口 3000');
  eq(c.hostPin, '', '默认空口令');
  eq(c.maxPrize, 20, '默认 maxPrize 20');
  eq(srv.cfg.port, 3000, '内存配置已载入');
  // 根目录不应再有 config.json 被读取（新部署只认 data/）
  console.log('新部署自动建配置测试通过：' + pass + ' 项断言');
  process.exit(0);
})().catch(e => { console.error('测试失败：', e); process.exit(1); });
