import { createWorker } from "tesseract.js";

export async function extractTextFromImage(fileBuffer: Buffer): Promise<string> {
  // 学习点：这里做的是“图片里的文字提取”，不是让 LLM 直接理解图片内容。
  return withOcrWorker(async (recognizeImage) => recognizeImage(fileBuffer));
}

export async function withOcrWorker<T>(
  run: (recognizeImage: (fileBuffer: Buffer) => Promise<string>) => Promise<T>
): Promise<T> {
  // 学习点：OCR worker 创建成本比较高，所以 PPTX 里多张图片会复用同一个 worker。
  const worker = await createWorker("eng+chi_sim");

  try {
    return await run(async (fileBuffer) => {
      const result = await worker.recognize(fileBuffer);
      return result.data.text || "";
    });
  } finally {
    await worker.terminate();
  }
}
