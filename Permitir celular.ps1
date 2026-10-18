# Deja que el celular (en el mismo WiFi de tu casa) abra la Calculadora 3D de esta PC.
# 1) Crea UNA regla de entrada en el Firewall de Windows: solo el puerto 3737 y solo desde la red local.
# 2) Pone "celular": true en config.json.
# 3) Cierra el servidor para que arranque de nuevo con el celular activado (abrí la calculadora con el atajo).
# Hace falta ejecutarlo como administrador (usá "Permitir celular.bat").
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nombre = 'Calculadora 3D (celular)'
if (Get-NetFirewallRule -DisplayName $nombre -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -DisplayName $nombre }
New-NetFirewallRule -DisplayName $nombre -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3737 -RemoteAddress LocalSubnet -Profile Any | Out-Null

# config.json: se cambia solo esa línea, sin reescribir el resto (ni tocar los caracteres especiales de la carpeta)
$conf = Join-Path $dir 'config.json'
if (Test-Path -LiteralPath $conf) {
    $txt = [IO.File]::ReadAllText($conf, [Text.Encoding]::UTF8)
    $txt = $txt -replace '"celular"\s*:\s*false', '"celular": true'
    [IO.File]::WriteAllText($conf, $txt, (New-Object Text.UTF8Encoding $false))
}

# se cierra el servidor viejo; el atajo lo vuelve a abrir con el celular activado
$c = Get-NetTCPConnection -LocalPort 3737 -State Listen -ErrorAction SilentlyContinue
if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host 'Listo: el celular ya puede abrir la calculadora (puerto 3737, solo desde tu red local).'
Write-Host 'Ahora abrí la calculadora con el atajo del escritorio y tocá "Usar desde el celular".'
Write-Host 'Para quitar el permiso: Remove-NetFirewallRule -DisplayName "Calculadora 3D (celular)"  y poné "celular": false en config.json.'
Write-Host ''
Read-Host 'Enter para cerrar'
