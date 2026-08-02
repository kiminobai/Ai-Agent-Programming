Add-Type -AssemblyName System.Drawing

$root = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { Get-Location }
$output = Join-Path $root "docs\langgraph-execution-flow.png"
$width = 1900
$height = 1680

$bitmap = [Drawing.Bitmap]::new($width, $height)
$bitmap.SetResolution(144, 144)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit
$graphics.Clear([Drawing.ColorTranslator]::FromHtml("#F7F4EE"))

$family = [Drawing.FontFamily]::new("Microsoft YaHei UI")
$titleFont = [Drawing.Font]::new($family, 34, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
$subtitleFont = [Drawing.Font]::new($family, 15, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
$nodeFont = [Drawing.Font]::new($family, 16, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
$bodyFont = [Drawing.Font]::new($family, 12, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
$smallFont = [Drawing.Font]::new($family, 11, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)

$ink = [Drawing.ColorTranslator]::FromHtml("#27231F")
$muted = [Drawing.ColorTranslator]::FromHtml("#6B645C")
$border = [Drawing.ColorTranslator]::FromHtml("#5B544B")
$accent = [Drawing.ColorTranslator]::FromHtml("#C6542D")
$inkBrush = [Drawing.SolidBrush]::new($ink)
$mutedBrush = [Drawing.SolidBrush]::new($muted)
$accentBrush = [Drawing.SolidBrush]::new($accent)
$borderPen = [Drawing.Pen]::new($border, 2.1)
$arrowPen = [Drawing.Pen]::new($border, 2.6)
$arrowPen.CustomEndCap = [Drawing.Drawing2D.AdjustableArrowCap]::new(6, 8, $true)
$dashPen = [Drawing.Pen]::new($muted, 1.8)
$dashPen.DashStyle = [Drawing.Drawing2D.DashStyle]::Dash
$dashPen.CustomEndCap = [Drawing.Drawing2D.AdjustableArrowCap]::new(5, 7, $true)

$center = [Drawing.StringFormat]::new()
$center.Alignment = [Drawing.StringAlignment]::Center
$center.LineAlignment = [Drawing.StringAlignment]::Center

function New-RoundedPath {
    param([float]$X, [float]$Y, [float]$W, [float]$H, [float]$R = 18)
    $diameter = $R * 2
    $path = [Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $W - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $W - $diameter, $Y + $H - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $H - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-Box {
    param(
        [float]$X, [float]$Y, [float]$W, [float]$H,
        [string]$Title, [string]$Body, [string]$Fill
    )
    $path = New-RoundedPath $X $Y $W $H
    $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($Fill))
    $graphics.FillPath($brush, $path)
    $graphics.DrawPath($borderPen, $path)
    $titleRect = [Drawing.RectangleF]::new($X + 12, $Y + 10, $W - 24, 27)
    $bodyRect = [Drawing.RectangleF]::new($X + 15, $Y + 40, $W - 30, $H - 48)
    $graphics.DrawString($Title, $nodeFont, $inkBrush, $titleRect, $center)
    $graphics.DrawString($Body, $bodyFont, $mutedBrush, $bodyRect, $center)
    $brush.Dispose()
    $path.Dispose()
}

function Draw-Diamond {
    param(
        [float]$CenterX, [float]$CenterY, [float]$W, [float]$H,
        [string]$Title, [string]$Fill
    )
    $points = [Drawing.PointF[]]@(
        [Drawing.PointF]::new($CenterX, $CenterY - $H / 2),
        [Drawing.PointF]::new($CenterX + $W / 2, $CenterY),
        [Drawing.PointF]::new($CenterX, $CenterY + $H / 2),
        [Drawing.PointF]::new($CenterX - $W / 2, $CenterY)
    )
    $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($Fill))
    $graphics.FillPolygon($brush, $points)
    $graphics.DrawPolygon($borderPen, $points)
    $rect = [Drawing.RectangleF]::new($CenterX - $W / 2 + 20, $CenterY - 25, $W - 40, 50)
    $graphics.DrawString($Title, $nodeFont, $inkBrush, $rect, $center)
    $brush.Dispose()
}

function Draw-Arrow {
    param([float]$X1, [float]$Y1, [float]$X2, [float]$Y2)
    $graphics.DrawLine($arrowPen, $X1, $Y1, $X2, $Y2)
}

function Draw-PathArrow {
    param([Drawing.PointF[]]$Points)
    $graphics.DrawLines($arrowPen, $Points)
}

function Draw-DashedArrow {
    param([float]$X1, [float]$Y1, [float]$X2, [float]$Y2)
    $graphics.DrawLine($dashPen, $X1, $Y1, $X2, $Y2)
}

function Draw-Label {
    param([float]$X, [float]$Y, [float]$W, [string]$Text)
    $rect = [Drawing.RectangleF]::new($X, $Y, $W, 25)
    $graphics.DrawString($Text, $smallFont, $mutedBrush, $rect, $center)
}

$titleRect = [Drawing.RectangleF]::new(80, 35, 1740, 55)
$subtitleRect = [Drawing.RectangleF]::new(80, 92, 1740, 34)
$graphics.DrawString("LangGraph 完整执行流程图", $titleFont, $inkBrush, $titleRect, $center)
$graphics.DrawString("从请求进入 Graph，到 State 更新、路由、暂停恢复、并行执行和最终结束", $subtitleFont, $mutedBrush, $subtitleRect, $center)

# 主流程从上到下，保证读者可以沿箭头理解一次 Graph Run。
Draw-Box 690 150 520 90 "1. 应用发起请求" "graph.invoke() 或 graph.stream()`n传入 input、thread_id 和其他 config" "#FFFDF8"
Draw-Arrow 950 240 950 285

Draw-Box 690 285 520 95 "2. LangGraph Runtime 接收 Run" "创建本次执行上下文`n初始化 Streaming、Tracing 与取消信号" "#DDEAF5"
Draw-Arrow 950 380 950 425

Draw-Diamond 950 495 400 135 "是否配置 Checkpointer？" "#F4E7C7"
Draw-Label 1080 520 110 "是"
Draw-Label 750 520 110 "否"

Draw-Box 1250 445 430 100 "读取 thread_id 对应 Checkpoint" "已有 Thread：恢复 State 与待执行任务`n新 Thread：创建初始 State" "#E1EEDC"
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(1150, 495),
    [Drawing.PointF]::new(1250, 495)
))

Draw-Box 690 600 520 82 "3. START 进入执行图" "从入口 Edge 找到第一个 Node" "#F0DDE0"
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(1450, 545),
    [Drawing.PointF]::new(1450, 565),
    [Drawing.PointF]::new(1210, 565),
    [Drawing.PointF]::new(1210, 640)
))
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(750, 495),
    [Drawing.PointF]::new(640, 495),
    [Drawing.PointF]::new(640, 640),
    [Drawing.PointF]::new(690, 640)
))
Draw-Arrow 950 682 950 725

Draw-Box 690 725 520 105 "4. 执行当前 Node" "Node 读取 State 和 Runtime Context`n执行普通代码、LLM、Tool、数据库、Subgraph 或 Agent" "#DDEAF5"

# Agent Loop 是 Node 内部可能发生的子流程，不是每个 LangGraph 都必须运行。
Draw-Box 90 710 430 220 "可选：Node 内部运行 Agent 子图" "Model 判断`n├─ 直接生成最终结果`n└─ Tool Call → Tool Result → 再次 Model`n`ncreateAgent 底层本身也是 LangGraph" "#E5DFF1"
Draw-DashedArrow 690 777 520 777

Draw-Arrow 950 830 950 875
Draw-Diamond 950 945 430 140 "Node 返回什么？" "#F4E7C7"

# 普通 State Update 路径。
Draw-Box 675 1060 550 100 "5. 合并 State Update" "Reducer 处理覆盖、追加或并行结果合并`n得到新的 State 快照" "#E1EEDC"
Draw-Arrow 950 1015 950 1060

# Interrupt 路径。
Draw-Box 1320 895 440 105 "Interrupt：暂停执行" "保存可序列化的审批或补充信息`n等待外部输入，不继续执行后续副作用" "#F0DDE0"
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(1165, 945),
    [Drawing.PointF]::new(1320, 945)
))
Draw-Box 1320 1065 440 100 "用户批准、拒绝或补充信息" "应用使用 Command({ resume: value })`n以相同 thread_id 恢复" "#FFFDF8"
Draw-Arrow 1540 1000 1540 1065
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(1320, 1115),
    [Drawing.PointF]::new(1270, 1115),
    [Drawing.PointF]::new(1270, 777),
    [Drawing.PointF]::new(1210, 777)
))
Draw-Label 1180 735 150 "恢复时重新进入 Node"

Draw-Arrow 950 1160 950 1200
Draw-Box 675 1200 550 90 "6. 保存 Checkpoint 并发送 Stream Event" "持久化 State / next / metadata`n推送 messages、updates、values 或 custom 事件" "#DDEAF5"
Draw-Arrow 950 1290 950 1325

Draw-Diamond 950 1395 440 135 "Edge / Command 路由到哪里？" "#F4E7C7"

# 左分支：继续普通 Node。
Draw-Box 90 1260 430 105 "下一个 Node / Conditional Edge" "固定跳转、条件分支或循环`n重新进入第 4 步" "#E1EEDC"
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(730, 1395),
    [Drawing.PointF]::new(520, 1395),
    [Drawing.PointF]::new(520, 1312)
))
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(305, 1260),
    [Drawing.PointF]::new(305, 980),
    [Drawing.PointF]::new(610, 980),
    [Drawing.PointF]::new(610, 777),
    [Drawing.PointF]::new(690, 777)
))

# 右分支：Send 并行 Worker，汇总后回到 State 合并。
Draw-Box 1380 1260 400 105 "Send：动态并行 Worker" "为每个任务创建输入`n并行 Node 完成后通过 Reducer 汇总" "#E5DFF1"
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(1170, 1395),
    [Drawing.PointF]::new(1380, 1395),
    [Drawing.PointF]::new(1380, 1312)
))
Draw-PathArrow ([Drawing.PointF[]]@(
    [Drawing.PointF]::new(1580, 1260),
    [Drawing.PointF]::new(1580, 1190),
    [Drawing.PointF]::new(1235, 1190),
    [Drawing.PointF]::new(1235, 1110),
    [Drawing.PointF]::new(1225, 1110)
))

# END 分支。
Draw-Box 690 1510 520 95 "7. END：Graph Run 完成" "返回最终 State 或输出`n保留 Checkpoint，供下一轮继续或 Time Travel" "#F0DDE0"
Draw-Arrow 950 1462 950 1510
Draw-Label 960 1468 80 "END"

# 持久化失败恢复说明。
Draw-Box 90 1015 430 115 "Node 失败时" "Retry Policy 重试临时错误`n仍失败则保留最后成功 Checkpoint`n下次从可恢复边界继续" "#F6E3D6"
Draw-DashedArrow 690 805 520 1055

$footerRect = [Drawing.RectangleF]::new(120, 1625, 1660, 32)
$graphics.DrawString("核心循环：Node → State Update / Reducer → Checkpoint / Stream → Edge → 下一个 Node，直到 END", $subtitleFont, $accentBrush, $footerRect, $center)

$bitmap.Save($output, [Drawing.Imaging.ImageFormat]::Png)

$inkBrush.Dispose()
$mutedBrush.Dispose()
$accentBrush.Dispose()
$borderPen.Dispose()
$arrowPen.Dispose()
$dashPen.Dispose()
$titleFont.Dispose()
$subtitleFont.Dispose()
$nodeFont.Dispose()
$bodyFont.Dispose()
$smallFont.Dispose()
$family.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output "Generated: $output"

