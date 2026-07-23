import {
  ChatProvider,
  FewShotExample,
  ProviderConfig,
  ProviderId,
  ReasoningEffort
} from "../types";
import {
  executeGetWeather,
  getWeatherTool
} from "../tools";

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      role?: "assistant";
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: CompatibleToolCall[];
    };
  }>;
  error?: {
    message?: string;
  };
}

interface OpenAICompatibleStreamChunk {
  choices?: Array<{
    delta?: {
      role?: "assistant";
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: CompatibleToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  error?: {
    message?: string;
  };
}

interface CompatibleToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface CompatibleToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface DeepSeekStreamResult {
  text: string;
  assistantMessage: {
    role: "assistant";
    content: string | null;
    reasoning_content?: string;
    tool_calls?: CompatibleToolCall[];
  };
}

interface OpenAIResponsesOutputItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  [key: string]: unknown;
}

interface OpenAIResponsesResponse {
  output_text?: string;
  output?: OpenAIResponsesOutputItem[];
  error?: {
    message?: string;
  };
}

interface OpenAIResponsesStreamEvent {
  type?: string;
  delta?: string;
  item?: OpenAIResponsesOutputItem;
  response?: {
    output?: OpenAIResponsesOutputItem[];
  };
  error?: {
    message?: string;
  };
}

interface ResponsesStreamResult {
  text: string;
  outputItems: OpenAIResponsesOutputItem[];
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
    const selectedEffort = this.getSupportedReasoningEffort(
      modelId,
      reasoningEffort
    );

    return {
      model: modelId,
      instructions: systemPrompt,
      input: this.buildResponsesInput(message, fewShotExamples),
      tools: [getWeatherTool],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: selectedEffort ? { effort: selectedEffort } : undefined,
      stream
    };
  }

  private buildResponsesContinuationBody(
    modelId: string,
    systemPrompt: string,
    input: unknown[],
    stream: boolean,
    reasoningEffort?: ReasoningEffort
  ) {
    const selectedEffort = this.getSupportedReasoningEffort(
      modelId,
      reasoningEffort
    );

    return {
      model: modelId,
      instructions: systemPrompt,
      input,
      tools: [getWeatherTool],
      tool_choice: "none",
      parallel_tool_calls: false,
      reasoning: selectedEffort ? { effort: selectedEffort } : undefined,
      stream
    };
  }

  private getSupportedReasoningEffort(
    modelId: string,
    reasoningEffort?: ReasoningEffort
  ): ReasoningEffort | undefined {
    const supportsReasoning =
      modelId.startsWith("gpt-5") || /^o\d/.test(modelId);

    if (!supportsReasoning) {
      return undefined;
    }

    return reasoningEffort || this.config.reasoningEffort;
  }

  private getWeatherToolCall(
    outputItems: OpenAIResponsesOutputItem[]
  ): OpenAIResponsesOutputItem | undefined {
    return outputItems.find(
      (item) =>
        item.type === "function_call" &&
        item.name === getWeatherTool.name &&
        Boolean(item.call_id)
    );
  }

  private async executeWeatherToolCall(
    toolCall: OpenAIResponsesOutputItem
  ): Promise<string> {
    return this.executeWeatherArguments(toolCall.arguments);
  }

  private async executeWeatherArguments(
    argumentsJson?: string
  ): Promise<string> {
    try {
      const args = JSON.parse(argumentsJson || "{}") as unknown;
      console.info("[tool:get_weather] call", args);
      const result = await executeGetWeather(args);
      console.info("[tool:get_weather] success", {
        location: result.location.resolved,
        observedAt: result.current.observedAt
      });
      return JSON.stringify({
        success: true,
        data: result
      });
    } catch (error) {
      console.error(
        "[tool:get_weather] failed",
        error instanceof Error ? error.message : error
      );
      return JSON.stringify({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error while executing get_weather."
      });
    }
  }

  private createFunctionCallOutput(
    toolCall: OpenAIResponsesOutputItem,
    output: string
  ) {
    return {
      type: "function_call_output",
      call_id: toolCall.call_id,
      output
    };
  }

  private buildDeepSeekWeatherTools() {
    return [
      {
        type: "function",
        function: {
          name: getWeatherTool.name,
          description: getWeatherTool.description,
          parameters: getWeatherTool.parameters
        }
      }
    ] as const;
  }

  private getDeepSeekWeatherCall(
    toolCalls?: CompatibleToolCall[]
  ): CompatibleToolCall | undefined {
    return toolCalls?.find(
      (toolCall) =>
        toolCall.type === "function" &&
        toolCall.function.name === getWeatherTool.name
    );
  }

  private async sendDeepSeekToolChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[]
  ): Promise<string> {
    const messages = this.buildCompatibleMessages(
      message,
      systemPrompt,
      fewShotExamples
    );
    const tools = this.buildDeepSeekWeatherTools();

    const initialResponse = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        tools,
        tool_choice: "auto",
        stream: false
      })
    });

    const initialData =
      (await initialResponse.json()) as OpenAICompatibleResponse;
    if (!initialResponse.ok) {
      throw new Error(
        initialData.error?.message || `${this.id} request failed.`
      );
    }

    const assistant = initialData.choices?.[0]?.message;
    const toolCall = this.getDeepSeekWeatherCall(assistant?.tool_calls);
    if (!assistant || !toolCall) {
      return (
        assistant?.content?.trim() || "Model returned no content."
      );
    }

    const toolOutput = await this.executeWeatherArguments(
      toolCall.function.arguments
    );
    const continuationMessages = [
      ...messages,
      {
        role: "assistant" as const,
        content: assistant.content ?? null,
        reasoning_content: assistant.reasoning_content || undefined,
        tool_calls: assistant.tool_calls
      },
      {
        role: "tool" as const,
        tool_call_id: toolCall.id,
        content: toolOutput
      }
    ];

    const finalResponse = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: continuationMessages,
        tools,
        tool_choice: "none",
        stream: false
      })
    });

    const finalData = (await finalResponse.json()) as OpenAICompatibleResponse;
    if (!finalResponse.ok) {
      throw new Error(
        finalData.error?.message || `${this.id} request failed.`
      );
    }

    return (
      finalData.choices?.[0]?.message?.content?.trim() ||
      "Model returned no content."
    );
  }

  private async consumeDeepSeekStream(
    modelId: string,
    messages: unknown[],
    toolChoice: "auto" | "none",
    onDelta: (chunk: string) => void
  ): Promise<DeepSeekStreamResult> {
    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        tools: this.buildDeepSeekWeatherTools(),
        tool_choice: toolChoice,
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
    const toolCalls: Array<CompatibleToolCall | undefined> = [];
    let buffer = "";
    let text = "";
    let reasoningContent = "";

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

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) {
          continue;
        }

        if (delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
        }

        if (delta.content) {
          text += delta.content;
          onDelta(delta.content);
        }

        for (const toolCallDelta of delta.tool_calls || []) {
          const index = toolCallDelta.index;
          const current = toolCalls[index] || {
            id: "",
            type: "function" as const,
            function: {
              name: "",
              arguments: ""
            }
          };

          if (toolCallDelta.id) {
            current.id = toolCallDelta.id;
          }
          if (toolCallDelta.function?.name) {
            current.function.name = toolCallDelta.function.name;
          }
          if (toolCallDelta.function?.arguments) {
            current.function.arguments +=
              toolCallDelta.function.arguments;
          }

          toolCalls[index] = current;
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

    const completeToolCalls = toolCalls.filter(
      (toolCall): toolCall is CompatibleToolCall =>
        Boolean(
          toolCall?.id &&
            toolCall.function.name &&
            toolCall.function.arguments
        )
    );

    return {
      text,
      assistantMessage: {
        role: "assistant",
        content: text || null,
        reasoning_content: reasoningContent || undefined,
        tool_calls:
          completeToolCalls.length > 0 ? completeToolCalls : undefined
      }
    };
  }

  private async streamDeepSeekToolChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[]
  ): Promise<string> {
    const messages = this.buildCompatibleMessages(
      message,
      systemPrompt,
      fewShotExamples
    );
    const initialResult = await this.consumeDeepSeekStream(
      modelId,
      messages,
      "auto",
      onDelta
    );
    const toolCall = this.getDeepSeekWeatherCall(
      initialResult.assistantMessage.tool_calls
    );

    if (!toolCall) {
      return initialResult.text.trim() || "Model returned no content.";
    }

    const toolOutput = await this.executeWeatherArguments(
      toolCall.function.arguments
    );
    const continuationMessages = [
      ...messages,
      initialResult.assistantMessage,
      {
        role: "tool" as const,
        tool_call_id: toolCall.id,
        content: toolOutput
      }
    ];

    if (initialResult.text) {
      onDelta("\n\n");
    }

    const finalResult = await this.consumeDeepSeekStream(
      modelId,
      continuationMessages,
      "none",
      onDelta
    );
    const combinedText = [initialResult.text.trim(), finalResult.text.trim()]
      .filter(Boolean)
      .join("\n\n");

    return combinedText || "Model returned no content.";
  }

  private async sendCompatibleChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    fewShotExamples: FewShotExample[]
  ): Promise<string> {
    if (this.id === "deepseek") {
      return this.sendDeepSeekToolChat(
        modelId,
        message,
        systemPrompt,
        fewShotExamples
      );
    }

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
    if (this.id === "deepseek") {
      return this.streamDeepSeekToolChat(
        modelId,
        message,
        systemPrompt,
        onDelta,
        fewShotExamples
      );
    }

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
    const initialInput = this.buildResponsesInput(message, fewShotExamples);
    const initialResponse = await fetch(this.config.apiUrl, {
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

    const initialData =
      (await initialResponse.json()) as OpenAIResponsesResponse;

    if (!initialResponse.ok) {
      throw new Error(
        initialData.error?.message || `${this.id} request failed.`
      );
    }

    const toolCall = this.getWeatherToolCall(initialData.output || []);
    if (!toolCall) {
      return (
        initialData.output_text?.trim() || "Model returned no content."
      );
    }

    const toolOutput = await this.executeWeatherToolCall(toolCall);
    const continuationInput = [
      ...initialInput,
      ...(initialData.output || []),
      this.createFunctionCallOutput(toolCall, toolOutput)
    ];

    const finalResponse = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(
        this.buildResponsesContinuationBody(
          modelId,
          systemPrompt,
          continuationInput,
          false,
          reasoningEffort
        )
      )
    });

    const finalData = (await finalResponse.json()) as OpenAIResponsesResponse;
    if (!finalResponse.ok) {
      throw new Error(
        finalData.error?.message || `${this.id} request failed.`
      );
    }

    return finalData.output_text?.trim() || "Model returned no content.";
  }

  private async consumeResponsesStream(
    body: unknown,
    onDelta: (chunk: string) => void,
  ): Promise<ResponsesStreamResult> {
    const response = await fetch(this.config.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body)
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
    const outputItems: OpenAIResponsesOutputItem[] = [];

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

        if (event.type === "response.output_item.done" && event.item) {
          outputItems.push(event.item);
          continue;
        }

        if (
          event.type === "response.completed" &&
          outputItems.length === 0 &&
          event.response?.output
        ) {
          for (const item of event.response.output) {
            outputItems.push(item);
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

    return {
      text: fullText,
      outputItems
    };
  }

  private async streamResponsesChat(
    modelId: string,
    message: string,
    systemPrompt: string,
    onDelta: (chunk: string) => void,
    fewShotExamples: FewShotExample[],
    reasoningEffort?: ReasoningEffort
  ): Promise<string> {
    const initialInput = this.buildResponsesInput(message, fewShotExamples);
    const initialResult = await this.consumeResponsesStream(
      this.buildResponsesBody(
        modelId,
        message,
        systemPrompt,
        fewShotExamples,
        true,
        reasoningEffort
      ),
      onDelta
    );

    const toolCall = this.getWeatherToolCall(initialResult.outputItems);
    if (!toolCall) {
      return initialResult.text.trim() || "Model returned no content.";
    }

    const toolOutput = await this.executeWeatherToolCall(toolCall);
    const continuationInput = [
      ...initialInput,
      ...initialResult.outputItems,
      this.createFunctionCallOutput(toolCall, toolOutput)
    ];

    if (initialResult.text) {
      onDelta("\n\n");
    }

    const finalResult = await this.consumeResponsesStream(
      this.buildResponsesContinuationBody(
        modelId,
        systemPrompt,
        continuationInput,
        true,
        reasoningEffort
      ),
      onDelta
    );

    const combinedText = [initialResult.text.trim(), finalResult.text.trim()]
      .filter(Boolean)
      .join("\n\n");

    return combinedText || "Model returned no content.";
  }
}
