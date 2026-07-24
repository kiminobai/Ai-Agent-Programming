import OpenAI from "openai";
import {
  ChatProvider,
  FewShotExample,
  ProviderConfig,
  ProviderId,
  ReasoningEffort
} from "../types";
import {
  executeTool,
  isSupportedToolName,
  toolSchemas
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

interface DeepSeekAssistantMessage {
  role: "assistant";
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: CompatibleToolCall[];
}

interface DeepSeekStreamResult {
  text: string;
  assistantMessage: DeepSeekAssistantMessage;
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
  private readonly deepSeekClient?: OpenAI;

  constructor(
    public readonly id: ProviderId,
    private readonly config: ProviderConfig
  ) {
    if (id === "deepseek" && config.apiKey) {
      this.deepSeekClient = new OpenAI({
        apiKey: config.apiKey,
        baseURL: this.getDeepSeekBaseUrl(config.apiUrl)
      });
    }
  }

  isAvailable(): boolean {
    return Boolean(this.config.apiKey);
  }

  private getDeepSeekBaseUrl(apiUrl: string): string {
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(
      /\/(?:v1\/)?chat\/completions\/?$/,
      ""
    );
    return url.toString().replace(/\/$/, "");
  }

  private requireDeepSeekClient(): OpenAI {
    if (!this.deepSeekClient) {
      throw new Error("DeepSeek SDK client is not configured.");
    }

    return this.deepSeekClient;
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
      tools: toolSchemas,
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
      tools: toolSchemas,
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

  private getResponsesToolCalls(
    outputItems: OpenAIResponsesOutputItem[]
  ): OpenAIResponsesOutputItem[] {
    return outputItems.filter(
      (item) =>
        item.type === "function_call" &&
        Boolean(item.name) &&
        isSupportedToolName(item.name || "") &&
        Boolean(item.call_id)
    );
  }

  private async executeResponsesToolCall(
    toolCall: OpenAIResponsesOutputItem
  ): Promise<string> {
    return this.executeToolArguments(
      toolCall.name || "",
      toolCall.arguments
    );
  }

  private async executeToolArguments(
    name: string,
    argumentsJson?: string
  ): Promise<string> {
    try {
      if (!isSupportedToolName(name)) {
        throw new Error(`Unsupported tool: "${name}".`);
      }

      const args = JSON.parse(argumentsJson || "{}") as unknown;
      console.info(`[tool:${name}] call`, args);
      const result = await executeTool(name, args);
      console.info(`[tool:${name}] success`);
      return JSON.stringify({
        success: true,
        data: result
      });
    } catch (error) {
      console.error(
        `[tool:${name || "unknown"}] failed`,
        error instanceof Error ? error.message : error
      );
      return JSON.stringify({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : `Unknown error while executing ${name || "tool"}.`
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

  private buildDeepSeekTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return toolSchemas.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  private getDeepSeekToolCalls(
    toolCalls?: CompatibleToolCall[]
  ): CompatibleToolCall[] {
    return (toolCalls || []).filter(
      (toolCall) =>
        toolCall.type === "function" &&
        isSupportedToolName(toolCall.function.name)
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
    const tools = this.buildDeepSeekTools();
    const client = this.requireDeepSeekClient();

    const initialData = await client.chat.completions.create({
      model: modelId,
      messages:
        messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      tool_choice: "auto",
      stream: false
    });

    const assistant = initialData.choices[0]?.message as
      | DeepSeekAssistantMessage
      | undefined;
    const toolCalls = this.getDeepSeekToolCalls(assistant?.tool_calls);
    if (!assistant || toolCalls.length === 0) {
      return (
        assistant?.content?.trim() || "Model returned no content."
      );
    }

    const toolMessages = await Promise.all(
      toolCalls.map(async (toolCall) => ({
        role: "tool" as const,
        tool_call_id: toolCall.id,
        content: await this.executeToolArguments(
          toolCall.function.name,
          toolCall.function.arguments
        )
      }))
    );
    const continuationMessages = [
      ...messages,
      {
        role: "assistant" as const,
        content: assistant.content ?? null,
        reasoning_content: assistant.reasoning_content || undefined,
        tool_calls: assistant.tool_calls
      },
      ...toolMessages
    ];

    const finalData = await client.chat.completions.create({
      model: modelId,
      messages:
        continuationMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      tool_choice: "none",
      stream: false
    });

    return (
      finalData.choices[0]?.message?.content?.trim() ||
      "Model returned no content."
    );
  }

  private async consumeDeepSeekStream(
    modelId: string,
    messages: unknown[],
    toolChoice: "auto" | "none",
    onDelta: (chunk: string) => void
  ): Promise<DeepSeekStreamResult> {
    const stream = await this.requireDeepSeekClient().chat.completions.create({
      model: modelId,
      messages:
        messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: this.buildDeepSeekTools(),
      tool_choice: toolChoice,
      stream: true
    });
    const toolCalls: Array<CompatibleToolCall | undefined> = [];
    let text = "";
    let reasoningContent = "";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as
        | {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: CompatibleToolCallDelta[];
          }
        | undefined;

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
    const toolCalls = this.getDeepSeekToolCalls(
      initialResult.assistantMessage.tool_calls
    );

    if (toolCalls.length === 0) {
      return initialResult.text.trim() || "Model returned no content.";
    }

    const toolMessages = await Promise.all(
      toolCalls.map(async (toolCall) => ({
        role: "tool" as const,
        tool_call_id: toolCall.id,
        content: await this.executeToolArguments(
          toolCall.function.name,
          toolCall.function.arguments
        )
      }))
    );
    const continuationMessages = [
      ...messages,
      initialResult.assistantMessage,
      ...toolMessages
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

    const toolCalls = this.getResponsesToolCalls(initialData.output || []);
    if (toolCalls.length === 0) {
      return (
        initialData.output_text?.trim() || "Model returned no content."
      );
    }

    const functionCallOutputs = await Promise.all(
      toolCalls.map(async (toolCall) =>
        this.createFunctionCallOutput(
          toolCall,
          await this.executeResponsesToolCall(toolCall)
        )
      )
    );
    const continuationInput = [
      ...initialInput,
      ...(initialData.output || []),
      ...functionCallOutputs
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

    const toolCalls = this.getResponsesToolCalls(
      initialResult.outputItems
    );
    if (toolCalls.length === 0) {
      return initialResult.text.trim() || "Model returned no content.";
    }

    const functionCallOutputs = await Promise.all(
      toolCalls.map(async (toolCall) =>
        this.createFunctionCallOutput(
          toolCall,
          await this.executeResponsesToolCall(toolCall)
        )
      )
    );
    const continuationInput = [
      ...initialInput,
      ...initialResult.outputItems,
      ...functionCallOutputs
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
