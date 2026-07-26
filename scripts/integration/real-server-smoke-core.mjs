import { createHash } from "node:crypto";

export function parseJsonTextBlock(result) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") {
    throw new Error("Expected the first result block to contain JSON text");
  }
  return JSON.parse(block.text);
}

export function describeResult(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    content_types: content.map((block) => block.type),
    content_blocks: content.length,
    has_structured_content: result.structuredContent !== undefined,
    has_meta: result._meta !== undefined,
    is_error: result.isError === true,
    serialized_chars: JSON.stringify(result).length,
  };
}

export async function recoverCapturedResult(client, delivered) {
  let envelope;
  try {
    envelope = parseJsonTextBlock(delivered);
  } catch {
    return {
      compressed: false,
      result: delivered,
      read_result_calls: 0,
      snapshot_sha256: createHash("sha256").update(JSON.stringify(delivered)).digest("hex"),
    };
  }

  if (typeof envelope.result_ref !== "string") {
    return {
      compressed: false,
      result: delivered,
      read_result_calls: 0,
      snapshot_sha256: createHash("sha256").update(JSON.stringify(delivered)).digest("hex"),
    };
  }

  let cursor = 0;
  let readResultCalls = 0;
  let payload = "";
  const seenCursors = new Set();
  while (true) {
    if (seenCursors.has(cursor)) throw new Error(`read_result repeated cursor ${cursor}`);
    seenCursors.add(cursor);

    const chunk = await client.callTool({
      name: "read_result",
      arguments: { result_ref: envelope.result_ref, cursor },
    });
    const payloadBlock = chunk.content?.[0];
    const metadataBlock = chunk.content?.[1];
    if (!payloadBlock || payloadBlock.type !== "text" || !metadataBlock || metadataBlock.type !== "text") {
      throw new Error("read_result did not return payload and metadata text blocks");
    }
    const metadata = JSON.parse(metadataBlock.text);
    payload += payloadBlock.text;
    readResultCalls += 1;
    if (metadata.done === true) break;
    if (!Number.isInteger(metadata.next_cursor) || metadata.next_cursor <= cursor) {
      throw new Error("read_result returned an invalid next_cursor");
    }
    cursor = metadata.next_cursor;
  }

  const result =
    envelope.encoding === "single-text-v1"
      ? {
          content: [{ type: "text", text: payload }],
          ...(envelope.result_shape ?? {}),
        }
      : JSON.parse(payload);

  return {
    compressed: true,
    result,
    read_result_calls: readResultCalls,
    result_ref: envelope.result_ref,
    encoding: envelope.encoding,
    content_kind: envelope.content_kind,
    projection: envelope.projection,
    original_chars: envelope.original_chars,
    payload_chars: envelope.payload_chars,
    preview_chars: envelope.preview_chars,
    snapshot_sha256: createHash("sha256").update(payload).digest("hex"),
  };
}

export function assertThreeToolSurface(listed) {
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = ["call_tool", "find_tool", "read_result"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected Slim Guard tool surface: ${names.join(", ")}`);
  }
  return names;
}
