@echo off
if not exist "%~dp0dist\cli.cjs" (
	echo Run "npm install" in %~dp0 first.
	exit /b 1
)
node "%~dp0dist\cli.cjs" %*
