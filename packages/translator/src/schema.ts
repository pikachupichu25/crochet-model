// Response schemas (docs/SPEC.md §5.4). Sent as `output_config.format`, so the
// reply is guaranteed to be JSON of this shape unless it was cut off or
// refused; it is still parsed with zod, the same way for live and batch
// requests.

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const RowResponse = z.object({
  /** CrochetPARADE for the target row only; "" when it makes no stitches. */
  cp: z.string(),
  expectedCount: z.number().int().nullable(),
  /** high, medium or low; a plain string because the format cannot carry the enum. */
  confidence: z.string(),
  assumptions: z.array(z.string()),
  question: z
    .object({
      text: z.string(),
      options: z.array(z.object({ label: z.string(), cp: z.string().nullable() })),
    })
    .nullable(),
  /** Earlier rows rewritten only to add labels this row needs. */
  amendPrevious: z.array(z.object({ rowId: z.string(), cp: z.string() })),
});
export type RowResponse = z.infer<typeof RowResponse>;

export type Confidence = "high" | "medium" | "low";

export function confidenceOf(value: string): Confidence {
  const v = value.trim().toLowerCase();
  return v === "high" || v === "medium" ? v : "low";
}

/** Whole-pattern mode: every row in one response, as Dias & Karim did. */
export const WholeResponse = z.object({
  rows: z.array(z.object({ rowId: z.string(), cp: z.string() })),
  assumptions: z.array(z.string()),
});
export type WholeResponse = z.infer<typeof WholeResponse>;

/** Document mode: the whole pattern as one CrochetPARADE text, with `# label` comments. */
export const DocumentResponse = z.object({
  cp: z.string(),
  assumptions: z.array(z.string()),
});
export type DocumentResponse = z.infer<typeof DocumentResponse>;

/**
 * The JSON schema for `output_config.format`. The SDK helper removes keywords
 * structured outputs do not support; its `parse` function is dropped so the
 * format can also go into a batch request as plain JSON.
 */
export function outputFormat(schema: z.ZodType): { type: "json_schema"; schema: Record<string, unknown> } {
  const { type, schema: json } = zodOutputFormat(schema);
  return { type, schema: json };
}

/**
 * The same schema in the part of JSON Schema every provider takes (SPEC
 * §5.4): a type list such as `["string", "null"]` becomes an `anyOf`.
 */
export function portableSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(portableSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) out[key] = portableSchema(value);
  if (Array.isArray(out.type)) {
    const { type, ...rest } = out;
    return { ...rest, anyOf: (type as string[]).map((t) => ({ type: t })) };
  }
  return out;
}
