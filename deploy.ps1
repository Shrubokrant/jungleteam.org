$key = "$env:USERPROFILE\.ssh\id_ed25519"
$server = "root@204.168.245.80"
$remote = "/var/www/jungleteam"
$here = $PSScriptRoot

Write-Host "Deploying to jungleteam.org..." -ForegroundColor Cyan

scp -i $key "$here\index.html" "${server}:${remote}/index.html"
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to upload index.html"; exit 1 }

scp -i $key "$here\about.html" "${server}:${remote}/about.html"
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to upload about.html"; exit 1 }

# Upload the whole img folder into the remote root (overwrites img/* reliably on Windows;
# the "img\." form silently skips files here).
scp -i $key -r "$here\img" "${server}:${remote}/"
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to upload img/"; exit 1 }

# Animated foliage frame assets
scp -i $key "$here\foliage.css" "${server}:${remote}/foliage.css"
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to upload foliage.css"; exit 1 }

scp -i $key "$here\foliage.js" "${server}:${remote}/foliage.js"
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to upload foliage.js"; exit 1 }

scp -i $key -r "$here\foliage" "${server}:${remote}/"
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to upload foliage/"; exit 1 }

Write-Host "Done. https://jungleteam.org" -ForegroundColor Green
