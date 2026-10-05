---
created: 2026-10-05 12:53:17
modified: 2026-10-05 12:59:04
---

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

题库源码在 `tools/build_questions.js`，生成的 `defaults/questions.default.json` 是默认题库。

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
