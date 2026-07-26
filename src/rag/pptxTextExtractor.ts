import path from "path";
import JSZip from "jszip";
import { withOcrWorker } from "./imageOcrExtractor";

const SLIDE_XML_PATTERN = /^ppt\/slides\/slide\d+\.xml$/;
const TEXT_NODE_PATTERN = /<a:t>([\s\S]*?)<\/a:t>/g;
const RELATIONSHIP_PATTERN =
  /<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*>/g;
const BLIP_PATTERN = /<a:blip\b[^>]*(?:r:embed|embed)="([^"]+)"[^>]*>/g;
const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

export async function extractTextFromPptx(fileBuffer: Buffer): Promise<string> {
  // 学习点：PPTX 本质上是一个 zip 包，里面包含每一页 slide 的 XML。
  const zip = await JSZip.loadAsync(fileBuffer);
  const slidePaths = Object.keys(zip.files)
    .filter((filePath) => SLIDE_XML_PATTERN.test(filePath))
    .sort((left, right) => getSlideNumber(left) - getSlideNumber(right));

  return withOcrWorker(async (recognizeImage) => {
    // 学习点：一份 PPT 会被整理成“第几页 + 该页文字 + 图片文字”的纯文本。
    const slideTexts: string[] = [];

    for (const slidePath of slidePaths) {
      const slideXml = await zip.files[slidePath].async("text");
      // 学习点：先提取幻灯片文本框里的文字。
      const textRuns = extractSlideTextRuns(slideXml);
      // 学习点：再找这一页引用的图片，尝试提取图片里的文字。
      const imagePaths = await getSlideImagePaths(zip, slidePath, slideXml);
      const imageOcrTexts: string[] = [];

      for (const imagePath of imagePaths) {
        const imageFile = zip.files[imagePath];
        if (!imageFile) {
          continue;
        }

        const imageBuffer = Buffer.from(await imageFile.async("uint8array"));
        // 学习点：这里是图片文字提取，不是模型直接理解图片画面。
        const imageText = (await recognizeImage(imageBuffer)).trim();

        if (imageText) {
          imageOcrTexts.push(
            [`[Image text: ${path.posix.basename(imagePath)}]`, imageText].join("\n")
          );
        }
      }

      slideTexts.push(
        [
          `[Slide ${getSlideNumber(slidePath)}]`,
          textRuns.length ? textRuns.join(" ") : "[No editable slide text]",
          imageOcrTexts.length ? ["[Slide image text]", ...imageOcrTexts].join("\n") : ""
        ]
          .filter(Boolean)
          .join("\n")
      );
    }

    return slideTexts.join("\n\n");
  });
}

function extractSlideTextRuns(slideXml: string): string[] {
  // 学习点：PowerPoint 文本通常存放在 <a:t> 节点里。
  return [...slideXml.matchAll(TEXT_NODE_PATTERN)]
    .map((match) => decodeXmlText(match[1]).trim())
    .filter(Boolean);
}

async function getSlideImagePaths(
  zip: JSZip,
  slidePath: string,
  slideXml: string
): Promise<string[]> {
  // 学习点：slide XML 只保存图片引用 id，真正路径要去 .rels 关系文件里找。
  const relationshipPath = getSlideRelationshipPath(slidePath);
  const relationshipFile = zip.files[relationshipPath];

  if (!relationshipFile) {
    return [];
  }

  const relationshipXml = await relationshipFile.async("text");
  const relationshipTargets = new Map<string, string>();

  for (const match of relationshipXml.matchAll(RELATIONSHIP_PATTERN)) {
    relationshipTargets.set(match[1], match[2]);
  }

  return [...slideXml.matchAll(BLIP_PATTERN)]
    .map((match) => relationshipTargets.get(match[1]))
    .filter((target): target is string => Boolean(target))
    .map((target) => resolveRelationshipTarget(slidePath, target))
    .filter((target) => IMAGE_EXTENSION_PATTERN.test(target));
}

function getSlideRelationshipPath(slidePath: string): string {
  const directory = path.posix.dirname(slidePath);
  const fileName = path.posix.basename(slidePath);
  return path.posix.join(directory, "_rels", `${fileName}.rels`);
}

function resolveRelationshipTarget(slidePath: string, target: string): string {
  // 学习点：关系文件里的图片路径可能是相对路径，需要转成 zip 内标准路径。
  if (target.startsWith("/")) {
    return target.slice(1);
  }

  return path.posix
    .normalize(path.posix.join(path.posix.dirname(slidePath), target))
    .replace(/^\.\//, "");
}

function getSlideNumber(slidePath: string): number {
  const match = slidePath.match(/slide(\d+)\.xml$/);
  return match ? Number(match[1]) : 0;
}

function decodeXmlText(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
