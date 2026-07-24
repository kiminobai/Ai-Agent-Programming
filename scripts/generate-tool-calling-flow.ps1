Add-Type -AssemblyName System.Drawing

# 本脚本离线绘制 Tool Calling 流程，区分 LLM 选择工具与应用执行工具。
$scriptDirectory = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path (Get-Location) "scripts" }
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory "..\docs\tool-calling-flow.png"))
$width = 1600
$height = 1180

$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$bitmap.SetResolution(144, 144)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$background = [System.Drawing.ColorTranslator]::FromHtml("#F7F1E8")
$surface = [System.Drawing.ColorTranslator]::FromHtml("#FFFAF4")
$toolSurface = [System.Drawing.ColorTranslator]::FromHtml("#F2DFC8")
$decisionSurface = [System.Drawing.ColorTranslator]::FromHtml("#FFF2DF")
$ink = [System.Drawing.ColorTranslator]::FromHtml("#2F241D")
$mutedInk = [System.Drawing.ColorTranslator]::FromHtml("#6D5547")
$accent = [System.Drawing.ColorTranslator]::FromHtml("#B85D22")
$border = [System.Drawing.ColorTranslator]::FromHtml("#5B4031")
$divider = [System.Drawing.ColorTranslator]::FromHtml("#D8C7B8")

$graphics.Clear($background)

$fontFamily = [System.Drawing.FontFamily]::new("Microsoft YaHei UI")
$titleFont = [System.Drawing.Font]::new($fontFamily, 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subtitleFont = [System.Drawing.Font]::new($fontFamily, 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$labelFont = [System.Drawing.Font]::new($fontFamily, 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$branchFont = [System.Drawing.Font]::new($fontFamily, 16, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$stepFont = [System.Drawing.Font]::new($fontFamily, 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)

$inkBrush = [System.Drawing.SolidBrush]::new($ink)
$mutedBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml("#8A6044"))
$surfaceBrush = [System.Drawing.SolidBrush]::new($surface)
$toolBrush = [System.Drawing.SolidBrush]::new($toolSurface)
$decisionBrush = [System.Drawing.SolidBrush]::new($decisionSurface)
$finalBrush = [System.Drawing.SolidBrush]::new($ink)
$lightBrush = [System.Drawing.SolidBrush]::new($surface)
$accentBrush = [System.Drawing.SolidBrush]::new($accent)

$borderPen = [System.Drawing.Pen]::new($border, 2.5)
$accentPen = [System.Drawing.Pen]::new($accent, 3)
$mutedPen = [System.Drawing.Pen]::new($mutedInk, 2.5)
$dividerPen = [System.Drawing.Pen]::new($divider, 1.5)
$accentPen.CustomEndCap = [System.Drawing.Drawing2D.AdjustableArrowCap]::new(6, 8, $true)
$mutedPen.CustomEndCap = [System.Drawing.Drawing2D.AdjustableArrowCap]::new(6, 8, $true)

$centerFormat = [System.Drawing.StringFormat]::new()
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
$centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

function New-RoundedPath {
    param(
        [float] $X,
        [float] $Y,
        [float] $Width,
        [float] $Height,
        [float] $Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-Node {
    param(
        [float] $X,
        [float] $Y,
        [float] $Width,
        [float] $Height,
        [string] $Text,
        [System.Drawing.Brush] $Fill = $surfaceBrush,
        [System.Drawing.Pen] $Stroke = $borderPen,
        [System.Drawing.Brush] $TextBrush = $inkBrush
    )

    $path = New-RoundedPath $X $Y $Width $Height 20
    $graphics.FillPath($Fill, $path)
    $graphics.DrawPath($Stroke, $path)
    $graphics.DrawString($Text, $labelFont, $TextBrush, [System.Drawing.RectangleF]::new($X, $Y, $Width, $Height), $centerFormat)
    $path.Dispose()
}

function Draw-Decision {
    param(
        [float] $CenterX,
        [float] $CenterY,
        [float] $HalfWidth,
        [float] $HalfHeight,
        [string] $Text
    )

    $points = [System.Drawing.PointF[]] @(
        [System.Drawing.PointF]::new($CenterX, $CenterY - $HalfHeight),
        [System.Drawing.PointF]::new($CenterX + $HalfWidth, $CenterY),
        [System.Drawing.PointF]::new($CenterX, $CenterY + $HalfHeight),
        [System.Drawing.PointF]::new($CenterX - $HalfWidth, $CenterY)
    )
    $graphics.FillPolygon($decisionBrush, $points)
    $graphics.DrawPolygon($accentPen, $points)
    $graphics.DrawString(
        $Text,
        $labelFont,
        $inkBrush,
        [System.Drawing.RectangleF]::new($CenterX - $HalfWidth, $CenterY - $HalfHeight, $HalfWidth * 2, $HalfHeight * 2),
        $centerFormat
    )
}

function Draw-Arrow {
    param(
        [System.Drawing.Pen] $Pen,
        [System.Drawing.PointF[]] $Points
    )

    if ($Points.Length -eq 2) {
        $graphics.DrawLine($Pen, $Points[0], $Points[1])
        return
    }

    $graphics.DrawLines($Pen, $Points)
}

function Draw-BranchLabel {
    param([string] $Text, [float] $X, [float] $Y)

    $size = $graphics.MeasureString($Text, $branchFont)
    $padding = 5
    $graphics.FillRectangle(
        [System.Drawing.SolidBrush]::new($background),
        $X - $padding,
        $Y - $padding,
        $size.Width + ($padding * 2),
        $size.Height + ($padding * 2)
    )
    $graphics.DrawString($Text, $branchFont, $accentBrush, $X, $Y)
}

$graphics.DrawString("Tool Calling 流程图", $titleFont, $inkBrush, 70, 38)
$graphics.DrawString("模型判断、工具执行、结果校验与循环推理", $subtitleFont, $mutedBrush, 70, 82)
$graphics.DrawLine($dividerPen, 70, 112, 1530, 112)

Draw-Node 650 135 300 78 "用户输入问题"
Draw-Decision 800 330 200 80 "是否需要调用工具？"
Draw-Node 160 470 300 78 "模型直接生成答案"
Draw-Node 650 470 300 78 "分析任务意图"
Draw-Node 650 600 300 78 "选择合适的工具"
Draw-Node 650 730 300 78 "构造 Tool Call 参数"
Draw-Node 650 860 300 78 "发起 Tool Calling 请求"
Draw-Node 1110 860 300 78 "工具执行" $toolBrush $accentPen
Draw-Node 1110 730 300 78 "返回工具结果" $toolBrush $accentPen
Draw-Decision 1260 639 175 84 "结果是否足够？"
Draw-Node 1110 470 300 78 "模型继续推理"
Draw-Node 1110 985 300 78 "整合工具结果"
Draw-Node 650 985 300 78 "生成最终回复"
Draw-Node 190 985 300 78 "返回给用户" $finalBrush $borderPen $lightBrush

Draw-Arrow $mutedPen @([System.Drawing.PointF]::new(800, 213), [System.Drawing.PointF]::new(800, 250))
Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(600, 330),
    [System.Drawing.PointF]::new(310, 330),
    [System.Drawing.PointF]::new(310, 470)
)
Draw-BranchLabel "否" 435 306
Draw-Arrow $accentPen @([System.Drawing.PointF]::new(800, 410), [System.Drawing.PointF]::new(800, 470))
Draw-BranchLabel "是" 822 432

Draw-Arrow $mutedPen @([System.Drawing.PointF]::new(800, 548), [System.Drawing.PointF]::new(800, 600))
Draw-Arrow $mutedPen @([System.Drawing.PointF]::new(800, 678), [System.Drawing.PointF]::new(800, 730))
Draw-Arrow $mutedPen @([System.Drawing.PointF]::new(800, 808), [System.Drawing.PointF]::new(800, 860))
Draw-Arrow $accentPen @([System.Drawing.PointF]::new(950, 899), [System.Drawing.PointF]::new(1110, 899))
Draw-Arrow $accentPen @([System.Drawing.PointF]::new(1260, 860), [System.Drawing.PointF]::new(1260, 808))
Draw-Arrow $accentPen @([System.Drawing.PointF]::new(1260, 730), [System.Drawing.PointF]::new(1260, 723))

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1085, 639),
    [System.Drawing.PointF]::new(1030, 639),
    [System.Drawing.PointF]::new(1030, 509),
    [System.Drawing.PointF]::new(1110, 509)
)
Draw-BranchLabel "否" 1040 603
Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1110, 509),
    [System.Drawing.PointF]::new(1010, 509),
    [System.Drawing.PointF]::new(1010, 639),
    [System.Drawing.PointF]::new(950, 639)
)
Draw-BranchLabel "重新选择" 965 467

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1435, 639),
    [System.Drawing.PointF]::new(1490, 639),
    [System.Drawing.PointF]::new(1490, 1024),
    [System.Drawing.PointF]::new(1410, 1024)
)
Draw-BranchLabel "是" 1450 655
Draw-Arrow $mutedPen @([System.Drawing.PointF]::new(1110, 1024), [System.Drawing.PointF]::new(950, 1024))
Draw-Arrow $mutedPen @([System.Drawing.PointF]::new(650, 1024), [System.Drawing.PointF]::new(490, 1024))
Draw-Arrow $mutedPen @([System.Drawing.PointF]::new(310, 548), [System.Drawing.PointF]::new(310, 985))

$steps = @(
    @{ Text = "01"; X = 635; Y = 486 },
    @{ Text = "02"; X = 635; Y = 616 },
    @{ Text = "03"; X = 635; Y = 746 },
    @{ Text = "04"; X = 635; Y = 876 },
    @{ Text = "05"; X = 1095; Y = 876 },
    @{ Text = "06"; X = 1095; Y = 746 }
)
foreach ($step in $steps) {
    $graphics.DrawString($step.Text, $stepFont, $accentBrush, $step.X, $step.Y)
}

$outputDirectory = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$centerFormat.Dispose()
$accentPen.Dispose()
$mutedPen.Dispose()
$borderPen.Dispose()
$dividerPen.Dispose()
$inkBrush.Dispose()
$mutedBrush.Dispose()
$surfaceBrush.Dispose()
$toolBrush.Dispose()
$decisionBrush.Dispose()
$finalBrush.Dispose()
$lightBrush.Dispose()
$accentBrush.Dispose()
$titleFont.Dispose()
$subtitleFont.Dispose()
$labelFont.Dispose()
$branchFont.Dispose()
$stepFont.Dispose()
$fontFamily.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output (Resolve-Path -LiteralPath $outputPath)
