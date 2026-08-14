import fs from "fs";
import { ProviderConfig, ProviderId, UsageProfile } from "../types";

function maxOutputTokens(profile: UsageProfile = "balanced"): number {
  return profile === "economy" ? 2_048 : profile === "performance" ? 8_192 : 4_096;
}

export async function answerQuestionWithImage(input: {
  providerId: ProviderId;
  config: ProviderConfig;
  modelId: string;
  imagePath: string;
  mimeType: string;
  question: string;
  systemPrompt: string;
  usageProfile?: UsageProfile;
}): Promise<string> {
  // 学习点：支持视觉的模型需要直接接收图片内容。
  // 这里把本地图片读成 base64，再作为 input_image 发给 OpenAI-compatible Responses 接口。
  const imageBase64 = await fs.promises.readFile(input.imagePath, "base64");
  const imageUrl = `data:${input.mimeType};base64,${imageBase64}`;
  // 学习点：这条链路不同于 OCR。
  // OCR 是只提取图片文字；视觉模型是直接分析图片画面。
  if (input.providerId === "moonshot") {
    return answerWithOpenAICompatibleVision({
      ...input,
      imageUrl
    });
  }

  return answerWithOpenAIResponsesVision({
    ...input,
    imageUrl
  });
}

async function answerWithOpenAIResponsesVision(input: {
  config: ProviderConfig;
  modelId: string;
  imageUrl: string;
  question: string;
  systemPrompt: string;
  usageProfile?: UsageProfile;
}): Promise<string> {
  const response = await fetch(input.config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.config.apiKey}`
    },
    body: JSON.stringify({
      model: input.modelId,
      max_output_tokens: maxOutputTokens(input.usageProfile),
      instructions: [
        input.systemPrompt,
        "You are answering a question about an uploaded image.",
        "Analyze the visual content directly. If text is visible in the image, use it as part of the visual evidence."
      ].join("\n\n"),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: input.question
            },
            {
              type: "input_image",
              image_url: input.imageUrl
            }
          ]
        }
      ]
    })
  });
  const data = (await response.json()) as {
    output_text?: string;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(data.error?.message || "Image analysis request failed.");
  }

  return data.output_text?.trim() || "Image analysis returned no content.";
}

async function answerWithOpenAICompatibleVision(input: {
  config: ProviderConfig;
  modelId: string;
  imageUrl: string;
  question: string;
  systemPrompt: string;
  usageProfile?: UsageProfile;
}): Promise<string> {
  // 学习点：Kimi/Moonshot 是 OpenAI-compatible Chat Completions。
  // 为什么这样：它的图片输入放在 messages[].content 里，而不是 OpenAI Responses 的 input 数组。
  const response = await fetch(input.config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.config.apiKey}`
    },
    body: JSON.stringify({
      model: input.modelId,
      max_tokens: maxOutputTokens(input.usageProfile),
      messages: [
        {
          role: "system",
          content: [
            input.systemPrompt,
            "你正在回答用户关于上传图片的问题。",
            "请直接分析图片内容；如果图片里有文字，也要结合文字一起回答。"
          ].join("\n\n")
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: input.question
            },
            {
              type: "image_url",
              image_url: {
                url: input.imageUrl
              }
            }
          ]
        }
      ]
    })
  });
  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
      };
    }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(data.error?.message || "图片分析请求失败。");
  }

  return data.choices?.[0]?.message?.content?.trim() || "图片分析没有返回内容。";
}
