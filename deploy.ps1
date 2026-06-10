$key = "$env:USERPROFILE\.ssh\id_ed25519"
$server = "root@204.168.245.80"
$remote = "/var/www/jungleteam"
$here = $PSScriptRoot

Write-Host "Deploying to jungleteam.org..." -ForegroundColor Cyan

scp -i $key "$here\index.html" "${server}:${remote}/index.html"
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to upload index.html"; exit 1 }

scp -i $key -r "$here\img\" "${server}:${remote}/img/"
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to upload img/"; exit 1 }

Write-Host "Done. https://jungleteam.org" -ForegroundColor Green
