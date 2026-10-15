<#
  Generates nuget/icon.png — a finite-state-machine themed package icon for nuget.org.
  Run:  ./nuget/make-icon.ps1   (re-run after tweaking colours/layout)
  Pure GDI+ (System.Drawing), no external tools. 256x256 PNG, transparent corners.

  Motif: three states (circles) wired by directed transitions, with a self-loop and one
  "active" state highlighted — the visual shorthand for an automaton / FSM.
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$size = 256
$bmp  = New-Object System.Drawing.Bitmap $size, $size
$g    = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

function Color([int]$r, [int]$gr, [int]$b, [int]$a = 255) {
    [System.Drawing.Color]::FromArgb($a, $r, $gr, $b)
}

# --- Background: dark editor canvas, rounded (same family as VL.Interpole's icon) ---
$bg = New-Object System.Drawing.Drawing2D.GraphicsPath
$bx = 8; $by = 8; $bw = 240; $bh = 240; $br = 40; $d = $br * 2
$bg.AddArc($bx, $by, $d, $d, 180, 90)
$bg.AddArc($bx + $bw - $d, $by, $d, $d, 270, 90)
$bg.AddArc($bx + $bw - $d, $by + $bh - $d, $d, $d, 0, 90)
$bg.AddArc($bx, $by + $bh - $d, $d, $d, 90, 90)
$bg.CloseFigure()
$bgBrush = New-Object System.Drawing.SolidBrush (Color 26 29 35)
$g.FillPath($bgBrush, $bg); $bgBrush.Dispose()

# --- State layout: triangle of three states ---
# S0 = start (top-left), S1 = active (right), S2 (bottom-left)
$states = @(
    @{ x = 86;  y = 80;  r = 30 },   # S0
    @{ x = 182; y = 128; r = 30 },   # S1 (active)
    @{ x = 78;  y = 182; r = 30 }    # S2
)
$activeIdx = 1

# Transition pen (light grey) with an arrowhead cap.
$edgeCol = Color 176 182 194
$edgePen = New-Object System.Drawing.Pen ($edgeCol, 5.0)
$arrow   = New-Object System.Drawing.Drawing2D.AdjustableArrowCap (4.5, 5.0, $true)
$edgePen.CustomEndCap = $arrow
$edgePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round

# Draw a directed edge from state $a to state $b, trimmed to each circle's rim (+gap).
function Draw-Edge($a, $b) {
    $dx = $b.x - $a.x; $dy = $b.y - $a.y
    $len = [Math]::Sqrt($dx * $dx + $dy * $dy)
    $ux = $dx / $len; $uy = $dy / $len
    $gap = 7
    $x1 = $a.x + $ux * ($a.r + $gap);  $y1 = $a.y + $uy * ($a.r + $gap)
    $x2 = $b.x - $ux * ($b.r + $gap);  $y2 = $b.y - $uy * ($b.r + $gap)
    $g.DrawLine($edgePen, $x1, $y1, $x2, $y2)
}

Draw-Edge $states[0] $states[1]
Draw-Edge $states[1] $states[2]
Draw-Edge $states[2] $states[0]

# Self-loop on the active state: a small arc above it, ending with an arrowhead.
$s = $states[$activeIdx]
$loopPen = New-Object System.Drawing.Pen ($edgeCol, 5.0)
$loopPen.CustomEndCap = $arrow
$g.DrawArc($loopPen, ($s.x - 18), ($s.y - $s.r - 30), 46, 46, 110, 300)
$loopPen.Dispose()

# --- States: filled discs with a ring; the active one glows amber ---
foreach ($i in 0..($states.Count - 1)) {
    $st = $states[$i]
    $x = $st.x - $st.r; $y = $st.y - $st.r; $dia = $st.r * 2
    if ($i -eq $activeIdx) {
        $fill = New-Object System.Drawing.SolidBrush (Color 235 165 70)
        $ring = New-Object System.Drawing.Pen ((Color 255 205 120), 5.0)
    } else {
        $fill = New-Object System.Drawing.SolidBrush (Color 45 49 57)
        $ring = New-Object System.Drawing.Pen ((Color 90 150 230), 5.0)
    }
    $g.FillEllipse($fill, $x, $y, $dia, $dia)
    $g.DrawEllipse($ring, $x, $y, $dia, $dia)
    $fill.Dispose(); $ring.Dispose()
}

# Double-ring the start state (S0) — the "accept/start" convention.
$st0 = $states[0]
$inner = New-Object System.Drawing.Pen ((Color 90 150 230), 3.0)
$g.DrawEllipse($inner, ($st0.x - $st0.r + 7), ($st0.y - $st0.r + 7), (($st0.r - 7) * 2), (($st0.r - 7) * 2))
$inner.Dispose()

$edgePen.Dispose(); $arrow.Dispose()

$out = Join-Path $PSScriptRoot 'icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "Wrote $out"
