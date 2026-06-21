export interface RenderOptions {
  maxTextChars?: number;
  maxJsonChars?: number;
}

interface RenderedCallToolResult {
  text: string;
  isError: boolean;
}

const DEFAULT_MAX_TEXT_CHARS = 20_000;
const DEFAULT_MAX_JSON_CHARS = 8_000;

export function renderCallToolResult(result: unknown, options: RenderOptions = {}): RenderedCallToolResult {
  const record = isRecord(result) ? result : {};
  const parts: string[] = [];
  const content = Array.isArray(record.content) ? record.content : [];

  for (const block of content) {
    const rendered = renderToolContentBlock(block, options);
    if (rendered) parts.push(rendered);
  }

  if ("structuredContent" in record && record.structuredContent !== undefined) {
    parts.push(["Structured content:", renderJson(record.structuredContent, options)].join("\n"));
  }

  return {
    text: parts.length > 0 ? parts.join("\n\n") : "(no content)",
    isError: record.isError === true,
  };
}

export function renderReadResourceResult(result: unknown, options: RenderOptions = {}): string {
  const record = isRecord(result) ? result : {};
  const contents = Array.isArray(record.contents) ? record.contents : [];
  const multiple = contents.length > 1;
  const parts = contents.map((content) => renderResourceContent(content, options, multiple)).filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : "(no resource content)";
}

function renderToolContentBlock(block: unknown, options: RenderOptions): string {
  if (!isRecord(block)) return renderJson(block, options);
  switch (block.type) {
    case "text":
      return truncateText(typeof block.text === "string" ? block.text : "", options);
    case "image":
      return `[image content: ${typeof block.mimeType === "string" ? block.mimeType : "unknown MIME"}, ${base64Length(block.data)} chars base64]`;
    case "audio":
      return `[audio content: ${typeof block.mimeType === "string" ? block.mimeType : "unknown MIME"}, ${base64Length(block.data)} chars base64]`;
    case "resource":
      return renderResourceContent(block.resource, options, true);
    case "resource_link": {
      const name = typeof block.name === "string" ? block.name : "unnamed";
      const uri = typeof block.uri === "string" ? block.uri : "unknown URI";
      const mime = typeof block.mimeType === "string" ? ` (${block.mimeType})` : "";
      return `[resource link: ${name} ${uri}${mime}]`;
    }
    default:
      return renderJson(block, options);
  }
}

function renderResourceContent(content: unknown, options: RenderOptions, includeHeading: boolean): string {
  if (!isRecord(content)) return renderJson(content, options);
  const uri = typeof content.uri === "string" ? content.uri : "unknown URI";
  const mime = typeof content.mimeType === "string" ? content.mimeType : undefined;
  if (typeof content.text === "string") {
    const renderedText = truncateText(content.text, options);
    if (!includeHeading) return renderedText;
    return [`Resource: ${uri}${mime ? ` (${mime})` : ""}`, renderedText].join("\n");
  }
  if (typeof content.blob === "string") {
    return `[blob content: ${uri}${mime ? ` (${mime})` : ""}, ${content.blob.length} chars base64]`;
  }
  return renderJson(content, options);
}

function renderJson(value: unknown, options: RenderOptions): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2);
  } catch {
    json = String(value);
  }
  return truncate(json, options.maxJsonChars ?? DEFAULT_MAX_JSON_CHARS);
}

function truncateText(value: string, options: RenderOptions): string {
  return truncate(value, options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n[truncated ${omitted} characters]`;
}

function base64Length(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
