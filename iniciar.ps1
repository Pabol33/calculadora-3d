# Abre la Calculadora 3D: arranca el servidor local si no está andando y abre el navegador.
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 3737

function Escuchando { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

if (-not (Escuchando)) {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
    if (-not (Test-Path $node)) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show('No encuentro Node.js. Instalalo desde nodejs.org para poder laminar con Orca.', 'Calculadora 3D') | Out-Null
        exit 1
    }
    Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Hidden
    for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; if (Escuchando) { break } }
}
Start-Process "http://localhost:$port/"
