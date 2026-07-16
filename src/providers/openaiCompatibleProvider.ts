import {
  ChatProvider,
  FewShotExample,
  ProviderConfig,
  ProviderId,
  ReasoningEffort
} from "../types";

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface OpenAICompatibleStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
  };
}

interface OpenAIResponsesResponse {
  output_text?: string;
  error?: {
    message?: string;
  };
}

interface OpenAIResponsesStreamEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
  error?: {
    message?: string;
  };
}

export class OpenAICompatibleProvider implements ChatProvider {
  constructor(
    public readonly id: ProviderId,
    private readonly config: ProviderConfig
  ) {}

  isAvailable(): boolean {
    return Boolean(this.config.apiKey);
  }

  async sendChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[] = [],
    reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error(`${this.id} has no API key configured.`);
    }

    if (this.id === "openai") {
      return this.sendResponsesChat(
        modelId,
        message,
        systemPrompt,
        fewShotExamples,
        reasoningEffort
      );
    }

    return this.sendCompatibleChat(modelId, message, systemPrompt, fewShotExamples);
  }

  async streamChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[] = [],
    reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    if (!this.config.apiKey) {
      throw new Error(`${this.id} has no API key configured.`);
    }

    if (this.id === "openai") {
      return this.streamResponsesChat(
        modelId,
        message,
        systemPrompt,
        onDelta,
        fewShotExamples,
        reasoningEffort
      );
    }

    return this.streamCompatibleChat(
      modelId,
      message,
      systemPrompt,
      onDelta,
      fewShotExamples
    );
  }

  private buildCompatibleMessages(
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[]
  ) {
    const exampleMessages = fewShotExamples.flatMap((example) => [
      {
        role: "user" as const,
        content: example.user
      },
      {
        role: "assistant" as const,
        content: example.assistant
      }
    ]);

    return [
      {
        role: "system" as const,
        content: systemPrompt
      },
      ...exampleMessages,
      {
        role: "user" as const,
        content: message
      }
    ];
  }

  private buildResponsesInput(
    message: string,
    fewShotExamples: FewShotExample[]
  ) {
    return [
      ...fewShotExamples.flatMap((example) => [
        {
          role: "user",
          content: example.user
        },
        {
          role: "assistant",
          content: example.assistant
        }
      ]),
      {
        role: "user",
        content: message
      }
    ];
  }

  private buildResponsesBody(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[],
    stream: boolean,
    reasoningEffort?: ReasoningEffort
  ) {
    const selectedEffort = reasoningEffort || this.config.reasoningEffort;

    return {
      model: modelId,
      instructions: systemPrompt,
      input: this.buildResponsesInput(message, fewShotExamples),
      reasoning: selectedEffort ? { effort: selectedEffort } : undefined,
      stream
    };
  }

  private async sendCompatibleChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[]
  ): Promise<string> {
    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.buildCompatibleMessages(
          message,
          systemPrompt,
          fewShotExamples
        ),
        temperature: 0.7,
        stream: false
      })
    });

    const data = (await response.json()) as OpenAICompatibleResponse;

    if (!response.ok) {
      throw new Error(data.error?.message || `${this.id} request failed.`);
    }

    return data.choices?.[0]?.message?.content?.trim() || "Model returned no content.";
  }

  private async streamCompatibleChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[]
  ): Promise<string> {
    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.buildCompatibleMessages(
          message,
          systemPrompt,
          fewShotExamples
        ),
        temperature: 0.7,
        stream: true
      })
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as
        | OpenAICompatibleResponse
        | null;
      throw new Error(data?.error?.message || `${this.id} request failed.`);
    }

    if (!response.body) {
      throw new Error(`${this.id} did not return a readable stream.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    const consumeEvent = (rawEvent: string) => {
      const lines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const line of lines) {
        if (line === "[DONE]") {
          continue;
        }

        const chunk = JSON.parse(line) as OpenAICompatibleStreamChunk;
        if (chunk.error?.message) {
          throw new Error(chunk.error.message);
        }

        const delta = chunk.choices?.[0]?.delta?.content || "";
        if (!delta) {
          continue;
        }

        fullText += delta;
        onDelta(delta);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      let eventEnd = buffer.indexOf("\n\n");
      while (eventEnd !== -1) {
        const rawEvent = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);
        if (rawEvent.trim()) {
          consumeEvent(rawEvent);
        }
        eventEnd = buffer.indexOf("\n\n");
      }

      if (done) {
        break;
      }
    }

    if (buffer.trim()) {
      consumeEvent(buffer);
    }

    return fullText.trim() || "Model returned no content.";
  }

  private async sendResponsesChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[],
    reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(
        this.buildResponsesBody(
          modelId,
          message,
          systemPrompt,
          fewShotExamples,
          false,
          reasoningEffort
        )
      )
    });

    const data = (await response.json()) as OpenAIResponsesResponse;

    if (!response.ok) {
      throw new Error(data.error?.message || `${this.id} request failed.`);
    }

    return data.output_text?.trim() || "Model returned no content.";
  }

  private async streamResponsesChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[],
    reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(
        this.buildResponsesBody(
          modelId,
          message,
          systemPrompt,
          fewShotExamples,
          true,
          reasoningEffort
        )
      )
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as
        | OpenAIResponsesResponse
        | null;
      throw new Error(data?.error?.message || `${this.id} request failed.`);
    }

    if (!response.body) {
      throw new Error(`${this.id} did not return a readable stream.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    const consumeEvent = (rawEvent: string) => {
      const lines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const line of lines) {
        if (line === "[DONE]") {
          continue;
        }

        const event = JSON.parse(line) as OpenAIResponsesStreamEvent;
        if (event.error?.message) {
          throw new Error(event.error.message);
        }

        if (event.type === "response.output_text.delta" && event.delta) {
          fullText += event.delta;
          onDelta(event.delta);
          continue;
        }

        if (
          event.type === "response.output_item.added" &&
          event.item?.type === "message"
        ) {
          const text = event.item.content
            ?.filter((contentItem) => contentItem.type === "output_text")
            .map((contentItem) => contentItem.text || "")
            .join("");

          if (text) {
            fullText += text;
            onDelta(text);
          }
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      let eventEnd = buffer.indexOf("\n\n");
      while (eventEnd !== -1) {
        const rawEvent = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);
        if (rawEvent.trim()) {
          consumeEvent(rawEvent);
        }
        eventEnd = buffer.indexOf("\n\n");
      }

      if (done) {
        break;
      }
    }

    if (buffer.trim()) {
      consumeEvent(buffer);
    }

    return fullText.trim() || "Model returned no content.";
  }
}
