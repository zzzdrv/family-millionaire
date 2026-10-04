import os, json, subprocess, tempfile, time
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = json.load(open(os.path.join(ROOT, 'defaults/questions.default.json'), encoding='utf-8'))
for q in d['questions']:
    q['q'] = '这是一道故意写得很长很长的测试题目，用来检查电视大屏在题干特别多的时候会不会溢出：请问下面关于中国古代科举制度和官员选拔的说法中，哪一项是完全正确的呢？'
    q['options'] = ['这是一个特别特别长的选项内容用来测试换行', '第二个也很长很长很长很长很长很长很长很长很长', '短', '第四个选项同样很长很长很长很长很长很长很长很长很长很长']
    q['explain'] = '这是一段故意写得很长的解析，用来检查电视底部的知识小课堂区域在文字较多时是否会被截断或者溢出屏幕。' * 3
tmp = tempfile.mkdtemp()
json.dump({'questions': d['questions']}, open(os.path.join(tmp, 'questions.json'), 'w', encoding='utf-8'), ensure_ascii=False)
env = dict(os.environ, PORT='3918', MILLIONAIRE_DATA=tmp)
srv = subprocess.Popen(['node', os.path.join(ROOT, 'server.js')], env=env, stdout=subprocess.DEVNULL)
time.sleep(1.2)
out = os.environ['SHOTS_DIR']
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        tv = b.new_page(viewport={'width': 1920, 'height': 1080}); tv.goto('http://127.0.0.1:3918/'); tv.click('#gateBtn')
        import urllib.request
        def act(a):
            r = urllib.request.Request('http://127.0.0.1:3918/api/action', data=json.dumps(a).encode(), headers={'Content-Type': 'application/json'}, method='POST'); return json.load(urllib.request.urlopen(r))
        s = act({'type': 'start', 'playerId': 'p1'})['state']; time.sleep(0.9)
        tv.screenshot(path=out + '/long_q.png')
        act({'type': 'select', 'i': s['question']['answer']}); act({'type': 'confirm'}); time.sleep(4.6)
        tv.screenshot(path=out + '/long_res.png')
        # 溢出检测：状态栏内容是否超出自身框
        r = tv.evaluate("""()=>{const s=document.querySelector('.status').getBoundingClientRect();const e=document.querySelector('.exp').getBoundingClientRect();const x=document.querySelector('.ex');return {statusH:s.height, expBottom:e.bottom, statusBottom:s.bottom, exH:x.scrollHeight, bodyOverflow:document.querySelector('.main').scrollHeight>document.querySelector('.main').clientHeight}}""")
        print(r); b.close()
finally:
    srv.terminate()
