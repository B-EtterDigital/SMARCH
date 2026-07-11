/**
 * WHAT: Declares the reusable European and Swiss compliance controls checked before release.
 * WHY: Projects need one auditable catalog so legal obligations cannot disappear between separate gate implementations.
 * HOW: The compliance gate supplies repository context to each detector and receives status, evidence, and remediation.
 * Each entry carries a stable identifier, regulation, severity, human requirement, detector, and repair guidance.
 * Adding or changing an obligation is therefore a catalog edit rather than hidden checker logic.
 * Regulation abbreviations are defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { COMPLIANCE_CONTROLS } from './tools/lib/compliance-controls.ts'; console.log(COMPLIANCE_CONTROLS.map(c => c.id))"
 */
/**
 * complianceControls.mjs — declarative EU/Swiss compliance control catalog.
 *
 * THE REUSABLE SMA COMPLIANCE LAYER. This catalog is the single source of truth
 * for the data-protection (GDPR / Swiss nFADP), platform-safety (EU DSA), and
 * child-protection (EU CSAM Reg.) controls every SMA project must satisfy
 * before release. The checker (`sma-compliance.mjs`) evaluates each control's
 * `detect()` against the repo and reports COVERED / PARTIAL / MISSING.
 *
 * FROM DAY ONE: drop this file (+ the checker) into any SMA project and the
 * release gate immediately enumerates every obligation — red until the control
 * lands, green when its evidence appears. Adding/removing an obligation is one
 * array entry.
 *
 * Each control:
 *   id          stable id
 *   regulation  ['GDPR Art.17','nFADP','DSA Art.16','CSAM Reg.', …]
 *   title       short human requirement
 *   severity    'blocker' (fails release) | 'required' (fails strict) | 'advisory'
 *   detect(ctx) → { status:'covered'|'partial'|'missing', evidence?, note? }
 *   remediation what to build if missing
 *
 * `ctx` provides repo helpers: { repoRoot, fileExists, readFile, grep, hasScript }.
 */

type ComplianceHit = { file: string; line: string };
type ComplianceContext = {
  fileExists(path: string): boolean;
  readFile(path: string): string;
  grep(paths: string[], pattern: RegExp): ComplianceHit[];
  hasScript?(name: string): boolean;
};
type ComplianceStatus = 'covered' | 'partial' | 'missing';
type ComplianceResult = { status: ComplianceStatus; evidence?: string; note?: string };
type ComplianceControl = {
  id: string;
  regulation: string[];
  title: string;
  severity: 'blocker' | 'required' | 'advisory';
  remediation: string;
  detect(ctx: ComplianceContext): ComplianceResult;
};

export const COMPLIANCE_CONTROLS: ComplianceControl[] = [
  // ── Data-subject rights (GDPR Ch.III + Swiss nFADP) ──────────────────────
  {
    id: 'dsr-export',
    regulation: ['GDPR Art.15', 'GDPR Art.20', 'nFADP Art.25'],
    title: 'Right of access & data portability — user can export all their data',
    severity: 'blocker',
    remediation: 'Add an authenticated edge function that returns a complete export of the caller\'s data (machine-readable). See supabase/functions/dsr-export.',
    detect: (ctx) => {
      const fn = ctx.fileExists('supabase/functions/dsr-export/index.ts');
      const ui = ctx.grep(['src/renderer'], /dsr[-_]?export|exportMyData|downloadMyData|data[-_]?export/i);
      if (fn && ui.length) return { status: 'covered', evidence: 'dsr-export fn + UI entry point' };
      if (fn) return { status: 'partial', note: 'export function exists but no user-facing entry point found' };
      return { status: 'missing' };
    },
  },
  {
    id: 'dsr-erasure',
    regulation: ['GDPR Art.17', 'nFADP Art.32'],
    title: 'Right to erasure — user can delete their account and all data',
    severity: 'blocker',
    remediation: 'Add an authenticated edge function that hard-deletes (or fully anonymises) all of the caller\'s rows across every table + storage objects. See supabase/functions/dsr-erase.',
    detect: (ctx) => {
      const fn = ctx.fileExists('supabase/functions/dsr-erase/index.ts');
      const ui = ctx.grep(['src/renderer'], /dsr[-_]?erase|deleteMyAccount|deleteAccount|right[-_]?to[-_]?erasure/i);
      if (fn && ui.length) return { status: 'covered', evidence: 'dsr-erase fn + UI entry point' };
      if (fn) return { status: 'partial', note: 'erase function exists but no user-facing entry point found' };
      return { status: 'missing' };
    },
  },
  {
    id: 'consent-ledger',
    regulation: ['GDPR Art.7', 'nFADP Art.6', 'DSA'],
    title: 'Consent is recorded with timestamp + version and is withdrawable',
    severity: 'required',
    remediation: 'Persist consent events (purpose, version, granted_at, withdrawn_at). A consent_events table + a recordConsent helper.',
    detect: (ctx) => {
      const mig = ctx.grep(['supabase/migrations'], /consent[_-]?events|consent_ledger|user_consents/i);
      const code = ctx.grep(['src', 'supabase/functions'], /recordConsent|consentLedger|consent_events/i);
      if (mig.length && code.length) return { status: 'covered', evidence: 'consent table + recorder' };
      if (mig.length || code.length) return { status: 'partial' };
      return { status: 'missing' };
    },
  },
  {
    id: 'privacy-policy',
    regulation: ['GDPR Art.13/14', 'nFADP Art.19', 'DSA Art.14'],
    title: 'Privacy policy / processing notice & terms are present and linked',
    severity: 'required',
    remediation: 'Ship a privacy policy + terms (PRIVACY.md / a hosted page) and link them from onboarding/settings.',
    detect: (ctx) => {
      const doc = ctx.fileExists('PRIVACY.md') || ctx.fileExists('docs/PRIVACY.md') || ctx.fileExists('legal/privacy.md');
      const link = ctx.grep(['src/renderer', 'website'], /privacy[-_ ]?policy|\/privacy|privacyUrl/i);
      if (doc && link.length) return { status: 'covered' };
      if (doc || link.length) return { status: 'partial', note: doc ? 'policy doc present, no link found' : 'link present, no policy doc' };
      return { status: 'missing' };
    },
  },
  {
    id: 'data-minimization-ip',
    regulation: ['GDPR Art.5(1)(c)', 'nFADP Art.6'],
    title: 'No unnecessary exposure of personal data (e.g. P2P IP leakage)',
    severity: 'required',
    remediation: 'Force WebRTC relay (TURN) for private/unlisted sessions so peer IPs are not disclosed by default.',
    detect: (ctx) => {
      const relay = ctx.grep(['src/renderer/modules/modlink'], /turnOnly\s*:\s*true|forceRelay|relayForPrivate|iceTransportPolicy.*relay/i);
      return relay.length ? { status: 'covered' } : { status: 'missing', note: 'private sessions default to iceTransportPolicy "all" — peer IP disclosed' };
    },
  },

  // ── Platform safety / DSA ─────────────────────────────────────────────────
  {
    id: 'notice-and-action',
    regulation: ['DSA Art.16'],
    title: 'Functional notice-and-action reporting (no dark-pattern fake buttons)',
    severity: 'blocker',
    remediation: 'Every "report" affordance must POST to a real moderation endpoint and persist; no toast-only buttons.',
    detect: (ctx) => {
      const fn = ctx.fileExists('supabase/functions/modlink-user-report/index.ts');
      // Dark pattern: a report button that only shows a toast and writes nothing.
      const fake = ctx.grep(['src/renderer'], /moderators will review|report received/i)
        .filter((h) => !/invoke|functions\.invoke|fetch\(|reportProfile|profileReportService/i.test(h.line));
      if (fn && fake.length === 0) return { status: 'covered', evidence: 'report fn + no fake report toasts' };
      if (fn) return { status: 'partial', note: `report fn exists but ${fake.length} toast-only "report" affordance(s) found` };
      return { status: 'missing' };
    },
  },
  {
    id: 'safety-categories',
    regulation: ['DSA Art.16', 'CSAM Reg.'],
    title: 'Reporting taxonomy includes child-safety / CSAM / self-harm',
    severity: 'blocker',
    remediation: 'Declarative safety policy must include csam/child_safety/self_harm categories with critical priority + escalation.',
    detect: (ctx) => {
      const policy = ctx.fileExists('supabase/functions/_shared/safetyPolicy.ts');
      const hasCsam = policy && /["']csam["']/.test(ctx.readFile('supabase/functions/_shared/safetyPolicy.ts'));
      const hasChild = policy && /child_safety/.test(ctx.readFile('supabase/functions/_shared/safetyPolicy.ts'));
      if (policy && hasCsam && hasChild) return { status: 'covered' };
      if (policy) return { status: 'partial', note: 'policy exists but missing csam/child_safety' };
      return { status: 'missing' };
    },
  },
  {
    id: 'moderation-queue',
    regulation: ['DSA Art.16/17'],
    title: 'Reports reach a triageable moderation queue (a consumer exists)',
    severity: 'required',
    remediation: 'A priority-ordered moderation surface (admin dashboard or function) that reads user reports; reports must not land in a write-only table.',
    detect: (ctx) => {
      const triage = ctx.grep(['supabase/migrations'], /priority.*modlink_user_reports|modlink_user_reports.*priority|idx_modlink_user_reports/i);
      const dash = ctx.grep(['src/renderer', 'supabase/functions'], /moderation[-_ ]?dashboard|moderationQueue|modlink-moderation-queue|reviewReports/i);
      if (triage.length && dash.length) return { status: 'covered' };
      if (triage.length) return { status: 'partial', note: 'triage priority exists but no moderation queue consumer/UI' };
      return { status: 'missing' };
    },
  },
  {
    id: 'statement-of-reasons',
    regulation: ['DSA Art.17'],
    title: 'Moderation decisions produce a statement of reasons to the user',
    severity: 'advisory',
    remediation: 'On a moderation action, record + notify the affected user with the reason and appeal path (modlink_moderation_events + appeals exist; wire the notice).',
    detect: (ctx) => {
      const events = ctx.grep(['supabase/migrations'], /modlink_moderation_events/i);
      const appeals = ctx.grep(['supabase/functions'], /moderation[-_]?appeal/i);
      if (events.length && appeals.length) return { status: 'covered' };
      if (events.length) return { status: 'partial' };
      return { status: 'missing' };
    },
  },

  // ── Child protection / CSAM ──────────────────────────────────────────────
  {
    id: 'csam-scanning',
    regulation: ['EU CSAM Reg.', 'DSA'],
    title: 'Stored/served media (recordings, uploads) is CSAM/abuse-scanned',
    severity: 'blocker',
    remediation: 'Scan recordings + uploads (hash-match + classifier) before they can be served/made public. A scan hook with a provider; report+preserve matches.',
    detect: (ctx) => {
      const hook = ctx.grep(['supabase/functions'], /csamScan|photodnaScan|scanMedia|contentScan|ncmec/i);
      const flag = ctx.grep(['supabase/functions', 'src'], /MEDIA_SCAN_PROVIDER|csamScanProvider|scanConfigured/i);
      if (hook.length && flag.length) return { status: 'covered' };
      if (hook.length || flag.length) return { status: 'partial', note: 'scan hook scaffolded; provider enrollment (PhotoDNA/NCMEC) is an operator step' };
      return { status: 'missing' };
    },
  },
  {
    id: 'age-assurance',
    regulation: ['GDPR Art.8', 'nFADP', 'DSA Art.28'],
    title: 'Age assurance gate for minor-accessible features (enforced, not write-only)',
    severity: 'required',
    remediation: 'Enforce a minimum-age / age-assurance check on join paths for live A/V and DMs; do not store min_age write-only.',
    detect: (ctx) => {
      // Require real enforcement primitives, not gate-kind labels like 'age-gated'.
      const enforce = ctx.grep(['supabase/functions', 'src/renderer/modules/modlink'], /enforceMinAge|ageAssurance|verifyAge|age_verified|assertAge/i);
      return enforce.length ? { status: 'covered' } : { status: 'missing', note: 'min_age is self-attested and never enforced on join' };
    },
  },

  // ── Security baseline (supports all of the above) ────────────────────────
  {
    id: 'rls-no-world-read',
    regulation: ['GDPR Art.32', 'nFADP Art.8'],
    title: 'No private per-user table is world-readable (RLS owner-scoped)',
    severity: 'blocker',
    remediation: 'Drop USING(true) SELECT policies on tables with an owner column; scope to auth.uid(). Audited via the management API.',
    detect: (ctx) => {
      // Static evidence: the audit/migration that closed the world-readable policies.
      const mig = ctx.grep(['supabase/migrations'], /world[_-]?readable|drop_world_readable|read_transcriptions|owner[_-]?scope/i);
      return mig.length ? { status: 'covered', evidence: 'world-readable-policy lockdown migration present' }
        : { status: 'partial', note: 'verify via live RLS audit; no lockdown migration found in repo' };
    },
  },
  {
    id: 'no-service-role-in-client',
    regulation: ['GDPR Art.32', 'nFADP Art.8'],
    title: 'Service-role key never bundled in client/main (RLS is the boundary)',
    severity: 'blocker',
    remediation: 'Service-role key must live only in edge functions. Remove any SUPABASE_SERVICE_ROLE_KEY reference from src/.',
    detect: (ctx) => {
      const leak = ctx.grep(['src'], /SUPABASE_SERVICE_ROLE_KEY|service_role.*key|serviceRoleKey\s*[:=]/i)
        .filter((h) => !/test|mock|\.d\.ts/i.test(h.file));
      return leak.length === 0 ? { status: 'covered' } : { status: 'missing', note: `${leak.length} service-role reference(s) in client code` };
    },
  },
  {
    id: 'local-content-isolation',
    regulation: ['GDPR Art.5/32', 'nFADP'],
    title: 'Local caches are purged on account switch/logout (no cross-user bleed)',
    severity: 'required',
    remediation: 'A userDataIsolation service that purges all module content stores on owner-change + logout.',
    detect: (ctx) => {
      const svc = ctx.fileExists('src/renderer/services/userDataIsolation.ts');
      return svc ? { status: 'covered' } : { status: 'missing' };
    },
  },
  {
    id: 'breach-observability',
    regulation: ['GDPR Art.33', 'nFADP Art.24'],
    title: 'Error/security observability exists to support 72h breach notification',
    severity: 'advisory',
    remediation: 'Centralised error/security event capture (SRS) with a security-event stream.',
    detect: (ctx) => {
      const srs = ctx.fileExists('src/renderer/services/observabilityService.ts');
      const sec = ctx.grep(['supabase/migrations'], /security_events|signal_security_events/i);
      if (srs && sec.length) return { status: 'covered' };
      if (srs || sec.length) return { status: 'partial' };
      return { status: 'missing' };
    },
  },
];
