import ExcelJS from "exceljs";
import mammoth from "mammoth";

export async function extractTextFromDocx(fileBuffer: Buffer): Promise<string> {
  // 学习点：Word 文档先提取成纯文本，后面才能统一进入 chunk / embedding 流程。
  const result = await mammoth.extractRawText({ buffer: fileBuffer });
  return result.value || "";
}

export async function extractTextFromSpreadsheet(
  fileBuffer: Buffer
): Promise<string> {
  // 学习点：Excel/CSV 的表格结构会被转成“文本行”。
  // 这样模型虽然看不到真正的表格 UI，但可以检索到单元格里的内容。
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as unknown as ExcelJS.Buffer);
  const sheets = workbook.worksheets.map((sheet) => {
    const renderedRows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let index = 1; index <= row.cellCount; index += 1) {
        cells.push(renderSpreadsheetCell(row.getCell(index).value));
      }
      // 学习点：用竖线连接单元格，保留“这一行有哪些列”的感觉。
      renderedRows.push(cells.join(" | "));
    });
    return [`[Sheet: ${sheet.name}]`, ...renderedRows].join("\n");
  });

  return sheets.join("\n\n");
}

function renderSpreadsheetCell(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "object") {
    return String(value).trim();
  }
  if ("result" in value) {
    return renderSpreadsheetCell(value.result ?? value.formula);
  }
  if ("richText" in value) {
    return value.richText.map((part) => part.text).join("").trim();
  }
  if ("text" in value) {
    return String(value.text).trim();
  }
  return JSON.stringify(value);
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
