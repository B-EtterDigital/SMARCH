import fs from "node:fs";
import path from "node:path";

const SCHEMA_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../schemas");
const schemaFiles = fs.readdirSync(SCHEMA_ROOT).filter((file) => file.endsWith(".json")).sort();
const documents = new Map(schemaFiles.map((file) => [file, JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, file), "utf8"))]));
const documentsById = new Map([...documents.values()].map((schema) => [schema.$id, schema]));

const schemaKeywords = new Set([
  "$schema", "$id", "$ref", "$defs", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
  "type", "const", "enum", "allOf", "anyOf", "oneOf", "not", "required", "properties", "additionalProperties", "items",
  "minItems", "maxItems", "uniqueItems", "contains", "minContains", "maxContains", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
]);

function pointer(root, fragment) {
  if (!fragment || fragment === "#") return root;
  if (!fragment.startsWith("#/")) throw new Error(`unsupported reference fragment: ${fragment}`);
  return fragment.slice(2).split("/").reduce((value, token) => value[token.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

export function resolveRef(ref, currentFile) {
  const [filePart, fragment = ""] = ref.split("#", 2);
  let file = currentFile;
  let root = documents.get(file);
  if (filePart) {
    if (documentsById.has(filePart)) root = documentsById.get(filePart);
    else {
      file = path.posix.normalize(path.posix.join(path.posix.dirname(currentFile), filePart));
      root = documents.get(file);
    }
  }
  if (!root) throw new Error(`unresolved schema reference ${ref} from ${currentFile}`);
  return { schema: pointer(root, fragment ? `#${fragment}` : "#"), file };
}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validate(schema, value, currentFile, at = "$") {
  const errors = [];
  if (schema === true) return errors;
  if (schema === false) return [`${at}: schema is false`];
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, currentFile);
    errors.push(...validate(resolved.schema, value, resolved.file, at));
  }
  for (const part of schema.allOf || []) errors.push(...validate(part, value, currentFile, at));
  if (schema.anyOf && !schema.anyOf.some((part) => validate(part, value, currentFile, at).length === 0)) errors.push(`${at}: no anyOf branch matched`);
  if (schema.oneOf && schema.oneOf.filter((part) => validate(part, value, currentFile, at).length === 0).length !== 1) errors.push(`${at}: expected exactly one oneOf match`);
  if (schema.not && validate(schema.not, value, currentFile, at).length === 0) errors.push(`${at}: matched forbidden schema`);
  if (Object.hasOwn(schema, "const") && !equal(value, schema.const)) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((candidate) => equal(candidate, value))) errors.push(`${at}: value is not in enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) return [...errors, `${at}: expected type ${types.join("|")}`];
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: pattern mismatch`);
    if (schema.format === "date-time" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) errors.push(`${at}: invalid date-time`);
    if (schema.format === "uri") { try { new URL(value); } catch { errors.push(`${at}: invalid uri`); } }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${at}: below exclusiveMinimum`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${at}: above exclusiveMaximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than maxItems`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${at}: duplicate items`);
    if (schema.items && typeof schema.items === "object") value.forEach((item, index) => errors.push(...validate(schema.items, item, currentFile, `${at}[${index}]`)));
    if (schema.contains) {
      const matches = value.filter((item, index) => validate(schema.contains, item, currentFile, `${at}[${index}]`).length === 0).length;
      const minimum = schema.minContains ?? 1;
      if (matches < minimum) errors.push(`${at}: contains matched ${matches}, below ${minimum}`);
      if (schema.maxContains !== undefined && matches > schema.maxContains) errors.push(`${at}: contains matched ${matches}, above ${schema.maxContains}`);
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], item, currentFile, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: additional property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties, item, currentFile, `${at}.${key}`));
    }
  }
  return errors;
}

function merge(left, right) {
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const result = { ...left };
    for (const [key, value] of Object.entries(right)) result[key] = merge(result[key], value);
    return result;
  }
  return right === undefined ? left : right;
}

function patterned(pattern, index) {
  if (pattern.includes("[A-Fa-f0-9]")) return "abcdef0";
  if (pattern.includes("\\.(0|")) return "1.0.0";
  if (pattern.includes("[a-z0-9")) return index ? `abc${index}` : "abc";
  if (pattern === "^[a-f0-9]{64}$") return "a".repeat(64);
  return "value";
}

export function example(schema, currentFile, index = 0) {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, currentFile);
    return example(resolved.schema, resolved.file, index);
  }
  let value;
  if (schema.type !== "array") for (const part of schema.allOf || []) value = merge(value, example(part, currentFile, index));
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (schema.enum) return schema.enum[index % schema.enum.length];
  if (value !== undefined) return value;
  const type = Array.isArray(schema.type) ? schema.type.find((candidate) => candidate !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    const result = {};
    for (const key of schema.required || []) result[key] = example(schema.properties?.[key] || {}, currentFile, index);
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (!Object.hasOwn(result, key) && Object.hasOwn(propertySchema, "const")) result[key] = example(propertySchema, currentFile, index);
    }
    return result;
  }
  if (type === "array") {
    const count = Math.max(schema.minItems || 0, 1);
    return Array.from({ length: count }, (_, itemIndex) => example(schema.items || {}, currentFile, itemIndex));
  }
  if (type === "integer" || type === "number") return schema.minimum ?? 0;
  if (type === "boolean") return true;
  if (type === "null") return null;
  if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
  if (schema.format === "uri") return "https://example.com/resource";
  if (schema.pattern) return patterned(schema.pattern, index);
  return "x".repeat(Math.max(schema.minLength || 1, 1));
}

function inspect(schema, currentFile, at = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  for (const key of Object.keys(schema)) {
    if (!schemaKeywords.has(key) && !key.startsWith("x-")) throw new Error(`${currentFile}${at}: unsupported JSON Schema keyword ${key}`);
  }
  if (schema.$ref) resolveRef(schema.$ref, currentFile);
  for (const [key, child] of Object.entries(schema.properties || {})) inspect(child, currentFile, `${at}.properties.${key}`);
  for (const [key, child] of Object.entries(schema.$defs || {})) inspect(child, currentFile, `${at}.$defs.${key}`);
  if (schema.items && typeof schema.items === "object") inspect(schema.items, currentFile, `${at}.items`);
  if (schema.contains) inspect(schema.contains, currentFile, `${at}.contains`);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") inspect(schema.additionalProperties, currentFile, `${at}.additionalProperties`);
  for (const key of ["allOf", "anyOf", "oneOf"]) (schema[key] || []).forEach((child, index) => inspect(child, currentFile, `${at}.${key}[${index}]`));
  if (schema.not) inspect(schema.not, currentFile, `${at}.not`);
}

export function loadSchemas() {
  return new Map(documents);
}

export function assertSupported() {
  for (const [file, schema] of documents) inspect(schema, file);
}
