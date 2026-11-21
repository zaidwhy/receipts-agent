// The model sits behind LlmClient so tests can pass a scripted fake.
// The real implementation is one OpenAI-compatible client (OpenRouter by default).
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON text exactly as the model wrote it
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type LlmEvent = { type: "token"; text: string } | { type: "tool_call"; call: ToolCall };

export interface LlmClient {
  streamChat(request: { messages: ChatMessage[]; tools?: ToolDefinition[] }): AsyncIterable<LlmEvent>;
}

export interface LlmOptions {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

export function createLlmClient(options: LlmOptions): LlmClient {
  // Built on first use so the server can boot without a key and show a clear card instead.
  let client: OpenAI | undefined;
  function getClient(): OpenAI {
    if (!options.apiKey) throw new Error("LLM_API_KEY is not set");
    client ??= new OpenAI({ baseURL: options.baseUrl, apiKey: options.apiKey });
    return client;
  }

  return {
    async *streamChat(request) {
      const stream = await getClient().chat.completions.create({
        model: options.model,
        messages: request.messages.map(toOpenAiMessage),
        tools: request.tools?.map(toOpenAiTool),
        stream: true,
      });

      // Tool calls arrive as fragments tagged with an index; glue them together.
      const pending = new Map<number, ToolCall>();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { type: "token", text: delta.content };
        for (const part of delta.tool_calls ?? []) {
          const call = pending.get(part.index) ?? { id: "", name: "", arguments: "" };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.arguments += part.function.arguments;
          pending.set(part.index, call);
        }
      }
      const inOrder = [...pending.entries()].sort((a, b) => a[0] - b[0]);
      for (const [, call] of inOrder) yield { type: "tool_call", call };
    },
  };
}

function toOpenAiMessage(message: ChatMessage): ChatCompletionMessageParam {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAiTool(tool: ToolDefinition): ChatCompletionTool {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}
