/**
 * WHAT: Writes generated files only when their meaningful content changes.
 * WHY: Timestamp churn creates false dirty work, noisy diffs, and avoidable shared-path contention.
 * HOW: Normalizers remove volatile fields before comparison while preserving full written output.
 * OUTPUTS: Returns whether a text or structured file was written and provides stable normalizers.
 * CALLERS: Registry, state, and dashboard generators use these helpers before replacing artifacts.
 * @example
 * await writeJsonIfMeaningfulChanged("state.json", state, { normalize: normalizeSmaStateSnapshot });
 * Glossary: [SMA](../../docs/GLOSSARY.md).
 */
import fs from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type JsonRecord = Record<string, any>;
type WriteResult = { written: boolean; path: string };
type Normalizer<T> = (item: T) => unknown;

export async function writeJsonIfMeaningfulChanged<T>(filePath: string, value: T, {
  normalize = (item: T) => item,
}: { normalize?: Normalizer<T> } = {}): Promise<WriteResult> {
  const nextText = `${JSON.stringify(value, null, 2)}\n`;
  const nextComparable = comparableJson(normalize(value));
  if (existsSync(filePath)) {
    try {
      const previousText = readFileSync(filePath, 'utf8');
      const previous = JSON.parse(previousText);
      if (comparableJson(normalize(previous)) === nextComparable) {
        return { written: false, path: filePath };
      }
    } catch (error) {
      console.error('[stable-generated] regenerating unreadable JSON artifact', { filePath, error });
      // Regenerate corrupt or non-JSON artifacts.
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nextText);
  return { written: true, path: filePath };
}

export function writeTextIfChanged(filePath: string, text: string): WriteResult {
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, 'utf8') === text) {
        return { written: false, path: filePath };
      }
    } catch (error) {
      console.error('[stable-generated] regenerating unreadable text artifact', { filePath, error });
      // Regenerate unreadable artifacts.
    }
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, text);
  return { written: true, path: filePath };
}

export function normalizeSmaStateSnapshot(snapshot: JsonRecord): JsonRecord {
  const clone = jsonClone(snapshot);
  if (clone && typeof clone === 'object') {
    clone.generated_at = '<generated_at>';
    if (clone.gen3?.leases) {
      clone.gen3.leases.generated_at = '<lease_registry_generated_at>';
      if (Array.isArray(clone.gen3.leases.sample)) {
        clone.gen3.leases.sample = clone.gen3.leases.sample.map(stableLease);
      }
    }
  }
  return clone;
}

export function normalizeRegistrySnapshot(snapshot: JsonRecord): JsonRecord {
  const clone = jsonClone(snapshot);
  if (clone && typeof clone === 'object') {
    clone.generated_at = '<generated_at>';
  }
  return clone;
}

export function stableLease(lease: JsonRecord): JsonRecord {
  if (!lease || typeof lease !== 'object') return lease;
  const clone = { ...lease };
  delete clone.expires_at;
  delete clone.ttl_remaining_seconds;
  return clone;
}

function comparableJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function jsonClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
