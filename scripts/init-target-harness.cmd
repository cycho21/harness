@echo off
setlocal
chcp 65001 >nul
set PYTHONIOENCODING=utf-8

rem Usage: init-target-harness.cmd [git-remote-url] [dest] [extra powershell args]
rem Example: init-target-harness.cmd https://github.com/chochanyeon/harness.git

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0init-target-harness.ps1" %*
exit /b %ERRORLEVEL%
