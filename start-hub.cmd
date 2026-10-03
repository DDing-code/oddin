@echo off
rem AI Hub 서버 시작 (창 보이는 버전). 숨김 실행은 start-hub-hidden.vbs
cd /d "%~dp0"
node server.mjs
pause
