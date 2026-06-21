export function formatSchema(schema: unknown, indent = "  "): string {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `${indent}(no schema)`;
  }

  const record = schema as Record<string, unknown>;
  if (record.type === "object" && isRecord(record.properties)) {
    const props = record.properties;
    const required = Array.isArray(record.required) ? record.required.filter((name): name is string => typeof name === "string") : [];
    const entries = Object.entries(props);
    if (entries.length === 0) return `${indent}(no parameters)`;
    return entries.flatMap(([name, prop]) => formatProperty(name, prop, required.includes(name), indent)).join("\n");
  }

  const nested = formatNestedSchema(record, indent);
  if (nested.length > 0) return nested.join("\n");

  const type = formatType(record);
  return type ? `${indent}(${type})` : `${indent}(complex schema)`;
}

function formatProperty(name: string, schema: unknown, required: boolean, indent: string): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${indent}${name}${required ? " *required*" : ""}`];
  }

  const record = schema as Record<string, unknown>;
  const parts = [`${indent}${name}`];
  const type = formatType(record);
  if (type) parts.push(`(${type})`);
  if (required) parts.push("*required*");
  appendAnnotations(parts, record);

  return [parts.join(" "), ...formatNestedSchema(record, `${indent}  `)];
}

function formatNestedSchema(schema: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];
  if (Array.isArray(schema.anyOf)) lines.push(...formatVariants("anyOf", schema.anyOf, indent));
  if (Array.isArray(schema.oneOf)) lines.push(...formatVariants("oneOf", schema.oneOf, indent));
  if (schema.items !== undefined) lines.push(...formatProperty("items", schema.items, false, indent));
  if (isRecord(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
    }
  }
  return lines;
}

function formatVariants(keyword: "anyOf" | "oneOf", variants: unknown[], indent: string): string[] {
  const lines = [`${indent}${keyword}:`];
  for (const variant of variants) {
    if (!variant || typeof variant !== "object" || Array.isArray(variant)) {
      lines.push(`${indent}  - ${JSON.stringify(variant)}`);
      continue;
    }
    const record = variant as Record<string, unknown>;
    const type = formatType(record) || "schema";
    const parts = [`${indent}  - ${type}`];
    appendAnnotations(parts, record);
    lines.push(parts.join(" "));
    lines.push(...formatNestedSchema(record, `${indent}    `));
  }
  return lines;
}

function formatType(schema: Record<string, unknown>): string {
  if (Object.hasOwn(schema, "const")) return `const ${JSON.stringify(schema.const)}`;
  if (Array.isArray(schema.enum)) return `enum: ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  if (Array.isArray(schema.type)) return schema.type.map(String).join(" | ");
  if (schema.type) return String(schema.type);
  if (isRecord(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return "";
}

function appendAnnotations(parts: string[], schema: Record<string, unknown>): void {
  if (typeof schema.description === "string" && schema.description) {
    parts.push(`- ${schema.description}`);
  }
  for (const key of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "format", "pattern"] as const) {
    if (schema[key] !== undefined) parts.push(`[${key}: ${JSON.stringify(schema[key])}]`);
  }
  if (schema.default !== undefined) parts.push(`[default: ${JSON.stringify(schema.default)}]`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
