export type ResultStructureSelector =
  | { kind: "json_pointer"; pointer: string }
  | { kind: "row_field_equals"; field: string; value: string | number | boolean | null }
  | { kind: "log_anchor_window"; anchor: string; before: number; after: number };

export interface StructuredResultMatch {
  start: number;
  end: number;
  text: string;
  anchor: string;
}

export type StructuredSelection =
  | {
      status: "match";
      selectorKind: ResultStructureSelector["kind"];
      matches: StructuredResultMatch[];
      truncated: boolean;
    }
  | { status: "no_match"; selectorKind: ResultStructureSelector["kind"] }
  | { status: "fallback"; selectorKind: ResultStructureSelector["kind"]; reason: "invalid_json" | "unsupported_shape" };

const MAX_MATCHES = 3;
const MAX_STRING_CODE_POINTS = 256;
const MAX_POINTER_CODE_POINTS = 512;
const MAX_FIELD_CODE_POINTS = 128;
const POINTER_SEGMENT = /^(?:[^~]|~[01])*$/u;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function validBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && codePointLength(value) >= 1 && codePointLength(value) <= maximum;
}

export function validateResultStructureSelector(value: unknown): value is ResultStructureSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selector = value as Record<string, unknown>;
  if (selector.kind === "json_pointer") {
    const pointer = selector.pointer;
    return (
      validBoundedString(pointer, MAX_POINTER_CODE_POINTS) &&
      pointer.startsWith("/") &&
      pointer
        .slice(1)
        .split("/")
        .every((segment) => POINTER_SEGMENT.test(segment))
    );
  }
  if (selector.kind === "row_field_equals") {
    return validBoundedString(selector.field, MAX_FIELD_CODE_POINTS) && isPrimitive(selector.value);
  }
  if (selector.kind === "log_anchor_window") {
    return (
      validBoundedString(selector.anchor, MAX_STRING_CODE_POINTS) &&
      Number.isInteger(selector.before) &&
      Number.isInteger(selector.after) &&
      (selector.before as number) >= 0 &&
      (selector.before as number) <= 4 &&
      (selector.after as number) >= 0 &&
      (selector.after as number) <= 4
    );
  }
  return false;
}

interface JsonNode {
  start: number;
  end: number;
  type: "string" | "primitive" | "object" | "array";
  value?: string | number | boolean | null;
  properties?: Map<string, JsonNode>;
  items?: JsonNode[];
}

function parseJsonRanges(source: string): JsonNode {
  let cursor = 0;
  const whitespace = () => {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
  };
  const parseString = (): JsonNode => {
    const start = cursor;
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        const text = source.slice(start, cursor);
        return { start, end: cursor, type: "string", value: JSON.parse(text) as string };
      }
    }
    throw new SyntaxError("unterminated string");
  };
  const parseValue = (): JsonNode => {
    whitespace();
    const start = cursor;
    const character = source[cursor];
    if (character === '"') return parseString();
    if (character === "{") {
      cursor += 1;
      const properties = new Map<string, JsonNode>();
      whitespace();
      if (source[cursor] !== "}") {
        while (true) {
          whitespace();
          if (source[cursor] !== '"') throw new SyntaxError("expected key");
          const key = parseString().value as string;
          whitespace();
          if (source[cursor++] !== ":") throw new SyntaxError("expected colon");
          const value = parseValue();
          if (properties.has(key)) throw new SyntaxError("duplicate key");
          properties.set(key, value);
          whitespace();
          const separator = source[cursor++];
          if (separator === "}") break;
          if (separator !== ",") throw new SyntaxError("expected object separator");
        }
      } else cursor += 1;
      return { start, end: cursor, type: "object", properties };
    }
    if (character === "[") {
      cursor += 1;
      const items: JsonNode[] = [];
      whitespace();
      if (source[cursor] !== "]") {
        while (true) {
          items.push(parseValue());
          whitespace();
          const separator = source[cursor++];
          if (separator === "]") break;
          if (separator !== ",") throw new SyntaxError("expected array separator");
        }
      } else cursor += 1;
      return { start, end: cursor, type: "array", items };
    }
    const primitive = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/uy;
    primitive.lastIndex = cursor;
    const match = primitive.exec(source);
    if (!match) throw new SyntaxError("expected value");
    cursor = primitive.lastIndex;
    return { start, end: cursor, type: "primitive", value: JSON.parse(match[0]) as string | number | boolean | null };
  };

  const root = parseValue();
  whitespace();
  if (cursor !== source.length) throw new SyntaxError("trailing input");
  return root;
}

function exactMatch(source: string, node: { start: number; end: number }, anchor: string): StructuredResultMatch {
  return { start: node.start, end: node.end, text: source.slice(node.start, node.end), anchor };
}

function decodePointer(pointer: string): string[] {
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function selectJsonPointer(
  source: string,
  selector: Extract<ResultStructureSelector, { kind: "json_pointer" }>,
): StructuredSelection {
  const root = parseJsonRanges(source);
  let node: JsonNode | undefined = root;
  for (const segment of decodePointer(selector.pointer)) {
    if (node.type === "object") node = node.properties?.get(segment);
    else if (node.type === "array" && /^(?:0|[1-9]\d*)$/u.test(segment)) node = node.items?.[Number(segment)];
    else node = undefined;
    if (!node) return { status: "no_match", selectorKind: selector.kind };
  }
  return {
    status: "match",
    selectorKind: selector.kind,
    matches: [exactMatch(source, node, "json-value")],
    truncated: false,
  };
}

function selectRows(
  source: string,
  selector: Extract<ResultStructureSelector, { kind: "row_field_equals" }>,
): StructuredSelection {
  const root = parseJsonRanges(source);
  if (root.type !== "array" || !root.items?.every((item) => item.type === "object"))
    return { status: "fallback", selectorKind: selector.kind, reason: "unsupported_shape" };
  const matches: StructuredResultMatch[] = [];
  let total = 0;
  for (let index = 0; index < root.items.length; index += 1) {
    const row = root.items[index];
    const field = row.properties?.get(selector.field);
    if (field && isPrimitive(field.value) && Object.is(field.value, selector.value)) {
      total += 1;
      if (matches.length < MAX_MATCHES) matches.push(exactMatch(source, row, `row:${index}`));
    }
  }
  if (matches.length === 0) return { status: "no_match", selectorKind: selector.kind };
  return { status: "match", selectorKind: selector.kind, matches, truncated: total > MAX_MATCHES };
}

function lineRanges(source: string): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n") continue;
    lines.push({ start, end: index + 1 });
    start = index + 1;
  }
  if (start < source.length || source.length === 0) lines.push({ start, end: source.length });
  return lines;
}

function selectLog(
  source: string,
  selector: Extract<ResultStructureSelector, { kind: "log_anchor_window" }>,
): StructuredSelection {
  const lines = lineRanges(source);
  const matches: StructuredResultMatch[] = [];
  let total = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!source.slice(lines[index].start, lines[index].end).includes(selector.anchor)) continue;
    total += 1;
    if (matches.length < MAX_MATCHES) {
      const first = Math.max(0, index - selector.before);
      const last = Math.min(lines.length - 1, index + selector.after);
      matches.push(exactMatch(source, { start: lines[first].start, end: lines[last].end }, `line:${index + 1}`));
    }
  }
  if (matches.length === 0) return { status: "no_match", selectorKind: selector.kind };
  return { status: "match", selectorKind: selector.kind, matches, truncated: total > MAX_MATCHES };
}

export function selectStructuredResult(source: string, selector: ResultStructureSelector): StructuredSelection {
  try {
    if (selector.kind === "json_pointer") return selectJsonPointer(source, selector);
    if (selector.kind === "row_field_equals") return selectRows(source, selector);
    return selectLog(source, selector);
  } catch {
    return { status: "fallback", selectorKind: selector.kind, reason: "invalid_json" };
  }
}
