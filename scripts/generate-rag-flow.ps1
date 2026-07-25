Add-Type -AssemblyName System.Drawing

$scriptDirectory = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path (Get-Location) "scripts" }
$outputPath = [System.IO.Path]::GetFullPath((Join-Path $scriptDirectory "..\docs\rag-flow.png"))
$width = 1800
$height = 1320

$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$bitmap.SetResolution(144, 144)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$background = [System.Drawing.ColorTranslator]::FromHtml("#F6F1EA")
$panelFill = [System.Drawing.ColorTranslator]::FromHtml("#FFF9F2")
$indexFill = [System.Drawing.ColorTranslator]::FromHtml("#F5E5D2")
$onlineFill = [System.Drawing.ColorTranslator]::FromHtml("#EAF4EE")
$feedbackFill = [System.Drawing.ColorTranslator]::FromHtml("#E9F0FA")
$accent = [System.Drawing.ColorTranslator]::FromHtml("#B65A24")
$border = [System.Drawing.ColorTranslator]::FromHtml("#5B4335")
$ink = [System.Drawing.ColorTranslator]::FromHtml("#2E241D")
$muted = [System.Drawing.ColorTranslator]::FromHtml("#6E5A4D")
$line = [System.Drawing.ColorTranslator]::FromHtml("#D7C8BA")
$white = [System.Drawing.ColorTranslator]::FromHtml("#FFFDF9")

$graphics.Clear($background)

$fontFamily = [System.Drawing.FontFamily]::new("Microsoft YaHei UI")
$titleFont = [System.Drawing.Font]::new($fontFamily, 30, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$subtitleFont = [System.Drawing.Font]::new($fontFamily, 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$sectionFont = [System.Drawing.Font]::new($fontFamily, 22, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$nodeFont = [System.Drawing.Font]::new($fontFamily, 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$smallFont = [System.Drawing.Font]::new($fontFamily, 13, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$inkBrush = [System.Drawing.SolidBrush]::new($ink)
$mutedBrush = [System.Drawing.SolidBrush]::new($muted)
$panelBrush = [System.Drawing.SolidBrush]::new($panelFill)
$indexBrush = [System.Drawing.SolidBrush]::new($indexFill)
$onlineBrush = [System.Drawing.SolidBrush]::new($onlineFill)
$feedbackBrush = [System.Drawing.SolidBrush]::new($feedbackFill)
$whiteBrush = [System.Drawing.SolidBrush]::new($white)
$accentBrush = [System.Drawing.SolidBrush]::new($accent)

$borderPen = [System.Drawing.Pen]::new($border, 2.2)
$linePen = [System.Drawing.Pen]::new($muted, 2.8)
$accentPen = [System.Drawing.Pen]::new($accent, 3.2)
$dividerPen = [System.Drawing.Pen]::new($line, 1.4)
$linePen.CustomEndCap = [System.Drawing.Drawing2D.AdjustableArrowCap]::new(6, 8, $true)
$accentPen.CustomEndCap = [System.Drawing.Drawing2D.AdjustableArrowCap]::new(6, 8, $true)

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

function Draw-RoundedPanel {
    param(
        [float] $X,
        [float] $Y,
        [float] $Width,
        [float] $Height,
        [System.Drawing.Brush] $Fill
    )

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
    $graphics.DrawString($Text, $nodeFont, $inkBrush, [System.Drawing.RectangleF]::new($X, $Y, $Width, $Height), $centerFormat)
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
    param(
        [string] $Text,
        [float] $X,
        [float] $Y
    )

    $size = $graphics.MeasureString($Text, $smallFont)
    $graphics.FillRectangle($panelBrush, $X - 4, $Y - 2, $size.Width + 8, $size.Height + 4)
    $graphics.DrawString($Text, $smallFont, $accentBrush, $X, $Y)
}

$graphics.DrawString("RAG 完整流程图", $titleFont, $inkBrush, 72, 38)
$graphics.DrawString("离线索引构建、在线检索生成、反馈优化与记忆回流", $subtitleFont, $mutedBrush, 74, 82)
$graphics.DrawLine($dividerPen, 70, 112, 1730, 112)

Draw-RoundedPanel 60 150 500 1070 $indexBrush
Draw-RoundedPanel 650 150 520 1070 $onlineBrush
Draw-RoundedPanel 1260 150 480 1070 $feedbackBrush

$graphics.DrawString("离线知识准备 / Indexing", $sectionFont, $inkBrush, 92, 182)
$graphics.DrawString("在线问答 / Retrieval + Generation", $sectionFont, $inkBrush, 682, 182)
$graphics.DrawString("反馈优化 / Feedback Loop", $sectionFont, $inkBrush, 1292, 182)

$indexX = 110
$indexW = 400
$indexH = 78
$indexYs = @(250, 355, 460, 565, 670, 775, 880)
$indexTexts = @(
    "原始数据源`nPDF / Web / DB / API / Markdown",
    "文档采集与导入`nLoaders / ETL",
    "文本解析与清洗`n去噪 / 去重 / 结构化",
    "切分 Chunking`n字数 / 段落 / 语义切分",
    "元数据补充`n标题 / 来源 / 时间 / 标签 / 权限",
    "向量化 Embedding",
    "索引存储`nVector DB / BM25 / Hybrid"
)

for ($i = 0; $i -lt $indexTexts.Length; $i++) {
    Draw-Node $indexX $indexYs[$i] $indexW $indexH $indexTexts[$i]
    if ($i -lt $indexTexts.Length - 1) {
        Draw-Arrow $linePen @(
            [System.Drawing.PointF]::new($indexX + ($indexW / 2), $indexYs[$i] + $indexH),
            [System.Drawing.PointF]::new($indexX + ($indexW / 2), $indexYs[$i + 1])
        )
    }
}

$onlineX = 705
$onlineW = 410
$onlineH = 72
$onlineYs = @(250, 340, 430, 520, 610, 700, 790, 880, 970, 1060)
$onlineTexts = @(
    "用户问题",
    "读取上下文`n短期记忆 / 长期记忆 / 用户偏好",
    "查询理解与改写`n意图识别 / Query Rewrite",
    "查询向量化",
    "检索器 Retriever`n向量 / 关键词 / 混合检索",
    "候选结果过滤`n权限 / 时间 / 去重",
    "重排 Rerank`n相关性重新排序",
    "上下文组装`nTop-K Chunk + Metadata + History",
    "Prompt 构建`nSystem + Context + User Query",
    "LLM 生成答案并附引用"
)

for ($i = 0; $i -lt $onlineTexts.Length; $i++) {
    Draw-Node $onlineX $onlineYs[$i] $onlineW $onlineH $onlineTexts[$i]
    if ($i -lt $onlineTexts.Length - 1) {
        Draw-Arrow $linePen @(
            [System.Drawing.PointF]::new($onlineX + ($onlineW / 2), $onlineYs[$i] + $onlineH),
            [System.Drawing.PointF]::new($onlineX + ($onlineW / 2), $onlineYs[$i + 1])
        )
    }
}

$feedbackX = 1310
$feedbackW = 380
$feedbackH = 86
$feedbackYs = @(300, 435, 570, 705, 840, 975)
$feedbackTexts = @(
    "用户反馈`n有帮助 / 无帮助 / 继续追问",
    "日志与观测`nQuery / Recall / Latency / Trace",
    "召回质量评估`n命中率 / 覆盖率 / Top-K 质量",
    "Prompt 优化`nRole / Prompt / Output Contract",
    "知识库更新`n新增文档 / 重新切分 / 重建索引",
    "记忆写入`n偏好 / 事实 / 任务状态"
)

for ($i = 0; $i -lt $feedbackTexts.Length; $i++) {
    Draw-Node $feedbackX $feedbackYs[$i] $feedbackW $feedbackH $feedbackTexts[$i]
    if ($i -lt $feedbackTexts.Length - 1) {
        Draw-Arrow $linePen @(
            [System.Drawing.PointF]::new($feedbackX + ($feedbackW / 2), $feedbackYs[$i] + $feedbackH),
            [System.Drawing.PointF]::new($feedbackX + ($feedbackW / 2), $feedbackYs[$i + 1])
        )
    }
}

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(510, 919),
    [System.Drawing.PointF]::new(600, 919),
    [System.Drawing.PointF]::new(600, 646),
    [System.Drawing.PointF]::new(705, 646)
)
Draw-Label "索引供在线检索使用" 525 935

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1115, 1096),
    [System.Drawing.PointF]::new(1210, 1096),
    [System.Drawing.PointF]::new(1210, 343),
    [System.Drawing.PointF]::new(1310, 343)
)
Draw-Label "答案进入反馈与观测" 1160 1112

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1500, 926),
    [System.Drawing.PointF]::new(1500, 1190),
    [System.Drawing.PointF]::new(310, 1190),
    [System.Drawing.PointF]::new(310, 328)
)
Draw-Label "知识更新后回流到索引构建" 1060 1162

Draw-Arrow $accentPen @(
    [System.Drawing.PointF]::new(1310, 1018),
    [System.Drawing.PointF]::new(1215, 1018),
    [System.Drawing.PointF]::new(1215, 376),
    [System.Drawing.PointF]::new(1115, 376)
)
Draw-Label "记忆回写影响后续对话" 1150 392

$legendY = 1245
$graphics.FillRectangle($indexBrush, 100, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 100, $legendY, 26, 16)
$graphics.DrawString("离线索引阶段", $smallFont, $inkBrush, 136, $legendY - 1)
$graphics.FillRectangle($onlineBrush, 420, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 420, $legendY, 26, 16)
$graphics.DrawString("在线检索与生成", $smallFont, $inkBrush, 456, $legendY - 1)
$graphics.FillRectangle($feedbackBrush, 820, $legendY, 26, 16)
$graphics.DrawRectangle($borderPen, 820, $legendY, 26, 16)
$graphics.DrawString("反馈优化与记忆", $smallFont, $inkBrush, 856, $legendY - 1)

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
$indexBrush.Dispose()
$onlineBrush.Dispose()
$feedbackBrush.Dispose()
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
