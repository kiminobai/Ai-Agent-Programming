import fs from "fs";
import { ProviderConfig } from "../types";

export async function answerQuestionWithImage(input: {
  config: ProviderConfig;
  modelId: string;
  imagePath: string;
  mimeType: string;
  question: string;
  systemPrompt: string;
}): Promise<string> {
  const imageBase64 = await fs.promises.readFile(input.imagePath, "base64");
  const imageUrl = `data:${input.mimeType};base64,${imageBase64}`;
  const response = await fetch(input.config.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.config.apiKey}`
    },
    body: JSON.stringify({
      model: input.modelId,
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
              image_url: imageUrl
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
