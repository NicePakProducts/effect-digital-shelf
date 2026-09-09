import type { ExtractionErrorCode } from "@digital-shelf/domain/Scraping/Vocabulary"
import * as Cause from "effect/Cause"
import * as Schema from "effect/Schema"
import * as AiError from "effect/unstable/ai/AiError"
import { jsonrepair } from "jsonrepair"

export const isJsonObject = (
  value: unknown,
): value is Record<string, Schema.Json> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Schema.is(Schema.Json)(value)

type ParseResult =
  | { _tag: "object"; value: Record<string, Schema.Json> }
  | {
      _tag: "failed"
      code: "json_mode_unmet" | "invalid_json"
      message: string
    }
export const parseExtractedJson = (
  text: string,
  finishReason: string,
): ParseResult => {
  if (finishReason === "length" || text.trim() === "")
    return {
      _tag: "failed",
      code: "json_mode_unmet",
      message: "Model returned empty or truncated content",
    }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    try {
      value = JSON.parse(jsonrepair(text))
    } catch {
      return {
        _tag: "failed",
        code: "invalid_json",
        message: "Model content is not valid JSON after repair",
      }
    }
  }
  return isJsonObject(value)
    ? { _tag: "object", value }
    : {
        _tag: "failed",
        code: "invalid_json",
        message: "Model content must be a JSON object",
      }
}
export const classifyExtractionError = (
  error: unknown,
): { code: ExtractionErrorCode; message: string } => {
  if (Cause.isTimeoutError(error))
    return { code: "llm_timeout", message: "Extraction deadline exceeded" }
  if (AiError.isAiError(error)) {
    const reason = error.reason
    const overflow =
      reason._tag === "InvalidRequestError" &&
      /5021|context (window|length)|too long/i.test(
        `${reason.description ?? ""} ${reason.http?.body ?? ""}`,
      )
    return {
      code: overflow ? "context_overflow" : "provider_error",
      message: error.message,
    }
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
  }
}
