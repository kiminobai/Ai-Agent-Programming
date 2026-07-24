# 生成 createAgent、Agent Harness 与 LangGraph 的分层关系 PNG。
# System.Drawing 负责离线绘制，不访问网络或修改其他项目资源。
Add-Type -AssemblyName System.Drawing

$width = 1600
$height = 1120
$projectRoot = if ($PSScriptRoot) {
    Split-Path -Parent $PSScriptRoot
} else {
    (Get-Location).Path
}
$outputPath = Join-Path $projectRoot "docs\agent-architecture.png"

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$background = [System.Drawing.Color]::FromArgb(246, 242, 234)
$ink = [System.Drawing.Color]::FromArgb(40, 35, 30)
$muted = [System.Drawing.Color]::FromArgb(105, 96, 87)
$accent = [System.Drawing.Color]::FromArgb(190, 72, 30)
$harnessColor = [System.Drawing.Color]::FromArgb(255, 235, 211)
$agentColor = [System.Drawing.Color]::FromArgb(222, 239, 230)
$graphColor = [System.Drawing.Color]::FromArgb(220, 231, 245)
$resourceColor = [System.Drawing.Color]::FromArgb(239, 230, 244)

$graphics.Clear($background)

$titleFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 36, [System.Drawing.FontStyle]::Bold)
$subtitleFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 16)
$headingFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 23, [System.Drawing.FontStyle]::Bold)
$bodyFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 15)
$smallFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 13)
$codeFont = New-Object System.Drawing.Font("Consolas", 15, [System.Drawing.FontStyle]::Bold)

$inkBrush = New-Object System.Drawing.SolidBrush($ink)
$mutedBrush = New-Object System.Drawing.SolidBrush($muted)
$accentBrush = New-Object System.Drawing.SolidBrush($accent)
$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(95, 80, 68), 2)
$arrowPen = New-Object System.Drawing.Pen($accent, 4)
$arrowPen.CustomEndCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap(6, 8)

function Draw-RoundedBox {
    # 统一绘制带边框的圆角容器。
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [System.Drawing.Color]$Fill,
        [float]$Radius = 24
    )

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.SolidBrush($Fill)
    $graphics.FillPath($brush, $path)
    $graphics.DrawPath($borderPen, $path)
    $brush.Dispose()
    $path.Dispose()
}

function Draw-CenteredText {
    # 在指定矩形内水平和垂直居中文本。
    param(
        [string]$Text,
        [System.Drawing.Font]$Font,
        [System.Drawing.Brush]$Brush,
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height
    )

    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString($Text, $Font, $Brush, (New-Object System.Drawing.RectangleF($X, $Y, $Width, $Height)), $format)
    $format.Dispose()
}

$graphics.DrawString("Agent 架构关系图", $titleFont, $inkBrush, 82, 48)
$graphics.DrawString("Agent Harness → createAgent → LangGraph → 模型与工具", $subtitleFont, $mutedBrush, 86, 108)

Draw-RoundedBox 70 170 1460 850 $harnessColor 34
$graphics.DrawString("Agent Harness", $headingFont, $accentBrush, 105, 197)
$graphics.DrawString("完整应用运行环境：权限、上下文、记忆、审批、追踪、UI、子 Agent", $bodyFont, $inkBrush, 105, 244)

Draw-RoundedBox 155 315 1290 270 $agentColor 28
$graphics.DrawString("createAgent", $headingFont, $inkBrush, 195, 340)
$graphics.DrawString("高层工厂：组装标准 Agent 循环，并返回一个已编译的 LangGraph", $bodyFont, $inkBrush, 195, 386)

Draw-RoundedBox 225 445 370 95 ([System.Drawing.Color]::FromArgb(248, 252, 249)) 18
Draw-CenteredText "System Prompt" $codeFont $inkBrush 225 445 370 95
Draw-RoundedBox 615 445 370 95 ([System.Drawing.Color]::FromArgb(248, 252, 249)) 18
Draw-CenteredText "Model" $codeFont $inkBrush 615 445 370 95
Draw-RoundedBox 1005 445 370 95 ([System.Drawing.Color]::FromArgb(248, 252, 249)) 18
Draw-CenteredText "Tools" $codeFont $inkBrush 1005 445 370 95

Draw-RoundedBox 155 630 1290 260 $graphColor 28
$graphics.DrawString("LangGraph", $headingFont, $inkBrush, 195, 655)
$graphics.DrawString("底层编排运行时：状态、节点、边、循环、持久化、中断与恢复", $bodyFont, $inkBrush, 195, 701)

Draw-RoundedBox 225 760 260 80 ([System.Drawing.Color]::FromArgb(249, 251, 254)) 16
Draw-CenteredText "Agent Node" $codeFont $inkBrush 225 760 260 80
Draw-RoundedBox 530 760 260 80 ([System.Drawing.Color]::FromArgb(249, 251, 254)) 16
Draw-CenteredText "Tool Node" $codeFont $inkBrush 530 760 260 80
Draw-RoundedBox 835 760 260 80 ([System.Drawing.Color]::FromArgb(249, 251, 254)) 16
Draw-CenteredText "State" $codeFont $inkBrush 835 760 260 80
Draw-RoundedBox 1140 760 235 80 ([System.Drawing.Color]::FromArgb(249, 251, 254)) 16
Draw-CenteredText "Checkpoint" $codeFont $inkBrush 1140 760 235 80

$graphics.DrawLine($arrowPen, 800, 585, 800, 622)

Draw-RoundedBox 90 950 430 105 $resourceColor 20
Draw-CenteredText "LLM`nDeepSeek / OpenAI" $bodyFont $inkBrush 90 950 430 105
Draw-RoundedBox 585 950 430 105 $resourceColor 20
Draw-CenteredText "Tools`nWeather / Calculator / Time" $bodyFont $inkBrush 585 950 430 105
Draw-RoundedBox 1080 950 430 105 $resourceColor 20
Draw-CenteredText "External Systems`nAPI / Database / Files" $bodyFont $inkBrush 1080 950 430 105

$graphics.DrawLine($arrowPen, 430, 890, 315, 942)
$graphics.DrawLine($arrowPen, 800, 890, 800, 942)
$graphics.DrawLine($arrowPen, 1170, 890, 1295, 942)

$graphics.DrawString("包含", $smallFont, $accentBrush, 814, 595)
$graphics.DrawString("运行时调用", $smallFont, $accentBrush, 700, 915)

# 完成所有图层后一次性输出 PNG。
$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$arrowPen.Dispose()
$borderPen.Dispose()
$inkBrush.Dispose()
$mutedBrush.Dispose()
$accentBrush.Dispose()
$titleFont.Dispose()
$subtitleFont.Dispose()
$headingFont.Dispose()
$bodyFont.Dispose()
$smallFont.Dispose()
$codeFont.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Generated: $outputPath"
