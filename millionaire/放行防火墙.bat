@echo off
chcp 65001 >nul
echo 需要「以管理员身份运行」本文件，用来放行局域网访问端口 3000。
netsh advfirewall firewall add rule name="家庭百万富翁" dir=in action=allow protocol=TCP localport=3000 profile=private
echo.
echo 完成。如果上面没有报错，电视就能访问了。
pause
