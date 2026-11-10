# Draws the Play Store feature graphic (1024x500) from the web app icon.
# Run from the repo root: powershell -File scripts/play-graphics.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $root 'public\icon-512.png'))
$bg = $src.GetPixel(5, 5)
$green = $src.GetPixel(256, 90)

$b = New-Object System.Drawing.Bitmap(1024, 500)
$g = [System.Drawing.Graphics]::FromImage($b)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear($bg)
$g.DrawImage($src, 40, 50, 400, 400)

$title = New-Object System.Drawing.Font('Segoe UI', 54, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sub = New-Object System.Drawing.Font('Segoe UI', 28, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 230, 230))
$greenBrush = New-Object System.Drawing.SolidBrush($green)
$g.DrawString('CoreDrive RX', $title, $white, 470, 165)
$g.DrawString('MeshCore coverage,', $sub, $greenBrush, 474, 245)
$g.DrawString('mapped while you drive', $sub, $greenBrush, 474, 283)

$out = Join-Path $root 'docs\play\feature-graphic.png'
$b.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $b.Dispose(); $src.Dispose()
"written $out"
