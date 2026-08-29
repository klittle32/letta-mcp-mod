interface RenderedCallToolResult {
  text: string;
  isError: boolean;
}

export function renderCallToolResult(result: unknown): RenderedCallToolResult {
  const record = isRecord(result) ? result : {};
  const parts: string[] = [];
  const content = Array.isArray(record.content) ? record.content : [];

  for (const block of content) {
    const rendered = renderToolContentBlock(block);
    if (rendered) parts.push(rendered);
  }

  if ("structuredContent" in record && record.structuredContent !== undefined) {
    parts.push(["Structured content:", renderJson(record.structuredContent)].join("\n"));
  }

  return {
    text: parts.length > 0 ? parts.join("\n\n") : "(no content)",
    isError: record.isError === true,
  };
}

export function renderReadResourceResult(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const contents = Array.isArray(record.contents) ? record.contents : [];
  const multiple = contents.length > 1;
  const parts = contents.map((content) => renderResourceContent(content, multiple)).filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : "(no resource content)";
}

function renderToolContentBlock(block: unknown): string {
  if (!isRecord(block)) return renderJson(block);
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "image":
      return `[image content: ${typeof block.mimeType === "string" ? block.mimeType : "unknown MIME"}, ${base64Length(block.data)} chars base64]`;
    case "audio":
      return `[audio content: ${typeof block.mimeType === "string" ? block.mimeType : "unknown MIME"}, ${base64Length(block.data)} chars base64]`;
    case "resource":
      return renderResourceContent(block.resource, true);
    case "resource_link": {
      const name = typeof block.name === "string" ? block.name : "unnamed";
      const uri = typeof block.uri === "string" ? block.uri : "unknown URI";
      const mime = typeof block.mimeType === "string" ? ` (${block.mimeType})` : "";
      return `[resource link: ${name} ${uri}${mime}]`;
    }
    default:
      return renderJson(block);
  }
}

function renderResourceContent(content: unknown, includeHeading: boolean): string {
  if (!isRecord(content)) return renderJson(content);
  const uri = typeof content.uri === "string" ? content.uri : "unknown URI";
  const mime = typeof content.mimeType === "string" ? content.mimeType : undefined;
  if (typeof content.text === "string") {
    if (!includeHeading) return content.text;
    return [`Resource: ${uri}${mime ? ` (${mime})` : ""}`, content.text].join("\n");
  }
  if (typeof content.blob === "string") {
    return `[blob content: ${uri}${mime ? ` (${mime})` : ""}, ${content.blob.length} chars base64]`;
  }
  return renderJson(content);
}

function renderJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function base64Length(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
