import mammoth from "mammoth";
import * as XLSX from "xlsx";

export async function extractTextFromDocx(fileBuffer: Buffer): Promise<string> {
  // 学习点：Word 文档先提取成纯文本，后面才能统一进入 chunk / embedding 流程。
  const result = await mammoth.extractRawText({ buffer: fileBuffer });
  return result.value || "";
}

export function extractTextFromSpreadsheet(fileBuffer: Buffer): string {
  // 学习点：Excel/CSV 的表格结构会被转成“文本行”。
  // 这样模型虽然看不到真正的表格 UI，但可以检索到单元格里的内容。
  const workbook = XLSX.read(fileBuffer, {
    type: "buffer",
    cellDates: true,
    dense: false
  });
  const sheets = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(
      sheet,
      {
        header: 1,
        blankrows: false,
        defval: ""
      }
    );
    const renderedRows = rows.map((row) =>
      // 学习点：用竖线连接单元格，保留“这一行有哪些列”的感觉。
      row.map((cell) => String(cell ?? "").trim()).join(" | ")
    );

    return [`[Sheet: ${sheetName}]`, ...renderedRows].join("\n");
  });

  return sheets.join("\n\n");
}

export function extractTextFromHtml(fileBuffer: Buffer): string {
  // 学习点：HTML 里 script/style 对问答没帮助，先去掉，再把标签转成普通文本。
  const html = fileBuffer.toString("utf8");
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}
