@echo off
setlocal
rem 回滚 dsh-projectops 在 DSH profile 里的写入（备份 + 移除目录联接）。
rem 需要 DSH 可执行文件路径：设置环境变量 DSH_EXE，例如
rem   set "DSH_EXE=C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe"
if "%DSH_EXE%"=="" (
  echo [!] 请先设置 DSH_EXE 指向 DeepSeek Harness.exe
  echo     例：set "DSH_EXE=C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe"
  pause
  exit /b 1
)
if not exist "%DSH_EXE%" (
  echo [!] 找不到 DSH_EXE: %DSH_EXE%
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=1
"%DSH_EXE%" "%~dp0scripts\install-into-profile.mjs" --rollback
pause
