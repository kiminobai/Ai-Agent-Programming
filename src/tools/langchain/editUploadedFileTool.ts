import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import sharp from "sharp";
import { tool } from "langchain";
import { z } from "zod";
import { AgentContext } from "../../agents/agentContext";
import { executeDurableTask } from "../../agents/durableTaskExecution";
import {
  ToolMemoryRuntime,
  writeToolContext
} from "../../agents/toolMemoryState";
import {
  createGeneratedBinaryFile,
  listGeneratedFiles
} from "../../files/generatedFileStore";
import { resolveUploadStorageKey } from "../../rag/uploadFileStorage";
import {
  getUploadedDocument,
  getUploadedDocumentByFileId
} from "../../rag/uploadedDocumentStore";

const editOperationSchema = z.object({
  find: z.string().min(1).describe("原文件中必须存在的精确文本"),
  replace: z.string().describe("替换后的文本"),
  replaceAll: z.boolean().default(true).describe("是否替换全部匹配项")
});

const imageEditSchema = z.object({
  width: z.number().int().positive().max(12000).optional(),
  height: z.number().int().positive().max(12000).optional(),
  fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).default("inside"),
  rotate: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270)
  ]).default(0),
  flipHorizontal: z.boolean().default(false),
  flipVertical: z.boolean().default(false),
  grayscale: z.boolean().default(false),
  format: z.enum(["png", "jpeg", "webp"]).optional()
});

const editableTextExtensions = new Set([
  ".txt", ".md", ".csv", ".json", ".html", ".htm", ".xml", ".yaml", ".yml",
  ".js", ".jsx", ".ts", ".tsx", ".css", ".scss", ".py", ".java", ".go",
  ".rs", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".rb", ".sh", ".ps1",
  ".sql", ".toml", ".ini", ".env"
]);
const editableOfficeExtensions = new Set([".docx", ".xlsx", ".pptx"]);

function applyOperations(
  content: string,
  operations: Array<z.infer<typeof editOperationSchema>>
): { content: string; replacements: number } {
  let next = content;
  let replacements = 0;
  for (const operation of operations) {
    if (!next.includes(operation.find)) {
      throw new Error(`原文件中未找到要修改的内容：${operation.find.slice(0, 80)}`);
    }
    if (operation.replaceAll) {
      const parts = next.split(operation.find);
      replacements += parts.length - 1;
      next = parts.join(operation.replace);
    } else {
      replacements += 1;
      next = next.replace(operation.find, operation.replace);
    }
  }
  return { content: next, replacements };
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function editOfficeArchive(
  source: Buffer,
  extension: string,
  operations: Array<z.infer<typeof editOperationSchema>>
): Promise<{ buffer: Buffer; replacements: number }> {
  const zip = await JSZip.loadAsync(source);
  const candidatePattern =
    extension === ".docx"
      ? /^word\/.*\.xml$/
      : extension === ".xlsx"
        ? /^xl\/.*\.xml$/
        : /^ppt\/.*\.xml$/;
  let replacements = 0;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !candidatePattern.test(entryName)) {
      continue;
    }
    let xml = await entry.async("string");
    let changed = false;
    for (const operation of operations) {
      const find = escapeXmlText(operation.find);
      if (!xml.includes(find)) {
        continue;
      }
      const result = applyOperations(xml, [{
        ...operation,
        find,
        replace: escapeXmlText(operation.replace)
      }]);
      xml = result.content;
      replacements += result.replacements;
      changed = true;
    }
    if (changed) {
      zip.file(entryName, xml);
    }
  }

  if (replacements === 0) {
    throw new Error(
      "没有在原文件结构中找到可安全替换的完整文本。文字可能被拆成多个格式片段，请改用重新生成新版。"
    );
  }
  return {
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
    replacements
  };
}

export const editUploadedFileTool = tool(
  async (
    { sourceFileId, outputFileName, operations, imageEdit },
    runtime: ToolMemoryRuntime
  ) => {
    const context = (runtime.context ?? {}) as AgentContext;
    const source = sourceFileId
      ? getUploadedDocumentByFileId(sourceFileId, context.userId)
      : getUploadedDocument(context.threadId);
    if (!source || source.threadId !== context.threadId) {
      throw new Error("当前对话中没有找到要修改的原文件，请先上传或重新选择文件。");
    }

    const extension = path.extname(source.originalName).toLowerCase();
    if (extension === ".pdf") {
      throw new Error(
        "当前修改方式无法安全改写 PDF 并保留原布局。请明确要求基于内容重新生成新版。"
      );
    }
    if (source.fileType === "image" && !imageEdit) {
      throw new Error(
        "请明确图片的裁剪、缩放、旋转、翻转、灰度或格式转换参数。生成式重绘需要切换到支持图片编辑的模式。"
      );
    }
    if (source.fileType !== "image" && operations.length === 0) {
      throw new Error("请至少提供一项需要在原文件中精确替换的内容。");
    }
    if (
      !editableTextExtensions.has(extension) &&
      !editableOfficeExtensions.has(extension) &&
      source.fileType !== "image"
    ) {
      throw new Error(`暂不支持保留原格式修改 ${extension || "该类型"} 文件。`);
    }

    const durable = await executeDurableTask(
      runtime,
      "edit_uploaded_file",
      { sourceFileId: source.fileId, outputFileName, operations, imageEdit },
      async () => {
        const sourceBuffer = await fs.readFile(
          resolveUploadStorageKey(source.storageKey)
        );
        const result = source.fileType === "image"
          ? await editImage(sourceBuffer, imageEdit!)
          : editableOfficeExtensions.has(extension)
            ? await editOfficeArchive(sourceBuffer, extension, operations)
            : (() => {
              const edited = applyOperations(
                sourceBuffer.toString("utf8"),
                operations
              );
              return {
                buffer: Buffer.from(edited.content, "utf8"),
                replacements: edited.replacements
              };
              })();
        const previousVersions = listGeneratedFiles(
          context.threadId,
          context.userId
        ).filter((file) => file.sourceFileId === source.fileId);
        const version =
          Math.max(1, ...previousVersions.map((file) => file.version)) + 1;
        const generated = await createGeneratedBinaryFile({
          threadId: context.threadId,
          userId: context.userId,
          turnId: context.turnId,
          sourceFileId: source.fileId,
          parentFileId: previousVersions.at(-1)?.fileId,
          version,
          editMode: "preserve-layout",
          fileName:
            outputFileName ||
            createVersionedName(
              source.originalName,
              version,
              imageEdit?.format
            ),
          buffer: result.buffer,
          mimeType: imageEdit?.format
            ? `image/${imageEdit.format}`
            : source.mimeType
        });
        return {
          fileId: generated.fileId,
          fileName: generated.fileName,
          sourceFileId: source.fileId,
          sourceFileName: source.originalName,
          version,
          replacements: result.replacements,
          downloadReady: true
        };
      }
    );
    return writeToolContext(runtime, "edit_uploaded_file", {
      sourceFileId: source.fileId,
      outputFileName,
      operations,
      imageEdit
    }, {
      ...durable.result,
      replayed: durable.replayed
    });
  },
  {
    name: "edit_uploaded_file",
    description:
      "基于当前对话已上传的原文件创建修改版，并保留来源与版本关系。支持文本、代码、DOCX、XLSX、PPTX 精确文本替换，以及图片裁剪、缩放、旋转、翻转、灰度和格式转换；写入前必须审批。不要用于 PDF 或生成式图片重绘。",
    schema: z.object({
      sourceFileId: z.string().optional().describe("当前附件 fileId；省略时使用当前对话附件"),
      outputFileName: z.string().optional().describe("修改版文件名；省略时自动添加版本号"),
      operations: z.array(editOperationSchema).max(50).default([]),
      imageEdit: imageEditSchema.optional()
    })
  }
);

async function editImage(
  source: Buffer,
  edit: z.infer<typeof imageEditSchema>
): Promise<{ buffer: Buffer; replacements: number }> {
  let pipeline = sharp(source, { failOn: "error" });
  if (edit.width || edit.height) {
    pipeline = pipeline.resize({
      width: edit.width,
      height: edit.height,
      fit: edit.fit,
      withoutEnlargement: false
    });
  }
  if (edit.rotate) {
    pipeline = pipeline.rotate(edit.rotate);
  }
  if (edit.flipHorizontal) {
    pipeline = pipeline.flop();
  }
  if (edit.flipVertical) {
    pipeline = pipeline.flip();
  }
  if (edit.grayscale) {
    pipeline = pipeline.grayscale();
  }
  if (edit.format) {
    pipeline = pipeline.toFormat(edit.format);
  }
  return { buffer: await pipeline.toBuffer(), replacements: 1 };
}

function createVersionedName(
  fileName: string,
  version: number,
  format?: "png" | "jpeg" | "webp"
): string {
  const originalExtension = path.extname(fileName);
  const extension =
    format ? `.${format === "jpeg" ? "jpg" : format}` : originalExtension;
  const baseName = path.basename(fileName, originalExtension);
  return `${baseName}-修改版-v${version}${extension}`;
}
