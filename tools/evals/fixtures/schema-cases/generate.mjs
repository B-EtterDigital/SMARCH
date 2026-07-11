import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupported, example, loadSchemas, validate } from "./validator.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
assertSupported();

for (const [file, schema] of loadSchemas()) {
  const name = file.replace(/\.json$/, "");
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const valid = example(schema, file);
  if (file === "submission-bundle-schema.json") {
    const roles = ["manifest", "source", "attestation", "checklist"];
    valid.files = roles.map((role, index) => ({ path: `files/${index}-${role}`, role, bytes: 1, sha256: "a".repeat(64) }));
    valid.verification.gates = ["npm run gate:all", "npm run gate:leaks"].map((command) => ({
      command,
      status: 0,
      stdout_sha256: "a".repeat(64),
      stderr_sha256: "a".repeat(64),
    }));
  }
  const validErrors = validate(schema, valid, file);
  if (validErrors.length) throw new Error(`${file} generated invalid fixture:\n${validErrors.join("\n")}`);
  const invalid = structuredClone(valid);
  const required = schema.required || [];
  if (required.length) delete invalid[required[0]];
  else if (file === "capsule-manifest-schema.json") invalid.brick.kind = "module";
  else throw new Error(`${file} has no deterministic invalid mutation`);
  if (validate(schema, invalid, file).length === 0) throw new Error(`${file} invalid mutation still validates`);
  fs.writeFileSync(path.join(directory, "valid.json"), `${JSON.stringify(valid, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "invalid.json"), `${JSON.stringify(invalid, null, 2)}\n`);
}

console.log(`schema fixtures generated: ${loadSchemas().size} contracts`);
