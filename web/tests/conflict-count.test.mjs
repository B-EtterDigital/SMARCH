import assert from "node:assert/strict";
import test from "node:test";
import { countConflicts30d } from "../src/lib/conflict-count.ts";

test("returns zero for empty or malformed conflict payloads", () => {
  assert.equal(countConflicts30d(undefined), 0);
  assert.equal(countConflicts30d({}), 0);
  assert.equal(countConflicts30d({ conflicts: [], stats: {} }), 0);
});

test("uses the complete populated 30-day count and guards malformed stats", () => {
  const conflicts = [{ event_id: "one" }, { event_id: "two" }];
  assert.equal(countConflicts30d({ conflicts, stats: { matching: 7 } }), 7);
  assert.equal(countConflicts30d({ conflicts, stats: { matching: Number.NaN } }), 2);
});
