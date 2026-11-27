import { z } from "zod";

export type Usage = { promptTokens: number | null; completionTokens: number | null };

const usageSchema = z.object({
  usage: z.object({ prompt_tokens: z.number().int().nonnegative().optional(), completion_tokens: z.number().int().nonnegative().optional() }).nullable().optional(),
});

export const NO_USAGE: Usage = { promptTokens: null, completionTokens: null };

/** Usage from one OpenAI-style JSON object (a full response or one stream chunk), or null when it has none. */
export function usageOf(value: unknown): Usage | null {
  const parsed = usageSchema.safeParse(value);
  const usage = parsed.success ? parsed.data.usage : null;
  if (!usage) return null;
  return { promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null };
}

/**
 * Pass a server-sent-event stream through unchanged while watching its
 * `data:` lines for a usage object. `onDone` runs once with the last usage
 * seen, after the stream ends or fails.
 */
export function watchStreamUsage(onDone: (usage: Usage, completed: boolean) => Promise<void>): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage = NO_USAGE;
  let sawDone = false;

  const scan = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    try {
      usage = usageOf(JSON.parse(data)) ?? usage;
    } catch {
      // Not JSON; forward it untouched.
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) scan(line.trim());
    },
    async flush() {
      if (buffer) scan(buffer.trim());
      await onDone(usage, sawDone);
    },
  });
}
