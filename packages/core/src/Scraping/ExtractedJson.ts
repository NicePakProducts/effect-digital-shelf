import * as Predicate from "effect/Predicate"
import type { ExtractionErrorCode } from "@digital-shelf/domain/Scraping/Vocabulary"
import * as Data from "effect/Data"
import * as Cause from "effect/Cause"
import * as Schema from "effect/Schema"
import * as AiError from "effect/unstable/ai/AiError"
import { jsonrepair } from "jsonrepair"

export const isJsonObject = (
  value: unknown,
): value is Record<string, Schema.Json> =>
  Schema.is(Schema.Record(Schema.String, Schema.Json))(value) &&
  Object.getPrototypeOf(value) === Object.prototype

type ParseResult =
  | { _tag: "object"; value: Record<string, Schema.Json> }
  | {
      _tag: "failed"
      code: "json_mode_unmet" | "invalid_json"
      message: string
    }

const ParseResult = Data.taggedEnum<ParseResult>()

export const parseExtractedJson = (
  text: string,
  finishReason: string,
): ParseResult => {
  if (finishReason === "length" || text.trim() === "")
    return ParseResult.failed({
      code: "json_mode_unmet",
      message: "Model returned empty or truncated content",
    })
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    try {
      value = JSON.parse(jsonrepair(text))
    } catch {
      return ParseResult.failed({
        code: "invalid_json",
        message: "Model content is not valid JSON after repair",
      })
    }
  }

  return isJsonObject(value)
    ? ParseResult.object({ value })
    : ParseResult.failed({
        code: "invalid_json",
        message: "Model content must be a JSON object",
      })
}

type ExtractionFailure = { code: ExtractionErrorCode; message: string }

export const classifyExtractionError = (cause: unknown): ExtractionFailure => {
  if (Cause.isTimeoutError(cause))
    return { code: "llm_timeout", message: "Extraction deadline exceeded" }

  if (AiError.isAiError(cause)) {
    const reason = cause.reason

    const overflow =
      Predicate.isTagged(reason, "InvalidRequestError") &&
      /5021|context (window|length)|too long/i.test(
        `${reason.description ?? ""} ${reason.http?.body ?? ""}`,
      )

    return {
      code: overflow ? "context_overflow" : "provider_error",
      message: cause.message,
    }
  }

  return {
    code: "unknown",
    message: cause instanceof Error ? cause.message : String(cause),
  }
}
