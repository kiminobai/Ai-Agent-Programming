import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";

export interface StructuredSection {
  heading: string;
  paragraphs: string[];
  bullets: string[];
}

export async function generatePdfBuffer(input: {
  title: string;
  sections: StructuredSection[];
}): Promise<Buffer> {
  const document = new PDFDocument({
    size: "A4",
    margins: { top: 54, right: 54, bottom: 54, left: 54 },
    info: { Title: input.title }
  });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });

  const fontPath = findPdfFont();
  if (fontPath) {
    document.font(fontPath);
  }
  document.fontSize(24).fillColor("#172033").text(input.title, {
    align: "center"
  });
  document.moveDown(1.4);
  for (const section of input.sections) {
    document.fontSize(16).fillColor("#172033").text(section.heading);
    document.moveDown(0.45);
    for (const paragraph of section.paragraphs) {
      document.fontSize(11).fillColor("#303642").text(paragraph, {
        lineGap: 4
      });
      document.moveDown(0.55);
    }
    for (const bullet of section.bullets) {
      document.fontSize(11).fillColor("#303642").text(`• ${bullet}`, {
        indent: 14,
        lineGap: 3
      });
    }
    document.moveDown(0.9);
  }
  document.end();
  return completed;
}

export async function generateWordBuffer(input: {
  title: string;
  sections: StructuredSection[];
}): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      text: input.title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 320 }
    })
  ];
  for (const section of input.sections) {
    children.push(
      new Paragraph({
        text: section.heading,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 220, after: 120 }
      })
    );
    children.push(
      ...section.paragraphs.map(
        (paragraph) =>
          new Paragraph({
            children: [new TextRun(paragraph)],
            spacing: { after: 120 }
          })
      )
    );
    children.push(
      ...section.bullets.map(
        (bullet) =>
          new Paragraph({
            text: bullet,
            bullet: { level: 0 },
            spacing: { after: 80 }
          })
      )
    );
  }
  return Packer.toBuffer(
    new Document({
      sections: [{ properties: {}, children }]
    })
  );
}

export async function generateExcelBuffer(input: {
  sheets: Array<{
    name: string;
    headers: string[];
    rows: Array<Array<string | number | boolean | null>>;
  }>;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KimiBai";
  for (const sheetInput of input.sheets) {
    const sheet = workbook.addWorksheet(sheetInput.name.slice(0, 31));
    sheet.addRow(sheetInput.headers);
    sheet.addRows(sheetInput.rows);
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF08795D" }
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns.forEach((column) => {
      let width = 12;
      column.eachCell?.({ includeEmpty: false }, (cell) => {
        width = Math.min(42, Math.max(width, String(cell.value ?? "").length + 3));
      });
      column.width = width;
    });
  }
  const result = await workbook.xlsx.writeBuffer();
  return Buffer.from(result);
}

export async function generatePowerPointBuffer(input: {
  title: string;
  slides: Array<{
    title: string;
    body: string;
    bullets: string[];
  }>;
}): Promise<Buffer> {
  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "KimiBai";
  presentation.subject = input.title;
  presentation.title = input.title;
  presentation.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei"
  };

  for (const [index, slideInput] of input.slides.entries()) {
    const slide = presentation.addSlide();
    slide.background = { color: "F7F8FA" };
    slide.addShape(presentation.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 0.16,
      h: 7.5,
      fill: { color: index === 0 ? "08795D" : "12A37F" },
      line: { color: index === 0 ? "08795D" : "12A37F" }
    });
    slide.addText(slideInput.title, {
      x: 0.72,
      y: 0.55,
      w: 11.8,
      h: 0.65,
      fontFace: "Microsoft YaHei",
      fontSize: 25,
      bold: true,
      color: "172033",
      margin: 0
    });
    if (slideInput.body) {
      slide.addText(slideInput.body, {
        x: 0.78,
        y: 1.55,
        w: 11.2,
        h: 1.15,
        fontFace: "Microsoft YaHei",
        fontSize: 15,
        color: "3B4350",
        breakLine: false,
        valign: "top",
        margin: 0.04
      });
    }
    if (slideInput.bullets.length) {
      slide.addText(
        slideInput.bullets.map((text) => ({
          text,
          options: { bullet: { indent: 18 }, breakLine: true }
        })),
        {
          x: 0.9,
          y: slideInput.body ? 2.75 : 1.55,
          w: 10.9,
          h: 3.9,
          fontFace: "Microsoft YaHei",
          fontSize: 18,
          color: "242A34",
          breakLine: false,
          paraSpaceAfter: 14,
          valign: "top",
          margin: 0.04
        }
      );
    }
    slide.addText(`${index + 1} / ${input.slides.length}`, {
      x: 11.3,
      y: 7.05,
      w: 1.25,
      h: 0.22,
      fontSize: 9,
      color: "8A9099",
      align: "right",
      margin: 0
    });
  }
  const result = await presentation.write({ outputType: "nodebuffer" });
  return Buffer.from(result as Buffer);
}

function findPdfFont(): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Windows\\Fonts\\simhei.ttf",
          "C:\\Windows\\Fonts\\msyh.ttc",
          "C:\\Windows\\Fonts\\simsun.ttc"
        ]
      : process.platform === "darwin"
        ? [
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc"
          ]
        : [
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
          ];
  return candidates.find((candidate) => fs.existsSync(path.resolve(candidate)));
}
