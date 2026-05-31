@echo off
setlocal

rem Usage: init-target-harness.cmd [git-remote-url] [dest] [extra powershell args]
rem Example: init-target-harness.cmd https://github.com/cycho21/harness.git

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0init-target-harness.ps1" %*
exit /b %ERRORLEVEL%
