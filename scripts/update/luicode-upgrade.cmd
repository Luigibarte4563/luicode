@echo off
REM Installs the newest published release tag. For the main-tracking upgrade, use
REM luicode-update instead.
(
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/Luigibarte4563/luicode/main/scripts/install.ps1'))) -LatestRelease" %*
  call exit /b %%errorlevel%%
)