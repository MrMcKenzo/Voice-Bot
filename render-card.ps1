param(
  [Parameter(Mandatory = $true)]
  [string]$InputJson,

  [Parameter(Mandatory = $true)]
  [string]$OutputPng
)

Add-Type -AssemblyName System.Drawing

$data = Get-Content -LiteralPath $InputJson -Raw | ConvertFrom-Json

function New-CardColor {
  param(
    $Value,
    [int[]]$Fallback
  )

  $parts = @($Value)
  if ($parts.Count -lt 3) {
    $parts = $Fallback
  }

  return [System.Drawing.Color]::FromArgb(
    255,
    [Math]::Max(0, [Math]::Min(255, [int]$parts[0])),
    [Math]::Max(0, [Math]::Min(255, [int]$parts[1])),
    [Math]::Max(0, [Math]::Min(255, [int]$parts[2]))
  )
}

function Convert-CardText {
  param($Value)

  if ($null -eq $Value) {
    return ''
  }

  return ([string]$Value) `
    -replace '<@!?(\d+)>', '@User' `
    -replace '<#(\d+)>', '#Channel'
}

function Measure-CardText {
  param(
    [System.Drawing.Graphics]$Graphics,
    [string]$Text,
    [System.Drawing.Font]$Font,
    [int]$Width
  )

  if ([string]::IsNullOrWhiteSpace($Text)) {
    return 0
  }

  $size = $Graphics.MeasureString($Text, $Font, [System.Drawing.SizeF]::new($Width, 10000))
  return [int][Math]::Ceiling($size.Height)
}

function Draw-CardText {
  param(
    [System.Drawing.Graphics]$Graphics,
    [string]$Text,
    [System.Drawing.Font]$Font,
    [System.Drawing.Brush]$Brush,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height
  )

  $format = New-Object System.Drawing.StringFormat
  $format.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
  $format.FormatFlags = 0
  $Graphics.DrawString($Text, $Font, $Brush, [System.Drawing.RectangleF]::new($X, $Y, $Width, $Height), $format)
  $format.Dispose()
}

function Draw-CardTextRight {
  param(
    [System.Drawing.Graphics]$Graphics,
    [string]$Text,
    [System.Drawing.Font]$Font,
    [System.Drawing.Brush]$Brush,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height
  )

  $format = New-Object System.Drawing.StringFormat
  $format.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
  $format.Alignment = [System.Drawing.StringAlignment]::Far
  $format.FormatFlags = 0
  $Graphics.DrawString($Text, $Font, $Brush, [System.Drawing.RectangleF]::new($X, $Y, $Width, $Height), $format)
  $format.Dispose()
}

function Get-CardAvatarImage {
  param([string]$AvatarLocation)

  if ([string]::IsNullOrWhiteSpace($AvatarLocation)) {
    return $null
  }

  try {
    $bytes = $null

    if (Test-Path -LiteralPath $AvatarLocation -PathType Leaf) {
      $resolvedPath = (Resolve-Path -LiteralPath $AvatarLocation).Path
      $bytes = [System.IO.File]::ReadAllBytes($resolvedPath)
    } elseif ($AvatarLocation -match '^https?://') {
      [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
      $request = [System.Net.WebRequest]::Create($AvatarLocation)
      $request.Timeout = 3000
      $request.ReadWriteTimeout = 3000
      $request.UserAgent = 'Server bot image renderer'
      $response = $request.GetResponse()

      try {
        $responseStream = $response.GetResponseStream()
        $downloadStream = New-Object System.IO.MemoryStream

        try {
          $responseStream.CopyTo($downloadStream)
          $bytes = $downloadStream.ToArray()
        } finally {
          $downloadStream.Dispose()
          if ($responseStream) {
            $responseStream.Dispose()
          }
        }
      } finally {
        $response.Dispose()
      }
    }

    if ($null -eq $bytes -or $bytes.Length -eq 0) {
      return $null
    }

    $imageStream = [System.IO.MemoryStream]::new($bytes)
    try {
      $sourceImage = [System.Drawing.Image]::FromStream($imageStream)
      try {
        return [System.Drawing.Bitmap]::new($sourceImage)
      } finally {
        $sourceImage.Dispose()
      }
    } finally {
      $imageStream.Dispose()
    }
  } catch {
    return $null
  }
}

function Draw-CardAvatar {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Image]$Image,
    [int]$X,
    [int]$Y,
    [int]$Size
  )

  $sourceSize = [Math]::Min($Image.Width, $Image.Height)
  $sourceX = [int](($Image.Width - $sourceSize) / 2)
  $sourceY = [int](($Image.Height - $sourceSize) / 2)
  $destination = [System.Drawing.Rectangle]::new($X, $Y, $Size, $Size)
  $clipPath = New-Object System.Drawing.Drawing2D.GraphicsPath

  try {
    $clipPath.AddEllipse($destination)
    $Graphics.SetClip($clipPath)
    $Graphics.DrawImage(
      $Image,
      $destination,
      $sourceX,
      $sourceY,
      $sourceSize,
      $sourceSize,
      [System.Drawing.GraphicsUnit]::Pixel
    )
    $Graphics.ResetClip()
  } finally {
    $Graphics.ResetClip()
    $clipPath.Dispose()
  }
}

function New-CardRoundedRectanglePath {
  param(
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height,
    [int]$Radius
  )

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $radius = [Math]::Max(0, [Math]::Min($Radius, [int]([Math]::Min($Width, $Height) / 2)))

  if ($radius -eq 0) {
    $path.AddRectangle([System.Drawing.Rectangle]::new($X, $Y, $Width, $Height))
    return $path
  }

  $diameter = $radius * 2
  $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
  $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
  $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-CardRoundedRectangle {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Brush]$Brush,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height,
    [int]$Radius
  )

  $path = New-CardRoundedRectanglePath $X $Y $Width $Height $Radius
  try {
    $Graphics.FillPath($Brush, $path)
  } finally {
    $path.Dispose()
  }
}

function Fill-CardRoundedRow {
  param(
    [System.Drawing.Graphics]$Graphics,
    [System.Drawing.Brush]$PanelBrush,
    [System.Drawing.Brush]$AccentBrush,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height,
    [int]$Radius
  )

  $path = New-CardRoundedRectanglePath $X $Y $Width $Height $Radius
  try {
    $Graphics.FillPath($PanelBrush, $path)
    $Graphics.SetClip($path)
    $Graphics.FillRectangle($AccentBrush, $X, $Y, 10, $Height)
  } finally {
    $Graphics.ResetClip()
    $path.Dispose()
  }
}

function Get-CardProgressPercent {
  param($Progress)

  if ($null -eq $Progress) {
    return -1
  }

  try {
    $percent = [double]$Progress.percent
  } catch {
    return -1
  }

  if ([double]::IsNaN($percent) -or [double]::IsInfinity($percent)) {
    return -1
  }

  return [Math]::Max(0.0, [Math]::Min(1.0, $percent))
}

function Draw-CardProgressBar {
  param(
    [System.Drawing.Graphics]$Graphics,
    [double]$Percent,
    [System.Drawing.Brush]$TrackBrush,
    [System.Drawing.Brush]$FillBrush,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height
  )

  $clamped = [Math]::Max(0.0, [Math]::Min(1.0, $Percent))
  $radius = [int]($Height / 2)
  Fill-CardRoundedRectangle $Graphics $TrackBrush $X $Y $Width $Height $radius

  if ($clamped -le 0) {
    return
  }

  $inset = 4
  $innerWidth = [Math]::Max(0, $Width - ($inset * 2))
  $innerHeight = [Math]::Max(0, $Height - ($inset * 2))
  if ($innerWidth -le 0 -or $innerHeight -le 0) {
    return
  }

  $fillWidth = if ($clamped -ge 1) { $innerWidth } else { [int][Math]::Floor($innerWidth * $clamped) }
  $fillWidth = [Math]::Min($innerWidth, [Math]::Max($innerHeight, $fillWidth))
  Fill-CardRoundedRectangle $Graphics $FillBrush ($X + $inset) ($Y + $inset) $fillWidth $innerHeight ([int]($innerHeight / 2))
}

$width = 1500
$padding = 60
$contentWidth = $width - ($padding * 2)
$accent = New-CardColor $data.color @(249, 115, 22)
$background = [System.Drawing.Color]::FromArgb(255, 17, 24, 39)
$panel = [System.Drawing.Color]::FromArgb(255, 31, 41, 55)
$panelSoft = [System.Drawing.Color]::FromArgb(255, 30, 41, 59)
$text = [System.Drawing.Color]::FromArgb(255, 248, 250, 252)
$muted = [System.Drawing.Color]::FromArgb(255, 148, 163, 184)
$progressTrack = [System.Drawing.Color]::FromArgb(255, 51, 65, 85)
$softOrange = [System.Drawing.Color]::FromArgb(255, 254, 215, 170)
$labelOrange = [System.Drawing.Color]::FromArgb(255, 253, 186, 116)

$fontFamily = 'Segoe UI'
$titleFont = New-Object System.Drawing.Font($fontFamily, 44, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subtitleFont = New-Object System.Drawing.Font($fontFamily, 32, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$dateFont = New-Object System.Drawing.Font($fontFamily, 24, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$labelFont = New-Object System.Drawing.Font($fontFamily, 24, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$bodyFont = New-Object System.Drawing.Font($fontFamily, 34, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$footerFont = New-Object System.Drawing.Font($fontFamily, 24, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$badgeFont = New-Object System.Drawing.Font($fontFamily, 38, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

$measureBitmap = New-Object System.Drawing.Bitmap 1, 1
$measureGraphics = [System.Drawing.Graphics]::FromImage($measureBitmap)
$measureGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$description = Convert-CardText $data.description
$descriptionHeight = 0
if (-not [string]::IsNullOrWhiteSpace($description)) {
  $descriptionHeight = 44 + (Measure-CardText $measureGraphics $description $bodyFont ($contentWidth - 48))
}

$rows = @()
foreach ($field in @($data.fields)) {
  if ($null -eq $field) {
    continue
  }

  $label = Convert-CardText $field.name
  $value = Convert-CardText $field.value
  if ([string]::IsNullOrWhiteSpace($label) -and [string]::IsNullOrWhiteSpace($value)) {
    continue
  }

  $valueHeight = [Math]::Max(42, (Measure-CardText $measureGraphics $value $bodyFont ($contentWidth - 56)))
  $progressPercent = Get-CardProgressPercent $field.progress
  $hasProgress = $progressPercent -ge 0
  $progressHeight = if ($hasProgress) { 58 } else { 0 }
  $rowHeight = 72 + $valueHeight + $progressHeight
  $rows += [pscustomobject]@{
    Label = $label
    Value = $value
    Height = $rowHeight
    ValueHeight = $valueHeight
    HasProgress = $hasProgress
    ProgressPercent = $progressPercent
  }
}

$timestampText = Get-Date -Format 'dd/MM/yyyy, HH:mm:ss'
$timestampPlacement = Convert-CardText $data.timestampPlacement
$timestampInFooter = $timestampPlacement -eq 'footer'
$showHeaderTimestamp = -not $timestampInFooter
if ($null -ne $data.showHeaderTimestamp -and $data.showHeaderTimestamp -eq $false) {
  $showHeaderTimestamp = $false
}

$footer = Convert-CardText $data.footer
$footerLeft = Convert-CardText $data.footerLeft
if ([string]::IsNullOrWhiteSpace($footerLeft) -and -not [string]::IsNullOrWhiteSpace($footer)) {
  $footerLeft = $footer
}
if ($timestampInFooter -and [string]::IsNullOrWhiteSpace($footerLeft)) {
  $footerLeft = $timestampText
}
$footerRight = Convert-CardText $data.footerRight
$hasFooterContent =
  -not [string]::IsNullOrWhiteSpace($footer) -or
  -not [string]::IsNullOrWhiteSpace($footerLeft) -or
  -not [string]::IsNullOrWhiteSpace($footerRight)
$footerHeight = if ($hasFooterContent) { 70 } else { 0 }
$rowsHeight = 0
foreach ($row in $rows) {
  $rowsHeight += $row.Height + 22
}

$layoutBase = if ($showHeaderTimestamp) { 240 } else { 214 }
$height = [Math]::Max(520, $layoutBase + $descriptionHeight + $rowsHeight + $footerHeight + $padding)

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$graphics.Clear($background)

$accentBrush = New-Object System.Drawing.SolidBrush $accent
$backgroundBrush = New-Object System.Drawing.SolidBrush $background
$panelBrush = New-Object System.Drawing.SolidBrush $panel
$panelSoftBrush = New-Object System.Drawing.SolidBrush $panelSoft
$textBrush = New-Object System.Drawing.SolidBrush $text
$mutedBrush = New-Object System.Drawing.SolidBrush $muted
$progressTrackBrush = New-Object System.Drawing.SolidBrush $progressTrack
$softOrangeBrush = New-Object System.Drawing.SolidBrush $softOrange
$labelOrangeBrush = New-Object System.Drawing.SolidBrush $labelOrange

$graphics.FillRectangle($accentBrush, 0, 0, $width, 18)
$avatarImage = Get-CardAvatarImage (Convert-CardText $data.avatarUrl)
if ($null -ne $avatarImage) {
  $graphics.FillEllipse($accentBrush, $padding, 58, 116, 116)
  Draw-CardAvatar $graphics $avatarImage $padding 58 116
  $avatarImage.Dispose()
} else {
  $graphics.FillRectangle($accentBrush, $padding, 58, 116, 116)

  $badge = Convert-CardText $data.badge
  if ([string]::IsNullOrWhiteSpace($badge)) {
    $badge = 'BOT'
  }
  $badge = $badge.Substring(0, [Math]::Min(3, $badge.Length)).ToUpperInvariant()
  Draw-CardText $graphics $badge $badgeFont $textBrush ($padding + 24) 96 90 60
}

$title = Convert-CardText $data.title
if ([string]::IsNullOrWhiteSpace($title)) {
  $title = 'Voice Room Bot'
}
Draw-CardText $graphics $title $titleFont $textBrush ($padding + 145) 60 ($contentWidth - 145) 58

$subtitle = Convert-CardText $data.subtitle
if (-not [string]::IsNullOrWhiteSpace($subtitle)) {
  Draw-CardText $graphics $subtitle $subtitleFont $softOrangeBrush ($padding + 145) 120 ($contentWidth - 145) 44
}

if ($showHeaderTimestamp) {
  Draw-CardText $graphics $timestampText $dateFont $mutedBrush ($padding + 145) 172 ($contentWidth - 145) 34
}

$cursorY = if ($showHeaderTimestamp) { 232 } else { 206 }
if ($descriptionHeight -gt 0) {
  Fill-CardRoundedRectangle $graphics $panelSoftBrush $padding $cursorY $contentWidth $descriptionHeight 18
  Draw-CardText $graphics $description $bodyFont $textBrush ($padding + 28) ($cursorY + 22) ($contentWidth - 56) ($descriptionHeight - 32)
  $cursorY += $descriptionHeight + 24
}

foreach ($row in $rows) {
  Fill-CardRoundedRow $graphics $panelBrush $accentBrush $padding $cursorY $contentWidth $row.Height 18
  Draw-CardText $graphics $row.Label $labelFont $labelOrangeBrush ($padding + 28) ($cursorY + 18) ($contentWidth - 56) 34
  Draw-CardText $graphics $row.Value $bodyFont $textBrush ($padding + 28) ($cursorY + 56) ($contentWidth - 56) ($row.ValueHeight + 8)

  if ($row.HasProgress) {
    Draw-CardProgressBar $graphics $row.ProgressPercent $progressTrackBrush $accentBrush ($padding + 28) ($cursorY + 68 + $row.ValueHeight) ($contentWidth - 56) 32
  }

  $cursorY += $row.Height + 22
}

if ($hasFooterContent) {
  $footerY = $height - 58

  if (-not [string]::IsNullOrWhiteSpace($footerLeft)) {
    Draw-CardText $graphics $footerLeft $footerFont $mutedBrush $padding $footerY ([int]($contentWidth / 2)) 40
  }

  if (-not [string]::IsNullOrWhiteSpace($footerRight)) {
    Draw-CardTextRight $graphics $footerRight $footerFont $mutedBrush ($padding + [int]($contentWidth / 2)) $footerY ([int]($contentWidth / 2)) 40
  }
}

$outputDirectory = Split-Path -Parent $OutputPng
if (-not [string]::IsNullOrWhiteSpace($outputDirectory) -and -not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

$bitmap.Save($OutputPng, [System.Drawing.Imaging.ImageFormat]::Png)

$labelOrangeBrush.Dispose()
$softOrangeBrush.Dispose()
$mutedBrush.Dispose()
$progressTrackBrush.Dispose()
$textBrush.Dispose()
$panelSoftBrush.Dispose()
$panelBrush.Dispose()
$backgroundBrush.Dispose()
$accentBrush.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
$measureGraphics.Dispose()
$measureBitmap.Dispose()
$badgeFont.Dispose()
$footerFont.Dispose()
$bodyFont.Dispose()
$labelFont.Dispose()
$dateFont.Dispose()
$subtitleFont.Dispose()
$titleFont.Dispose()
