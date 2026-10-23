@echo off
setlocal
rem 如果 DSH 因插件无法启动，双击本脚本即可回滚 profile 配置。
rem 用 DSH 自带的 Node 运行（ELECTRON_RUN_AS_NODE=1），不依赖系统是否装了 node。
if "%DSH_EXE%"=="" set "DSH_EXE=D:\学习资料\新建文件夹\DeepSeek Harness.exe"
if not exist "%DSH_EXE%" (
  echo [!] 找不到 DSH 可执行文件，请设置 DSH_EXE 环境变量后重试。
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=1
"%DSH_EXE%" "%~dp0scripts\install-into-profile.mjs" --rollback
pause
