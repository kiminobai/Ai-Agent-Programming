import path from "path";
import { tool } from "langchain";
import { z } from "zod";
import type { AgentContext } from "../../agents/agentContext";
import { executeDurableTask } from "../../agents/durableTaskExecution";
import { createGeneratedBinaryFile } from "../../files/generatedFileStore";
import {
  generateExcelBuffer,
  generatePdfBuffer,
  generatePowerPointBuffer,
  generateWordBuffer
} from "../../files/officeFileGenerators";
import type { ToolMemoryRuntime } from "../../agents/toolMemoryState";

const sectionSchema = z.object({
  heading: z.string().min(1).max(160),
  paragraphs: z.array(z.string().max(8_000)).max(30).default([]),
  bullets: z.array(z.string().max(1_000)).max(40).default([])
});

const documentSchema = z.object({
  fileName: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  sections: z.array(sectionSchema).min(1).max(40)
});

function withExtension(fileName: string, extension: string): string {
  return path.extname(fileName).toLowerCase() === extension
    ? fileName
    : `${path.basename(fileName, path.extname(fileName))}${extension}`;
}

async function persistOfficeFile(
  runtime: ToolMemoryRuntime,
  operationName: string,
  input: Record<string, unknown>,
  fileName: string,
  mimeType: string,
  buildBuffer: () => Promise<Buffer>
) {
  const context = runtime.context as AgentContext;
  const durable = await executeDurableTask(
    runtime,
    operationName,
    input,
    async () =>
      createGeneratedBinaryFile({
        threadId: context.threadId,
        userId: context.userId,
        turnId: context.turnId,
        fileName,
        mimeType,
        buffer: await buildBuffer()
      })
  );
  return JSON.stringify({
    ok: true,
    fileId: durable.result.fileId,
    fileName: durable.result.fileName,
    fileSize: durable.result.fileSize,
    replayed: durable.replayed
  });
}

export const generatePdfFileTool = tool(
  async (input, runtime: ToolMemoryRuntime) =>
    persistOfficeFile(
      runtime,
      "generate_pdf_file",
      input,
      withExtension(input.fileName, ".pdf"),
      "application/pdf",
      () => generatePdfBuffer(input)
    ),
  {
    name: "generate_pdf_file",
    description:
      "Generate a real downloadable PDF in Chat mode from structured sections. Use when the user explicitly requests PDF.",
    schema: documentSchema
  }
);

export const generateWordDocumentTool = tool(
  async (input, runtime: ToolMemoryRuntime) =>
    persistOfficeFile(
      runtime,
      "generate_word_document",
      input,
      withExtension(input.fileName, ".docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      () => generateWordBuffer(input)
    ),
  {
    name: "generate_word_document",
    description:
      "Generate a real downloadable Word DOCX document in Chat mode from structured headings, paragraphs and bullet lists.",
    schema: documentSchema
  }
);

const spreadsheetCellSchema = z.union([
  z.string().max(8_000),
  z.number(),
  z.boolean(),
  z.null()
]);

export const generateExcelWorkbookTool = tool(
  async (input, runtime: ToolMemoryRuntime) =>
    persistOfficeFile(
      runtime,
      "generate_excel_workbook",
      input,
      withExtension(input.fileName, ".xlsx"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      () => generateExcelBuffer(input)
    ),
  {
    name: "generate_excel_workbook",
    description:
      "Generate a real downloadable Excel XLSX workbook in Chat mode. Use sheets with headers and tabular rows.",
    schema: z.object({
      fileName: z.string().min(1).max(120),
      sheets: z
        .array(
          z.object({
            name: z.string().min(1).max(31),
            headers: z.array(z.string().max(200)).min(1).max(80),
            rows: z
              .array(z.array(spreadsheetCellSchema).max(80))
              .max(5_000)
          })
        )
        .min(1)
        .max(20)
    })
  }
);

export const generatePresentationTool = tool(
  async (input, runtime: ToolMemoryRuntime) =>
    persistOfficeFile(
      runtime,
      "generate_presentation",
      input,
      withExtension(input.fileName, ".pptx"),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      () => generatePowerPointBuffer(input)
    ),
  {
    name: "generate_presentation",
    description:
      "Generate a real downloadable PowerPoint PPTX presentation in Chat mode. Each slide has a title, optional body and bullet list.",
    schema: z.object({
      fileName: z.string().min(1).max(120),
      title: z.string().min(1).max(200),
      slides: z
        .array(
          z.object({
            title: z.string().min(1).max(180),
            body: z.string().max(4_000).default(""),
            bullets: z.array(z.string().max(1_000)).max(20).default([])
          })
        )
        .min(1)
        .max(40)
    })
  }
);
