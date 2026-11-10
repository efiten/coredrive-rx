# Regenerates the Android launcher icons and splash images from the web app icon
# (public/icon-512.png), so the app and the PWA carry the same logo.
# Run from the repo root: powershell -File scripts/android-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$res = Join-Path $root 'android\app\src\main\res'
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $root 'public\icon-512.png'))
$bg = $src.GetPixel(5, 5) # the icon's own background colour

function New-Canvas([int]$w, [int]$h) {
  $b = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  return @($b, $g)
}

function Save([System.Drawing.Bitmap]$b, [string]$rel) {
  $b.Save((Join-Path $res $rel), [System.Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
}

# Adaptive icon foreground: 108 dp canvas, of which a 66 dp circle survives any launcher
# mask. The ring spans 68% of the source, so the source is drawn at 86% of the canvas
# (ring = 58% < 61%); the transparent margin shows the background colour below it.
$dens = @{ 'mdpi' = 1; 'hdpi' = 1.5; 'xhdpi' = 2; 'xxhdpi' = 3; 'xxxhdpi' = 4 }
foreach ($d in $dens.Keys) {
  $f = $dens[$d]
  $fg = [int](108 * $f); $b, $g = New-Canvas $fg $fg
  $s = [int]($fg * 0.86); $o = [int](($fg - $s) / 2)
  $g.DrawImage($src, $o, $o, $s, $s); $g.Dispose()
  Save $b "mipmap-$d\ic_launcher_foreground.png"

  $lg = [int](48 * $f)
  $b, $g = New-Canvas $lg $lg
  $g.DrawImage($src, 0, 0, $lg, $lg); $g.Dispose()
  Save $b "mipmap-$d\ic_launcher.png"

  $b, $g = New-Canvas $lg $lg
  $brush = New-Object System.Drawing.TextureBrush($src)
  $brush.ScaleTransform($lg / $src.Width, $lg / $src.Height)
  $g.FillEllipse($brush, 0, 0, $lg, $lg); $brush.Dispose(); $g.Dispose()
  Save $b "mipmap-$d\ic_launcher_round.png"
}

# Splash: the icon centred on its background colour, 40% of the short side.
Get-ChildItem $res -Recurse -Filter splash.png | ForEach-Object {
  $old = [System.Drawing.Image]::FromFile($_.FullName); $w = $old.Width; $h = $old.Height; $old.Dispose()
  $b, $g = New-Canvas $w $h
  $g.Clear($bg)
  $s = [int]([Math]::Min($w, $h) * 0.4)
  $g.DrawImage($src, [int](($w - $s) / 2), [int](($h - $s) / 2), $s, $s); $g.Dispose()
  $b.Save($_.FullName, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
}

$hex = '#{0:X2}{1:X2}{2:X2}' -f $bg.R, $bg.G, $bg.B
$xml = "<?xml version=`"1.0`" encoding=`"utf-8`"?>`n<resources>`n    <color name=`"ic_launcher_background`">$hex</color>`n</resources>"
[System.IO.File]::WriteAllText((Join-Path $res 'values\ic_launcher_background.xml'), $xml)
$src.Dispose()
"icons and splash written, background $hex"
