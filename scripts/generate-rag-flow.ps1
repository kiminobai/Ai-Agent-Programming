Add-Type -AssemblyName System.Drawing

$scriptDirectory = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path (Get-Location) "scripts" }
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory "..\docs\rag-flow.png"))
$width = 1900
$height = 1380

$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$bitmap.SetResolution(144, 144)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$background = [System.Drawing.ColorTranslator]::FromHtml("#F7F2EA")
$panelFill = [System.Drawing.ColorTranslator]::FromHtml("#FFF9F0")
$sourceFill = [System.Drawing.ColorTranslator]::FromHtml("#F4E3CD")
$routeFill = [System.Drawing.ColorTranslator]::FromHtml("#EAF0FA")
$twoStepFill = [System.Drawing.ColorTranslator]::FromHtml("#E9F4EC")
$agenticFill = [System.Drawing.ColorTranslator]::FromHtml("#F4E8F6")
$hybridFill = [System.Drawing.ColorTranslator]::FromHtml("#F6E8EA")
$answerFill = [System.Drawing.ColorTranslator]::FromHtml("#FFF3D8")
$accent = [System.Drawing.ColorTranslator]::FromHtml("#B85B24")
$border = [System.Drawing.ColorTranslator]::FromHtml("#4F4036")
$ink = [System.Drawing.ColorTranslator]::FromHtml("#2A221D")
$muted = [System.Drawing.ColorTranslator]::FromHtml("#6A584B")
$line = [System.Drawing.ColorTranslator]::FromHtml("#D9CAB8")
$white = [System.Drawing.ColorTranslator]::FromHtml("#FFFDF8")

$graphics.Clear($background)

$fontFamily = [System.Drawing.FontFamily]::new("Microsoft YaHei UI")
$titleFont = [System.Drawing.Font]::new($fontFamily, 32, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subtitleFont = [System.Drawing.Font]::new($fontFamily, 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$sectionFont = [System.Drawing.Font]::new($fontFamily, 21, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$nodeFont = [System.Drawing.Font]::new($fontFamily, 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$smallFont = [System.Drawing.Font]::new($fontFamily, 12, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$inkBrush = [System.Drawing.SolidBrush]::new($ink)
$mutedBrush = [System.Drawing.SolidBrush]::new($muted)
$panelBrush = [System.Drawing.SolidBrush]::new($panelFill)
$sourceBrush = [System.Drawing.SolidBrush]::new($sourceFill)
$routeBrush = [System.Drawing.SolidBrush]::new($routeFill)
$twoStepBrush = [System.Drawing.SolidBrush]::new($twoStepFill)
$agenticBrush = [System.Drawing.SolidBrush]::new($agenticFill)
$hybridBrush = [System.Drawing.SolidBrush]::new($hybridFill)
$answerBrush = [System.Drawing.SolidBrush]::new($answerFill)
$whiteBrush = [System.Drawing.SolidBrush]::new($white)
$accentBrush = [System.Drawing.SolidBrush]::new($accent)

$borderPen = [System.Drawing.Pen]::new($border, 2.1)
$linePen = [System.Drawing.Pen]::new($muted, 2.5)
$accentPen = [System.Drawing.Pen]::new($accent, 3.0)
$dividerPen = [System.Drawing.Pen]::new($line, 1.3)
$linePen.CustomEndCap = [System.Drawing.Drawing2D.AdjustableArrowCap]::new(6, 8, $true)
$accentPen.CustomEndCap = [System.Drawing.Drawing2D.AdjustableArrowCap]::new(6, 8, $true)

$centerFormat = [System.Drawing.StringFormat]::new()
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
$centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center

function New-RoundedPath {
    param([float] $X, [float] $Y, [float] $Width, [float] $Height, [float] $Radius)

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-RoundedPanel {
    param([float] $X, [float] $Y, [float] $Width, [float] $Height, [System.Drawing.Brush] $Fill)

    $path = New-RoundedPath $X $Y $Width $Height 28
    $graphics.FillPath($Fill, $path)
    $graphics.DrawPath($borderPen, $path)
    $path.Dispose()
}

function Draw-Node {
    param(
        [float] $X,
        [float] $Y,
        [float] $Width,
        [float] $Height,
        [string] $Text,
        [System.Drawing.Brush] $Fill = $whiteBrush
    )

    $path = New-RoundedPath $X $Y $Width $Height 18
    $graphics.FillPath($Fill, $path)
    $graphics.DrawPath($borderPen, $path)
    $graphics.DrawString($Text, $nodeFont, $inkBrush, [System.Drawing.RectangleF]::new($X + 8, $Y, $Width - 16, $Height), $centerFormat)
    $path.Dispose()
}

function Draw-Arrow {
    param([System.Drawing.Pen] $Pen, [System.Drawing.PointF[]] $Points)

    if ($Points.Length -eq 2) {
        $graphics.DrawLine($Pen, $Points[0], $Points[1])
        return
    }

    $graphics.DrawLines($Pen, $Points)
}

function Draw-Label {
    param([string] $Text, [float] $X, [float] $Y)

    $size = $graphics.MeasureString($Text, $smallFont)
    $graphics.FillRectangle($panelBrush, $X - 4, $Y - 2, $size.Width + 8, $size.Height + 4)
    $graphics.DrawString($Text, $smallFont, $accentBrush, $X, $Y)
}

$graphics.DrawString("当前项目 RAG 实际流程图", $titleFont, $inkBrush, 72, 38)
$graphics.DrawString("三种 RAG architecture 是路由后的并列分支：默认 2-step；复杂任务 Agentic；全文/知识库/多文档 Hybrid", $subtitleFont, $mutedBrush, 74, 84)
$graphics.DrawLine($dividerPen, 70, 116, 1830, 116)

Draw-RoundedPanel 60 150 410 1110 $sourceBrush
Draw-RoundedPanel 520 150 420 1110 $routeBrush
Draw-RoundedPanel 990 150 410 1110 $panelBrush
Draw-RoundedPanel 1450 150 390 1110 $answerBrush

$graphics.DrawString("资料进入系统", $sectionFont, $inkBrush, 94, 184)
$graphics.DrawString("问题与路由", $sectionFont, $inkBrush, 554, 184)
$graphics.DrawString("并列 RAG 分支", $sectionFont, $inkBrush, 1024, 184)
$graphics.DrawString("回答与保存", $sectionFont, $inkBrush, 1484, 184)

$sourceX = 100
$sourceW = 330
$sourceH = 72
$sourceYs = @(250, 350, 450, 550, 650, 750, 850)
$sourceTexts = @(
    "资料来源`n1 上传文件  2 知识库目录",
    "保存原文件`ndata/uploads 或 data/knowledge-bases",
    "解析文本`nPDF / MD / DOCX / PPTX / XLSX / 图片文字",
    "文本清洗`n统一换行 / 去空白 / 保留结构",
    "Chunk 切分`n后端固定配置，不暴露给用户",
    "文档 Embedding`n每个 chunk -> 向量",
    "索引持久化`nChroma 向量 + SQLite 元数据/FTS5"
)

for ($i = 0; $i -lt $sourceTexts.Length; $i++) {
    Draw-Node $sourceX $sourceYs[$i] $sourceW $sourceH $sourceTexts[$i]
    if ($i -lt $sourceTexts.Length - 1) {
        Draw-Arrow $linePen @(
            [System.Drawing.PointF]::new($sourceX + ($sourceW / 2), $sourceYs[$i] + $sourceH),
            [System.Drawing.PointF]::new($sourceX + ($sourceW / 2), $sourceYs[$i + 1])
        )
    }
}

$routeX = 560
$routeW = 340
$routeH = 72
$routeYs = @(250, 350, 450, 550, 650, 750, 850)
$routeTexts = @(
    "用户提问`n输入框文字 + 可选附件",
    "选择资料范围 sourceScope`nuploaded-document / knowledge-base / multi-document",
    "关键词路由`n生成/对比/继续 -> Agentic`n总结/全文/目录 -> Hybrid",
    "问题 Embedding`n关键词不明确时做语义兜底",
    "语义匹配样例`n更像 Agentic 或 Hybrid",
    "默认策略`n不明确则 2-step RAG",
    "输出决策`narchitecture + sourceScope + reason"
)

for ($i = 0; $i -lt $routeTexts.Length; $i++) {
    Draw-Node $routeX $routeYs[$i] $routeW $routeH $routeTexts[$i]
    if ($i -lt $routeTexts.Length - 1) {
        Draw-Arrow $linePen @(
            [System.Drawing.PointF]::new($routeX + ($routeW / 2), $routeYs[$i] + $routeH),
            [System.Drawing.PointF]::new($routeX + ($routeW / 2), $routeYs[$i + 1])
        )
    }
}

$archX = 1030
$archW = 330
Draw-Node $archX 245 $archW 115 "2-step RAG（默认）`n问题 embedding`n向量检索 TopK`n直接组装 Prompt 生成" $twoStepBrush
Draw-Node $archX 460 $archW 135 "Agentic RAG`n进入 LangChain Agent`nAgent 决定是否调用文档工具`n工具内部复用 Hybrid 检索`n生成/对比/改写/多步骤" $agenticBrush
Draw-Node $archX 715 $archW 155 "Hybrid RAG`nQuery Enhancement`nVector Search + FTS5/BM25`nScore Fusion + Rerank`nRetrieval Validation`n全文/知识库/多文档" $hybridBrush

$answerX = 1490
$answerW = 310
$answerH = 76
$answerYs = @(260, 370, 480, 590, 700, 810, 920)
$answerTexts = @(
    "组装 Prompt`nSystem + 检索上下文 + Question",
    "调用 LLM`nDeepSeek / OpenAI 兼容模型",
    "2-step`n直接返回生成结果",
    "Hybrid`n再做 Answer Validation",
    "Agentic`nAgent 汇总工具结果后回答",
    "保存记录`nSQLite 对话/附件/QA 历史",
    "返回用户`n隐藏 chunk id / 分数 / Chroma 细节"
)

for ($i = 0; $i -lt $answerTexts.Length; $i++) {
    Draw-Node $answerX $answerYs[$i] $answerW $answerH $answerTexts[$i]
    if ($i -lt $answerTexts.Length - 1) {
        Draw-Arrow $linePen @(
            [System.Drawing.PointF]::new($answerX + ($answerW / 2), $answerYs[$i] + $answerH),
            [System.Drawing.PointF]::new($answerX + ($answerW / 2), $answerYs[$i + 1])
        )
    }
}

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(430, 886),
    [System.Drawing.PointF]::new(500, 886),
    [System.Drawing.PointF]::new(500, 286),
    [System.Drawing.PointF]::new(560, 286)
)
Draw-Label "附件上传后按用户命令进入 QA；知识库可预先索引" 420 904

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(900, 886),
    [System.Drawing.PointF]::new(960, 886),
    [System.Drawing.PointF]::new(960, 293),
    [System.Drawing.PointF]::new(1030, 293)
)
Draw-Label "默认：2-step RAG" 900 905

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(900, 486),
    [System.Drawing.PointF]::new(960, 486),
    [System.Drawing.PointF]::new(960, 528),
    [System.Drawing.PointF]::new(1030, 528)
)
Draw-Label "多步骤/生成/对比：Agentic" 862 505

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(900, 586),
    [System.Drawing.PointF]::new(960, 586),
    [System.Drawing.PointF]::new(960, 792),
    [System.Drawing.PointF]::new(1030, 792)
)
Draw-Label "全文/宽范围/知识库：Hybrid" 858 604

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1360, 302),
    [System.Drawing.PointF]::new(1425, 302),
    [System.Drawing.PointF]::new(1425, 298),
    [System.Drawing.PointF]::new(1490, 298)
)
Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1360, 528),
    [System.Drawing.PointF]::new(1425, 528),
    [System.Drawing.PointF]::new(1425, 298),
    [System.Drawing.PointF]::new(1490, 298)
)
Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1360, 792),
    [System.Drawing.PointF]::new(1425, 792),
    [System.Drawing.PointF]::new(1425, 298),
    [System.Drawing.PointF]::new(1490, 298)
)
Draw-Label "三个分支最终都进入回答链路" 1348 965

$noteY = 1160
Draw-Node 105 $noteY 440 70 "Embedding 两处使用：`n1 chunk 检索  2 路由语义判断" $whiteBrush
Draw-Node 610 $noteY 440 70 "sourceScope 不是架构：`n只表示上传文档 / 知识库 / 多文档" $whiteBrush
Draw-Node 1115 $noteY 440 70 "三种架构是并列选择：`n2-step / Agentic / Hybrid" $whiteBrush

$legendY = 1295
$graphics.FillRectangle($sourceBrush, 100, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 100, $legendY, 26, 16)
$graphics.DrawString("资料索引", $smallFont, $inkBrush, 136, $legendY - 1)
$graphics.FillRectangle($routeBrush, 360, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 360, $legendY, 26, 16)
$graphics.DrawString("路由判断", $smallFont, $inkBrush, 396, $legendY - 1)
$graphics.FillRectangle($twoStepBrush, 620, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 620, $legendY, 26, 16)
$graphics.DrawString("2-step", $smallFont, $inkBrush, 656, $legendY - 1)
$graphics.FillRectangle($agenticBrush, 840, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 840, $legendY, 26, 16)
$graphics.DrawString("Agentic", $smallFont, $inkBrush, 876, $legendY - 1)
$graphics.FillRectangle($hybridBrush, 1060, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 1060, $legendY, 26, 16)
$graphics.DrawString("Hybrid", $smallFont, $inkBrush, 1096, $legendY - 1)
$graphics.FillRectangle($answerBrush, 1280, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 1280, $legendY, 26, 16)
$graphics.DrawString("生成回答", $smallFont, $inkBrush, 1316, $legendY - 1)

$outputDirectory = Split-Path -Parent $outputPath
if (-not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$centerFormat.Dispose()
$borderPen.Dispose()
$linePen.Dispose()
$accentPen.Dispose()
$dividerPen.Dispose()
$inkBrush.Dispose()
$mutedBrush.Dispose()
$panelBrush.Dispose()
$sourceBrush.Dispose()
$routeBrush.Dispose()
$twoStepBrush.Dispose()
$agenticBrush.Dispose()
$hybridBrush.Dispose()
$answerBrush.Dispose()
$whiteBrush.Dispose()
$accentBrush.Dispose()
$titleFont.Dispose()
$subtitleFont.Dispose()
$sectionFont.Dispose()
$nodeFont.Dispose()
$smallFont.Dispose()
$fontFamily.Dispose()
$graphics.Dispose()
$bitmap.Dispose()

Write-Output (Resolve-Path -LiteralPath $outputPath)
