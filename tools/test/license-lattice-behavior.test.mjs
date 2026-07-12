import assert from "node:assert/strict";
import test from "node:test";

import {
  checkComposition,
  classifyLicense,
  combineLicenses,
  meetOpenness,
  meetVisibility,
  opennessRank,
  visibilityRank,
} from "../lib/license-lattice.ts";

test("license classification resolves expressions and unknown inputs fail closed", () => {
  assert.equal(classifyLicense("Apache License, Version 2.0").spdx, "Apache-2.0");
  assert.deepEqual(
    (({ class: cls, openness, copyleft, expression }) => ({ class: cls, openness, copyleft, expression }))(classifyLicense("MIT OR GPL-3.0")),
    { class: "permissive", openness: "open", copyleft: 0, expression: "OR" },
  );
  assert.equal(classifyLicense("MIT AND Proprietary").openness, "closed");
  assert.equal(classifyLicense("GPL-3.0 WITH Classpath-exception-2.0").class, "strong-copyleft");
  assert.equal(classifyLicense("unlisted-license").reason, "unrecognized license token");
  assert.equal(classifyLicense(null).reason, "no license declared");
  assert.equal(opennessRank("invented"), 0);
  assert.equal(visibilityRank("invented"), 0);
  assert.equal(meetOpenness([]), "closed");
  assert.equal(meetVisibility([]), "private");
});

test("license classification rejects identifier suffix attacks", () => {
  for (const token of ["GPL-3.0-only-FAKE", "BSD-NOT-A-LICENSE", "MPL-2.0-NOTREAL"]) {
    const classified = classifyLicense(token);
    assert.equal(classified.class, "unknown", token);
    assert.equal(classified.openness, "closed", token);
  }
});

test("SPDX expression parsing preserves precedence and coherent axes", () => {
  const optionalGpl = classifyLicense("GPL-3.0-only OR MIT");
  assert.deepEqual(
    (({ class: cls, openness, copyleft }) => ({ class: cls, openness, copyleft }))(optionalGpl),
    { class: "permissive", openness: "open", copyleft: 0 },
  );
  const combinedGpl = classifyLicense("MIT AND GPL-3.0-only");
  assert.deepEqual(
    (({ class: cls, openness, copyleft }) => ({ class: cls, openness, copyleft }))(combinedGpl),
    { class: "strong-copyleft", openness: "open", copyleft: 2 },
  );
  const nested = classifyLicense("(GPL-3.0-only OR MIT) AND MPL-2.0");
  assert.deepEqual(
    (({ class: cls, openness, copyleft }) => ({ class: cls, openness, copyleft }))(nested),
    { class: "weak-copyleft", openness: "open", copyleft: 1 },
  );
  assert.equal(classifyLicense("GPL-3.0-only WITH Classpath-exception-2.0").class, "strong-copyleft");
  assert.equal(classifyLicense("GPL-3.0-only WITH Made-Up-Exception").class, "unknown");
});

test("mixed license sets preserve the strongest obligations and surface hard incompatibility", () => {
  const combined = combineLicenses([
    { brick_id: "permissive", spdx: "MIT" },
    { brick_id: "weak", spdx: "LGPL-3.0" },
    { brick_id: "network", spdx: "AGPL-3.0" },
    { brick_id: "closed", spdx: "Proprietary" },
  ]);
  assert.equal(combined.effective_openness, "closed");
  assert.equal(combined.strongest_copyleft, 3);
  assert.equal(combined.copyleft_source, "network");
  assert.equal(combined.attribution_required, true);
  assert.deepEqual(combined.proprietary_components, ["closed"]);
  assert.deepEqual(combined.conflicts.map((entry) => entry.code), ["COPYLEFT_PROPRIETARY_CONFLICT"]);
  assert.deepEqual(combineLicenses([]), {
    effective_openness: "closed",
    strongest_copyleft: 0,
    copyleft_source: null,
    attribution_required: false,
    proprietary_components: [],
    classified: [],
    conflicts: [],
  });
});

test("composition reports every independent escalation and warning", () => {
  const result = checkComposition({
    visibility: "public",
    openness: "open",
    license: "MIT",
    publishable: true,
    has_attribution: false,
    license_tier: "open",
  }, [
    { brick_id: "private-gpl", spdx: "GPL-3.0", openness: "open", visibility: "private" },
    { brick_id: "commercial", spdx: "Proprietary", openness: "closed", visibility: "internal", license_tier: "commercial" },
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(new Set(result.violations.map((entry) => entry.code)), new Set([
    "COMMERCIAL_TIER_WAIVER_REQUIRED",
    "COMMERCIAL_TERMS_MISSING",
    "VISIBILITY_ESCALATION",
    "OPENNESS_ESCALATION",
    "CLOSED_SOURCE_PUBLISH",
    "COPYLEFT_UNDECLARED",
    "ATTRIBUTION_MISSING",
    "COPYLEFT_PROPRIETARY_CONFLICT",
  ]));
  assert.equal(result.effective.visibility, "private");
  assert.equal(result.effective.license_tier, "commercial");
});

test("commercial tier mixing is allowed only with explicit waiver and terms", () => {
  /** @type {Array<{brick_id: string, spdx: string, openness: "closed", visibility: "private", license_tier: "commercial", commercial_terms: string}>} */
  const components = [{
    brick_id: "commercial", spdx: "Proprietary", openness: "closed", visibility: "private",
    license_tier: "commercial", commercial_terms: "paid redistribution grant",
  }];
  const allowed = checkComposition({
    visibility: "private", openness: "closed", license: "Proprietary", publishable: false,
    has_attribution: true, license_tier: "open", commercial_waiver: true,
  }, components);
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.violations, []);
  assert.equal(allowed.effective.license_class, "proprietary");
  assert.equal(allowed.effective.license_tier, "commercial");
});
