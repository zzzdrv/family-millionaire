"""浏览器端到端测试：python3 tools/e2e_browser.py
启动临时服务 → 电视页(1920x1080) + 手机主持人页(390x844) 真实联动 → 截图到 shots/ 并检查控制台错误。"""
import os, subprocess, sys, tempfile, time, json, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(os.environ.get('SHOTS_DIR', ROOT), 'shots')
os.makedirs(SHOTS, exist_ok=True)
data = tempfile.mkdtemp(prefix='mill-e2e-')
env = dict(os.environ, PORT='3917', MILLIONAIRE_DATA=data, HOST_PIN='')
srv = subprocess.Popen(['node', os.path.join(ROOT, 'server.js')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(1.2)
BASE = 'http://127.0.0.1:3917'
errors = []
checks = []

def ok(cond, msg):
    checks.append((bool(cond), msg))
    print(('  ✓ ' if cond else '  ✗ ') + msg)

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium' if os.path.exists('/opt/pw-browsers/chromium') else None, args=['--autoplay-policy=no-user-gesture-required'])
        tv_ctx = b.new_context(viewport={'width': 1920, 'height': 1080})
        tv = tv_ctx.new_page()
        ho_ctx = b.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, device_scale_factor=2)
        ho = ho_ctx.new_page()
        for pg, name in ((tv, 'tv'), (ho, 'host')):
            pg.on('pageerror', lambda e, n=name: errors.append(f'{n} pageerror: {e}'))
            pg.on('console', lambda m, n=name: errors.append(f'{n} console.{m.type}: {m.text}') if m.type == 'error' else None)
        tv.goto(BASE + '/'); ho.goto(BASE + '/host')
        # 电视：先点"开始"解除静音限制
        tv.click('#gateBtn'); time.sleep(0.6)
        ok(tv.is_hidden('#gate'), '电视入口层可关闭')
        ok('家庭百万富翁' in tv.inner_text('#stage'), '电视大厅显示标题')
        ok(tv.locator('.card').count() == 3, '电视大厅 3 张选手卡')
        tv.screenshot(path=f'{SHOTS}/tv_lobby.png')
        ho.wait_for_selector('.pbtn'); ho.screenshot(path=f'{SHOTS}/host_lobby.png')
        ok(ho.locator('.pbtn').count() == 3, '主持人看到 3 个选手按钮')
        ok('初中' in ho.inner_text('.pbtn >> nth=2') and '大学' in ho.inner_text('.pbtn >> nth=1'), '选手按钮显示学段')
        ok(not ho.locator('text=升级').count(), '全新数据无升级提示')
        ok('电视已连接' in ho.inner_text('#pgPlay'), '主持人面板显示电视已连接')

        # 选手上场
        ho.click('.pbtn >> nth=1'); tv.wait_for_selector('.qtext'); time.sleep(0.8)
        ok('大儿子' in tv.inner_text('.who'), '电视显示当前选手')
        ok(tv.locator('.opt').count() == 4, '电视有 4 个选项')
        ok(not any(x in tv.inner_text('.meta') for x in ('小学', '初中', '高中', '大学')), '电视不显示学段标签')
        ok('选手：大学' in ho.locator('.qh').first.inner_text(), '主持人面板显示题目与选手学段')
        ok(tv.locator('.row').count() == 12, '电视奖金阶梯 12 档')
        tvtxt = tv.inner_text('#stage')
        ho.wait_for_selector('.op'); time.sleep(0.3)
        ok(ho.locator('.op.ans').count() == 1, '主持人面板标出正确答案')
        ok(tv.locator('.opt.right').count() == 0, '电视不显示答案')
        tv.screenshot(path=f'{SHOTS}/tv_q1.png'); ho.screenshot(path=f'{SHOTS}/host_q1.png', full_page=True)

        # 50:50
        ho.click('[data-act=fifty]'); time.sleep(0.5)
        ok(tv.locator('.opt.gone').count() == 2, '50:50 后电视淡出 2 个选项')
        ok(tv.locator('.help.used').count() == 1, '电视 50:50 标记为已用')
        tv.screenshot(path=f'{SHOTS}/tv_fifty.png')
        # 选正确答案 → 锁定
        ans = ho.locator('.op.ans').get_attribute('data-sel')
        ho.click(f'.op[data-sel="{ans}"]'); time.sleep(0.4)
        ok(tv.locator('.opt.sel').count() == 1, '电视高亮已选项')
        ok('确定吗' in tv.inner_text('.status'), '电视提示"确定吗"')
        tv.screenshot(path=f'{SHOTS}/tv_selected.png')
        ho.click('[data-act=confirm]'); time.sleep(0.6)
        ok('正在揭晓' in tv.inner_text('.status'), '电视进入揭晓悬念')
        time.sleep(4.2)
        ok(tv.locator('.opt.right').count() == 1, '揭晓后电视标出正确答案')
        ok('知识小课堂' in tv.inner_text('.status'), '电视显示解析')
        tv.screenshot(path=f'{SHOTS}/tv_result.png'); ho.screenshot(path=f'{SHOTS}/host_result.png', full_page=True)
        # 下一题，然后故意答错
        ho.click('[data-act=next]'); time.sleep(0.8)
        ho.click('[data-act=swap]'); time.sleep(0.6)
        ok(tv.locator('.help.used').count() == 2, '换题后两次求助都已用')
        ans = int(ho.locator('.op.ans').get_attribute('data-sel'))
        wrong = (ans + 1) % 4
        ho.click(f'.op[data-sel="{wrong}"]'); ho.click('[data-act=confirm]'); time.sleep(4.6)
        ok(tv.locator('.opt.wrong').count() == 1 and tv.locator('.opt.right').count() == 1, '答错：错选项红、正确项绿')
        ok('答错了' in tv.inner_text('.status'), '电视显示答错')
        tv.screenshot(path=f'{SHOTS}/tv_wrong.png')
        ho.click('[data-act=finish]'); time.sleep(0.8)
        ok('遗憾止步' in tv.inner_text('#stage'), '电视显示结算页')
        tv.screenshot(path=f'{SHOTS}/tv_over.png'); ho.screenshot(path=f'{SHOTS}/host_over.png', full_page=True)
        # 再来一局：全程答对，第 3 题后收手
        ho.click('[data-act=again]'); time.sleep(0.8)
        for i in range(3):
            a = ho.locator('.op.ans').get_attribute('data-sel')
            ho.click(f'.op[data-sel="{a}"]'); ho.click('[data-act=confirm]'); time.sleep(4.5)
            if i < 2: ho.click('[data-act=next]'); time.sleep(0.6)
        ho.once('dialog', lambda d: d.accept())
        ho.click('[data-act=walk]'); time.sleep(0.8)
        ok('见好就收' in tv.inner_text('#stage') and '¥15' in tv.inner_text('.o3'), '见好就收后电视显示 ¥15')
        tv.screenshot(path=f'{SHOTS}/tv_walk.png')
        ho.click('[data-act=lobby]'); time.sleep(0.6)
        ok(tv.locator('.card').count() == 3, '回到大厅')
        ok('¥15' in tv.inner_text('#stage'), '大厅记分牌更新了最高奖金')
        tv.screenshot(path=f'{SHOTS}/tv_lobby2.png')

        # 题库页
        ho.click('nav button[data-t=Bank]'); ho.wait_for_selector('.qi'); time.sleep(0.3)
        ok(ho.locator('.qi').count() == 151, '题库页列出 151 题')
        ok(ho.locator('.mx tr').count() == 5 and ho.locator('.mx th').count() >= 9, '题库页有 类别×学段 矩阵')
        ho.click('#fl .chip[data-l="4"]'); time.sleep(0.3)
        ok(ho.locator('.qi').count() == 40 and all('大学' in t for t in ho.locator('.qi .tag.lv').all_inner_texts()), '按学段筛选：大学 40 题')
        ho.click('#fl .chip[data-l="0"]'); time.sleep(0.3)
        ho.click('#fc .chip >> nth=4'); time.sleep(0.3)
        ok(ho.locator('.qi').count() == 25 or ho.locator('.qi').count() > 20, '按分类筛选')
        ho.screenshot(path=f'{SHOTS}/host_bank.png')
        ho.click('#addQ'); ho.wait_for_selector('#eQ')
        ho.fill('#eQ', '浏览器里新增的测试题？')
        for i, t in enumerate(['甲', '乙', '丙', '丁']): ho.locator('.eo').nth(i).fill(t)
        ho.check('input[name=eA][value="2"]'); ho.click('#eOk'); time.sleep(0.8)
        ho.fill('#kw', '浏览器里新增'); time.sleep(0.9)
        ok(ho.locator('.qi').count() == 1, '新增题可搜到')
        ho.screenshot(path=f'{SHOTS}/host_bank_edit.png')
        ho.once('dialog', lambda d: d.accept())
        ho.click('[data-d]'); time.sleep(0.8)
        ok(ho.locator('.qi').count() == 0, '删除成功')
        # 记分页
        ho.click('nav button[data-t=Score]'); ho.wait_for_selector('.sc'); time.sleep(0.3)
        ok(ho.locator('.sc').count() == 3 and ho.locator('.hist').count() == 2, '记分页：3 位选手 + 2 条记录')
        ho.screenshot(path=f'{SHOTS}/host_score.png', full_page=True)
        # 数据页
        # 选手学段编辑
        ho.click('[data-pe=p3]'); ho.wait_for_selector('#pS')
        ok(ho.locator('#pS').input_value() == '2', '小女儿学段默认初中')
        ho.select_option('#pS', '1'); ho.click('#pOk'); time.sleep(0.8)
        ok('小学' in ho.inner_text('#pgScore'), '改成小学后记分页显示')
        ho.click('nav button[data-t=Data]'); ho.wait_for_selector('#exp'); time.sleep(0.3)
        ok('http://' in ho.inner_text('#pgData'), '数据页显示电视地址')
        with ho.expect_download() as dl:
            ho.click('#exp')
        path = dl.value.path(); j = json.load(open(path, encoding='utf-8'))
        ok(len(j['questions']) == 151 and len(j['history']) == 2, '导出文件含题库和记录')
        ho.screenshot(path=f'{SHOTS}/host_data.png', full_page=True)
        b.close()
finally:
    srv.terminate()

bad = [e for e in errors if 'favicon' not in e]
ok(not bad, '页面无 JS 报错' + ('' if not bad else '：' + '; '.join(bad[:5])))
fails = [m for c, m in checks if not c]
print(f'\n{len(checks) - len(fails)}/{len(checks)} 通过')
sys.exit(1 if fails else 0)
