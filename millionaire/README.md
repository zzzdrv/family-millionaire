
# 家庭百万富翁

一个在客厅电视上玩的「百万富翁」问答游戏：电脑上跑一个零依赖的 Node.js 服务，电视浏览器打开局域网地址显示大屏，主持人用手机打开 `/host` 操作。

- 一局 12 题、奖金可自定义，第 5 题和第 9 题是保险线，可以随时见好就收
- 两种求助模式：50:50、换题各一次
- 500 道题：文史 / 理科 / 通识 / 二次元 × 小学 / 初中 / 高中 / 大学，每题带解析
- 每位选手有自己的学段，每局三档题目取「学段−1、学段、学段 +1」，所以 15 岁和 20 岁玩的难度不同
- 主持人面板：增删改题、改选手学段、记分牌、导入导出备份
- 所有数据是 `data/` 下的 JSON 文件，改动前自动备份

![](https://i.imgur.com/EtZDWPJ.png)

![](https://i.imgur.com/EgPFvX8.png)

## 运行

需要 Node.js 18 以上，没有任何依赖，不用 `npm install`。

```bash
node server.js          # Windows 可以双击 start.bat
```

启动后控制台会打印地址：电视打开 `http://<电脑局域网IP>:3000/`，主持人手机打开 `http://<电脑局域网IP>:3000/host`。
Windows 防火墙拦截时，用管理员身份运行 `放行防火墙.bat`。详细步骤见 [使用说明.md](使用说明.md)。

配置在 `config.json`：`port`（默认 3000）、`hostPin`（主持人口令，默认空）。**不设口令等于同一 Wi-Fi 下任何设备都能看到答案、改题库**，在公共网络上请务必设置。

## 测试

```bash
node tools/test_server.js       # 后端集成测试，约 4 分钟
node tools/test_migration.js    # 旧数据升级与文件损坏保护
python3 tools/e2e_browser.py    # 浏览器端到端，需要 playwright + chromium
node tools/build_questions.js   # 重新生成并校验默认题库
```

## 题库说明（请先读）

题目和解析由 AI 生成，**大部分没有对照资料核实过**，学段标签也是凭经验打的，没有用真人校准。上场前建议自己过一遍，发现错误欢迎提 issue 或 PR。

### 题库文件

四个文件，各司其职（按"谁生谁"排列）：

| 文件 | 叫法 | 作用 | 谁写 | 何时变 |
|---|---|---|---|---|
| `tools/questions.base.json` | 原始题库 | 出厂 500 题（已审核），永远不变 | 我发新版 | 发版 |
| `data/questions.custom.json` | 个人题库 | 你积累的题 + 对出厂题的修正单/删除标记，越攒越多 | 面板自动 | 玩的时候 |
| `defaults/questions.default.json` | 默认题库 | 生成物 = 原始题库（应用修正/删除后）+ 个人题库 | 服务端自动重建 | 个人题库一变就变 |
| `data/questions.json` | 当前个人题库 | 实际玩的题库 | 面板/游戏 | 玩的时候 |

记住一句话：**原始题库是死的，默认题库是活的，当前题库是玩的。**

### ID 规则

- 出厂题：`q001`、`q002`……（新批次续编号）
- 你积累的题：`u` + 时间戳 + 随机串。`u*` 从个人题库 → 默认题库 → 当前题库一路不变，永不重编号
- `q`/`u` 前缀天然隔离，撞不上

### 去重规则

统一按题干（去首尾空格后）精确匹配：

- 记入个人题库时：题干已在个人题库 → 跳过；已在默认题库 → 跳过（导备份不会把出厂题重复记进去）
- 生成默认题库时：个人题库的题干撞原始题库 → 跳过（原始优先）；个人题库内部撞 → 跳过
- "从默认题库补充新题"：默认题库有、当前题库没有的题干 → 补进当前题库

### 出厂题的改和删（修正单 / 删除标记）

不直接改 `questions.base.json`（会被新版覆盖）：

- 面板里**改**了一道出厂题 → 个人题库里记一条**同 ID 的修正单**，下次生成默认题库时优先用修正版。**改一次，永久生效**，"恢复默认题库"也不会丢
- 面板里**删**了一道出厂题 → 个人题库里记一条**删除标记**，以后生成、补充都不再出现它
- 后悔了：手动打开 `data/questions.custom.json`，删掉对应条目，下次重建即恢复出厂

### 自动重建（不用跑命令行）

个人题库每次变动（加题/导入/改题/删题/补录），服务端后台自动重新生成默认题库并热加载。"从默认题库补充新题"和"恢复默认题库"两个按钮点之前也会先重建一次（覆盖"你替换了 base.json"的场景）。

### 面板操作对照

| 操作 | 实际效果 |
|---|---|
| 手动加题时勾"同时记入默认题库"（默认勾） | 题进当前题库 + 个人题库，默认题库自动变大 |
| 导入备份 → 合并，勾"同时记入默认题库" | 同上；覆盖模式下此勾无意义（整库恢复） |
| "从默认题库补充新题"（数据页） | 默认题库有、当前题库没有的 → 补进当前题库。幂等，随便点 |
| "把新增题目记入默认题库"（数据页） | 当前题库里"原始题库没有的题"一次性记入个人题库。用于收拢历史上漏记的题，平时不用点，幂等 |
| "恢复默认题库"（数据页） | 默认题库全量覆盖当前题库（先自动备份）。你积累的题和修正单都在里面，不会丢；被你删除标记的出厂题不会回来 |
| "全部重新设为可用"（题库页） | 只清"已用"标记，题目不动。烧完重玩一轮用这个，它不是恢复题库 |

### 典型场景

1. **我出新批次**：我发完整 `questions.base.json` → 覆盖 `tools/` 下旧文件 → 面板点"从默认题库补充新题" → 新题进当前题库
2. **你手动加题**：题库页点新增 → 勾"同时记入默认题库" → 三个库自动同步
3. **发现出厂题有错**：题库页直接改 → 自动记修正单 → 以后永远是修正版
4. **某道出厂题不想再见到**：题库页删除 → 自动记删除标记 → 永不再出现
5. **题库被改乱了**：数据页"恢复默认题库" → 回到"出厂 + 你的积累 + 你的修正"状态
6. **升级程序**：分发 zip 里**没有** `data/` 目录（它是你玩出来的数据，不随代码分发）；升级时只覆盖 `server.js`、`public/`、`tools/`、`defaults/`，`data/` 原地不动

### 备份

- `data/` 下所有 JSON（含 `questions.custom.json`）每次修改前自动备份到 `data/backups/`（60 秒内去重，每个文件最多 40 份；导入/恢复/清空强制备份）
- 「数据」页导出备份包含个人题库全文（`customQuestions`），覆盖导入可完整恢复


## 部署到 linux 机器

### 克隆仓库

`sudo mkdir -p /opt/millionaire && sudo chown $USER:$USER /opt/millionaire`
`git clone https://github.com/zzzdrv/family-millionaire.git /opt/millionaire`
`cd /opt/millionaire/millionaire`

### 安装 nodejs

```
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node -v   # 应显示 v22.x
```

### 运行

`node server.js`

### systemd 保活

```
1. 建专用用户并授权（别用 root 跑服务）
useradd -r -s /usr/sbin/nologin millionaire
chown -R millionaire:millionaire /opt/millionaire

2. 写 systemd unit 文件
cat > /etc/systemd/system/millionaire.service <<'EOF'
[Unit]
Description=家庭百万富翁游戏
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=millionaire
WorkingDirectory=/opt/millionaire/millionaire
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

3. 重载、启用、启动
systemctl daemon-reload
systemctl enable --now millionaire

4. 验证
systemctl status millionaire --no-pager   # 看 Active: active (running)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # 应返回 200
journalctl -u millionaire -n 20           # 看启动日志，确认奖金梯、地址打印正常
```

### 更新代码

```
cd /opt/millionaire/millionaire && git pull
systemctl restart millionaire
```

### NPM 反代

创建 access list：
name：millionaire
Satisfy Any 保持关闭
Authentication 标签页 → 点 Add → 输入用户名和密码

创建 proxy host:
millionaire.yourdomain.com
http 局域网ip 3000
access list: millionaire
开启 Websockets Support

### cloudflare tunnel

Networking - Tunnels - 进入Tunnel "home" - add route - Published application

## 许可证

[MIT](LICENSE)，代码和题库都适用。
