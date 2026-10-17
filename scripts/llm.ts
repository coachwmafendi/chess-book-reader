// Abstraksi LLM untuk script ingest — sokong Anthropic (default) dan Google Gemini.
// Pilih provider via env: INGEST_PROVIDER=anthropic|google
// Anthropic perlu ANTHROPIC_API_KEY; Google perlu GOOGLE_API_KEY.

import Anthropic from '@anthropic-ai/sdk';
import {
  GoogleGenerativeAI,
  FunctionCallingMode,
  SchemaType,
  type FunctionDeclarationSchema,
  type Schema,
  type Part,
} from '@google/generative-ai';

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string };

export interface LlmProvider {
  /** Hantar prompt + gambar dan minta model pulangkan JSON mengikut tool schema. */
  complete<T>(system: string, content: Content[], tool: Tool): Promise<T>;
}

export function getProvider(name = process.env.INGEST_PROVIDER ?? 'anthropic'): LlmProvider {
  if (name === 'google') return new GoogleProvider();
  return new AnthropicProvider();
}

// ---------- Anthropic ----------
class AnthropicProvider implements LlmProvider {
  private client = new Anthropic();
  private model = process.env.ANTHROPIC_MODEL ?? process.env.CLAUDE_MODEL ?? 'claude-sonnet-5-5';

  async complete<T>(system: string, content: Content[], tool: Tool): Promise<T> {
    const messageContent: Anthropic.ContentBlockParam[] = content.map((c) =>
      c.type === 'text'
        ? { type: 'text', text: c.text }
        : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: c.data } },
    );

    const res = await this.client.messages.stream({
      model: this.model,
      max_tokens: 64000,
      system: `${system}\n\nPulangkan jawapan dengan memanggil tool "${tool.name}" sekali sahaja. Jangan balas dengan teks biasa.`,
      tools: [tool as Anthropic.Tool],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: messageContent }],
    }).finalMessage();

    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') {
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').slice(0, 300);
      throw new Error(`Model tidak memulangkan tool_use (stop_reason: ${res.stop_reason}, out ${res.usage.output_tokens}) ${text}`);
    }
    console.log(`   ↳ token: in ${res.usage.input_tokens}, out ${res.usage.output_tokens}`);
    return block.input as T;
  }
}

// ---------- Google Gemini ----------
class GoogleProvider implements LlmProvider {
  private apiKey = process.env.GOOGLE_API_KEY ?? '';
  private model = process.env.GOOGLE_MODEL ?? 'gemini-2.5-flash-preview-05-20';
  private genAI = new GoogleGenerativeAI(this.apiKey);

  async complete<T>(system: string, content: Content[], tool: Tool): Promise<T> {
    if (!this.apiKey) throw new Error('GOOGLE_API_KEY tidak di-set.');

    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: `${system}\n\nPulangkan jawapan sebagai JSON yang padan dengan struktur "${tool.name}". Jangan balas dengan teks biasa.`,
    });

    const parts: Part[] = content.map((c) =>
      c.type === 'text'
        ? { text: c.text }
        : { inlineData: { mimeType: 'image/png', data: c.data } },
    );

    const declaration = {
      name: tool.name,
      description: tool.description,
      parameters: jsonSchemaToGemini(tool.input_schema) as FunctionDeclarationSchema,
    };

    const result = await model.generateContent({
      contents: [{ role: 'user', parts }],
      tools: [{ functionDeclarations: [declaration] }],
      toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY, allowedFunctionNames: [tool.name] } },
    });

    const calls = result.response.functionCalls();
    const call = calls?.[0];
    if (!call) {
      const text = result.response.text?.().slice(0, 300) ?? '';
      throw new Error(`Gemini tidak memulangkan function_call ${text}`);
    }
    // Cetak rough token count jika ada.
    const usage = (result.response as unknown as { usageMetadata?: { totalTokenCount?: number } }).usageMetadata;
    if (usage) console.log(`   ↳ token: ${usage.totalTokenCount}`);
    return call.args as T;
  }
}

// Tukar JSON Schema (Anthropic tool input_schema) kepada Gemini Schema.
// parameters function declaration mesti object, jadi top-level kita cast kepada FunctionDeclarationSchema.
function jsonSchemaToGemini(schema: unknown): Schema {
  const s = schema as Record<string, unknown>;
  const type = (s.type as SchemaType) ?? SchemaType.STRING;
  const base = { type, description: (s.description as string) || undefined } as Schema;

  if (type === SchemaType.OBJECT && s.properties) {
    (base as any).properties = Object.fromEntries(
      Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, jsonSchemaToGemini(v)]),
    );
    if (Array.isArray(s.required)) (base as any).required = s.required as string[];
  } else if (type === SchemaType.ARRAY && s.items) {
    (base as any).items = jsonSchemaToGemini(s.items);
  } else if (Array.isArray(s.enum)) {
    (base as any).enum = s.enum as string[];
  }
  return base;
}
