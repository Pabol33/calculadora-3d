@echo off
rem Pide permiso de administrador (aparece el aviso de Windows) y corre "Permitir celular.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0Permitir celular.ps1""'"
