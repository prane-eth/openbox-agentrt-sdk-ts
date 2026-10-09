// Extraction/redaction helpers over Agent-RT `ModelMessage` sequences.
//
// Pure and structural: `agent-rt` is imported for TYPES only (erased at build),
// so this module keeps the package root import-light.

import { asFiniteNumber } from "./property-access.js";
import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";
import type { ModelMessage, ModelResponse } from "agent-rt";

export function messageText(message: ModelMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** Text of the most recent user turn ("" when there is none). */
export function extractLastUserText(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") return messageText(message);
  }
  return "";
}

/** Normalize `GuardrailsResult.redactedInput` to plain text, or null. */
export function coerceRedactedText(redactedInput: unknown): string | null {
  if (typeof redactedInput === "string") return redactedInput || null;
  if (Array.isArray(redactedInput) && redactedInput.length > 0) {
    const first: unknown = redactedInput[0];
    if (typeof first === "string") return first || null;
    if (typeof first === "object" && first !== null) {
      const rec = first as Record<string, unknown>;
      const text = rec.prompt ?? rec.text;
      return typeof text === "string" && text ? text : null;
    }
  }
  return null;
}

/**
 * Return `messages` with the last user turn's text replaced by the redacted
 * text (non-text parts are kept). Never mutates the input history.
 */
export function applyRedaction(
  messages: readonly ModelMessage[],
  redactedInput: unknown
): ModelMessage[] {
  const text = coerceRedactedText(redactedInput);
  const out = [...messages];
  if (text === null) return out;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const message = out[i];
    if (message?.role === "user") {
      const extras = message.content.filter((part) => part.type !== "text");
      out[i] = { ...message, content: [{ type: "text", text }, ...extras] };
      break;
    }
  }
  return out;
}

/** `{llm_model, input_tokens, ...}` — snake_case keys, they feed the wire `result`. */
export function extractResponseMetadata(
  response: ModelResponse
): Record<string, JsonValue> {
  const usage = response.usage;
  return {
    llm_model: response.model ?? null,
    input_tokens: asFiniteNumber(usage?.inputTokens),
    output_tokens: asFiniteNumber(usage?.outputTokens),
    total_tokens: asFiniteNumber(usage?.totalTokens),
    completion: messageText(response.message) || null,
    has_tool_calls: (response.message.toolCalls?.length ?? 0) > 0,
    finish_reason: response.finishReason ?? null
  };
}
