#!/usr/bin/env node
/**
 * WHAT: Audits Codex startup inputs and prepares reversible lean-profile actions.
 * WHY: Large agent waves need visibility into heavy skills, plugins, and hooks before a controller chooses any global trim.
 * HOW: Reads user configuration roots, prints findings by default, and writes or applies a manifest only when an operator requests it.
 * Usage: `node tools/sma-codex-profile.mjs --help`
 */
/**
 * sma-codex-profile.mjs - read-only Codex startup hygiene audit for SMA Gen3.
 *
 * The goal is to keep parallel agent waves lean without hidden global edits:
 * inspect personal skill roots, plugin-cache skills, hook manifests, and plugin
 * status, then report the safe trim opportunities a controller can choose.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { argv, env, exit } from 'node:process';

const DEFAULT_TOP = 12;
const DEFAULT_HEAVY_THRESHOLD = 50_000;
const DEFAULT_HOOK_STRING_THRESHOLD = 800;
const DEFAULT_LEAN_PROFILE = 'sma';
const RISK_LIMITS = {
  low: 100_000,
  medium: 250_000,
  high: 500_000,
};
const PROTECTED_PERSONAL_SKILL_NAMES = new Set(['sma-gen3', 'sma-enforcer', 'sma-course-builder']);
const GENERATED_AT = new Date().toISOString();

const parsed = parseArgs(argv.slice(2));
const command = parsed.positionals[0] || 'audit';

try {
  if (parsed.help || command === 'help') {
    usage();
    exit(0);
  }
  if (command === 'audit') {
    const audit = buildAudit(parsed);
    if (parsed.json) console.log(JSON.stringify(audit, null, 2));
    else printAudit(audit);
    exit(audit.summary.hook_parse_errors > 0 ? 2 : 0);
  }
  if (command === 'lean') {
    const manifest = runLean(parsed);
    if (parsed.json) console.log(JSON.stringify(manifest, null, 2));
    else printLean(manifest);
    exit(0);
  }
  if (command === 'restore') {
    const plan = runRestore(parsed);
    if (parsed.json) console.log(JSON.stringify(plan, null, 2));
    else printRestore(plan);
    exit(0);
  }
  if (command === 'selftest') {
    runSelftest();
    exit(0);
  }
  throw new Error(`unknown command: ${command}`);
} catch (err) {
  console.error(`sma-codex-profile: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-codex-profile.mjs audit [--json] [--codex-home <path>] [--agents-home <path>]
                              [--top <n>] [--heavy-threshold <bytes>]
                              [--no-plugin-cache]
  sma-codex-profile.mjs lean [--profile sma] [--apply] [--json]
                             [--manifest-dir <path>] [--include <skill>]
                             [--exclude <skill>]
  sma-codex-profile.mjs restore [--manifest <path>|--latest] [--apply] [--json]
                                [--manifest-dir <path>]
  sma-codex-profile.mjs selftest

Read-only audit for Codex/SMA Gen3 startup hygiene. It reports duplicate
personal skills, heavy active skills, plugin-cache skill budget, hook manifest
bulk, plugin enablement, stale disabled-plugin hook trust, and estimated context
gain from safe cleanup opportunities. Lean and restore default to dry-run; pass
--apply for explicit filesystem moves.
`);
}

function parseArgs(raw) {
  const opts = {
    positionals: [],
    json: false,
    help: false,
    codexHome: env.CODEX_HOME || join(homedir(), '.codex'),
    agentsHome: env.AGENTS_HOME || join(homedir(), '.agents'),
    top: DEFAULT_TOP,
    heavyThreshold: DEFAULT_HEAVY_THRESHOLD,
    hookStringThreshold: DEFAULT_HOOK_STRING_THRESHOLD,
    pluginCache: true,
    profile: DEFAULT_LEAN_PROFILE,
    apply: false,
    manifest: '',
    latest: false,
    manifestDir: '',
    includeSkills: new Set(),
    excludeSkills: new Set(),
  };
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    const next = raw[i + 1];
    if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--codex-home' && next) {
      opts.codexHome = resolve(next);
      i += 1;
    } else if (arg === '--agents-home' && next) {
      opts.agentsHome = resolve(next);
      i += 1;
    } else if (arg === '--home' && next) {
      const home = resolve(next);
      opts.codexHome = join(home, '.codex');
      opts.agentsHome = join(home, '.agents');
      i += 1;
    } else if (arg === '--top' && next) {
      opts.top = positiveInt(next, '--top');
      i += 1;
    } else if (arg === '--heavy-threshold' && next) {
      opts.heavyThreshold = positiveInt(next, '--heavy-threshold');
      i += 1;
    } else if (arg === '--hook-string-threshold' && next) {
      opts.hookStringThreshold = positiveInt(next, '--hook-string-threshold');
      i += 1;
    } else if (arg === '--no-plugin-cache') {
      opts.pluginCache = false;
    } else if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--latest') {
      opts.latest = true;
    } else if (arg === '--profile' && next) {
      opts.profile = safeSlug(next, '--profile');
      i += 1;
    } else if (arg === '--manifest' && next) {
      opts.manifest = resolve(next);
      i += 1;
    } else if (arg === '--manifest-dir' && next) {
      opts.manifestDir = resolve(next);
      i += 1;
    } else if (arg === '--include' && next) {
      opts.includeSkills.add(next);
      i += 1;
    } else if (arg === '--exclude' && next) {
      opts.excludeSkills.add(next);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      opts.positionals.push(arg);
    }
  }
  return opts;
}

function safeSlug(value, label) {
  const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`${label} must not be empty`);
  return slug;
}

function positiveInt(value, label) {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsedValue;
}

function buildAudit(opts) {
  const codexHome = resolve(opts.codexHome);
  const agentsHome = resolve(opts.agentsHome);
  const configPath = join(codexHome, 'config.toml');
  const pluginStatus = parsePluginStatus(configPath);
  const activePersonalSkills = [
    ...scanPersonalSkills(join(codexHome, 'skills'), 'codex'),
    ...scanPersonalSkills(join(agentsHome, 'skills'), 'agents'),
  ];
  const disabledPersonalSkills = [
    ...scanPersonalSkills(join(codexHome, 'skills.disabled'), 'codex-disabled'),
    ...scanPersonalSkills(join(agentsHome, 'skills.disabled'), 'agents-disabled'),
  ];
  const pluginSkills = opts.pluginCache
    ? scanPluginCacheSkills(join(codexHome, 'plugins', 'cache'), pluginStatus.byId)
    : [];
  const enabledPluginSkills = pluginSkills.filter((skill) => skill.plugin_enabled !== false);
  const disabledPluginSkills = pluginSkills.filter((skill) => skill.plugin_enabled === false);
  const activeBudgetSkills = [
    ...activePersonalSkills,
    ...enabledPluginSkills,
  ];
  const duplicates = findDuplicatePersonalSkills(activePersonalSkills);
  const hookManifests = scanHookManifests(codexHome, pluginStatus.byId, opts.hookStringThreshold);
  const recommendations = buildRecommendations({
    activePersonalSkills,
    activeBudgetSkills,
    disabledPluginSkills,
    duplicates,
    hookManifests,
    pluginStatus,
    opts,
  });
  const activeBudgetBytes = sumBytes(activeBudgetSkills);
  const duplicateReclaimBytes = sumBytes(duplicates.identical.map((dupe) => dupe.reclaimable_entries).flat());
  const heavyOptionalBytes = sumBytes(recommendations.heavy_personal_skill_review);
  const possibleReclaimBytes = duplicateReclaimBytes + heavyOptionalBytes;
  const summary = {
    personal_active_skills: activePersonalSkills.length,
    personal_active_skill_bytes: sumBytes(activePersonalSkills),
    personal_disabled_skills: disabledPersonalSkills.length,
    plugin_cache_skills: pluginSkills.length,
    enabled_plugin_cache_skills: enabledPluginSkills.length,
    disabled_plugin_cache_skills: disabledPluginSkills.length,
    enabled_plugin_skill_bytes: sumBytes(enabledPluginSkills),
    disabled_plugin_skill_bytes: sumBytes(disabledPluginSkills),
    active_budget_skills: activeBudgetSkills.length,
    active_budget_skill_bytes: activeBudgetBytes,
    active_budget_risk: skillBudgetRisk(activeBudgetBytes),
    duplicate_active_skill_names: duplicates.byName.length,
    identical_duplicate_active_skill_names: duplicates.identical.length,
    duplicate_reclaim_bytes_estimate: duplicateReclaimBytes,
    heavy_personal_review_bytes_estimate: heavyOptionalBytes,
    total_reclaim_bytes_estimate: possibleReclaimBytes,
    context_budget_gain_percent_estimate: percent(possibleReclaimBytes, activeBudgetBytes),
    hook_manifests: hookManifests.length,
    hook_manifest_bytes: sumBytes(hookManifests),
    hook_parse_errors: hookManifests.filter((hook) => !hook.valid_json).length,
    long_hook_command_strings: hookManifests.reduce((count, hook) => count + hook.long_strings.length, 0),
    enabled_plugins: pluginStatus.plugins.filter((plugin) => plugin.enabled === true).length,
    disabled_plugins: pluginStatus.plugins.filter((plugin) => plugin.enabled === false).length,
    hook_trust_entries: pluginStatus.hookTrustEntries.length,
    disabled_plugin_hook_trust_entries: pluginStatus.disabledPluginHookTrustEntries.length,
  };

  return {
    schema_version: '1.0.0',
    generated_at: GENERATED_AT,
    roots: {
      codex_home: codexHome,
      agents_home: agentsHome,
      personal_active_skill_roots: [join(codexHome, 'skills'), join(agentsHome, 'skills')],
      personal_disabled_skill_roots: [join(codexHome, 'skills.disabled'), join(agentsHome, 'skills.disabled')],
      plugin_cache_root: join(codexHome, 'plugins', 'cache'),
      config_path: configPath,
      hooks_path: join(codexHome, 'hooks.json'),
    },
    summary,
    top_active_budget_skills: sortByBytes(activeBudgetSkills).slice(0, opts.top),
    top_personal_active_skills: sortByBytes(activePersonalSkills).slice(0, opts.top),
    top_plugin_cache_skills: sortByBytes(pluginSkills).slice(0, opts.top),
    duplicate_personal_skills: duplicates,
    hook_manifests: sortByBytes(hookManifests).slice(0, Math.max(opts.top, 20)),
    plugins: pluginStatus.plugins,
    disabled_plugin_hook_trust_entries: pluginStatus.disabledPluginHookTrustEntries,
    recommendations,
    commands: {
      audit_text: 'npm run codex:profile',
      audit_json: 'npm run codex:profile:json',
      lean_plan: 'npm run codex:profile:lean',
      lean_apply: 'npm run codex:profile:lean:apply',
      restore_plan: 'npm run codex:profile:restore',
      restore_apply_latest: 'npm run codex:profile:restore:apply',
      selftest: 'npm run codex:profile:selftest',
      nested_smoke: 'codex exec --cd ~/DEV/Projects/<project> "Reply with READY and nothing else."',
    },
  };
}

function scanPersonalSkills(root, rootKind) {
  if (!existsSync(root)) return [];
  const skills = [];
  for (const entry of safeReaddir(root)) {
    const dir = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    skills.push(readSkill(skillPath, {
      source_kind: 'personal',
      root_kind: rootKind,
      plugin_id: null,
      plugin_enabled: null,
    }));
  }
  return skills;
}

function scanPluginCacheSkills(root, pluginStatusById) {
  if (!existsSync(root)) return [];
  const files = walkFiles(root, {
    maxDepth: 8,
    match: (filePath) => basename(filePath) === 'SKILL.md',
    skipDir: (dirPath) => {
      const base = basename(dirPath);
      return base === '.git' || base === 'node_modules' || base === '.cache';
    },
  });
  return files.map((skillPath) => {
    const pluginId = pluginIdFromCachePath(root, skillPath);
    const plugin = pluginStatusById.get(pluginId);
    return readSkill(skillPath, {
      source_kind: 'plugin-cache',
      root_kind: 'plugin-cache',
      plugin_id: pluginId,
      plugin_enabled: plugin?.enabled ?? null,
    });
  });
}

function readSkill(skillPath, extra) {
  const text = readText(skillPath);
  const stat = statSync(skillPath);
  const meta = parseFrontmatter(text);
  return {
    name: meta.name || basename(dirname(skillPath)),
    frontmatter_description: meta.description || '',
    path: skillPath,
    bytes: byteLength(text),
    lines: text.split(/\r?\n/).length,
    sha256: sha256(text),
    mtime_ms: stat.mtimeMs,
    ...extra,
  };
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const body = text.slice(3, end).trim();
  const meta = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    meta[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return meta;
}

function pluginIdFromCachePath(cacheRoot, filePath) {
  const parts = relative(cacheRoot, filePath).split(sep);
  if (parts.length < 3) return parts[0] || 'unknown';
  return `${parts[1]}@${parts[0]}`;
}

function findDuplicatePersonalSkills(skills) {
  const groups = new Map();
  for (const skill of skills) {
    const key = skill.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(skill);
  }
  const byName = [];
  const identical = [];
  const divergent = [];
  for (const [name, entries] of groups.entries()) {
    if (entries.length < 2) continue;
    const sorted = sortByBytes(entries);
    const hashes = new Set(entries.map((entry) => entry.sha256));
    const group = {
      name,
      entries: sorted,
      total_bytes: sumBytes(entries),
      identical: hashes.size === 1,
    };
    byName.push(group);
    if (hashes.size === 1) {
      identical.push({
        ...group,
        keep_entry: sorted[0],
        reclaimable_entries: sorted.slice(1),
        reclaimable_bytes: sumBytes(sorted.slice(1)),
      });
    } else {
      divergent.push(group);
    }
  }
  return {
    byName: byName.sort((a, b) => b.total_bytes - a.total_bytes),
    identical: identical.sort((a, b) => b.reclaimable_bytes - a.reclaimable_bytes),
    divergent: divergent.sort((a, b) => b.total_bytes - a.total_bytes),
  };
}

function parsePluginStatus(configPath) {
  const plugins = [];
  const byId = new Map();
  const hookTrustEntries = [];
  if (!existsSync(configPath)) {
    return { plugins, byId, hookTrustEntries, disabledPluginHookTrustEntries: [] };
  }
  const text = readText(configPath);
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const pluginMatch = line.match(/^\[plugins\."([^"]+)"\]/);
    const hookStateMatch = line.match(/^\[hooks\.state\."([^"]+)"\]/);
    const anySection = line.match(/^\[/);
    if (pluginMatch) {
      section = { type: 'plugin', id: pluginMatch[1], enabled: null };
      plugins.push(section);
      byId.set(section.id, section);
      continue;
    }
    if (hookStateMatch) {
      section = { type: 'hook_state', id: hookStateMatch[1] };
      hookTrustEntries.push(hookStateMatch[1]);
      continue;
    }
    if (anySection) {
      section = null;
      continue;
    }
    if (section?.type === 'plugin') {
      const enabledMatch = line.match(/^enabled\s*=\s*(true|false)\s*$/);
      if (enabledMatch) section.enabled = enabledMatch[1] === 'true';
    }
  }
  const disabled = new Set(plugins.filter((plugin) => plugin.enabled === false).map((plugin) => plugin.id));
  const disabledPluginHookTrustEntries = hookTrustEntries.filter((entry) => {
    const owner = entry.split(':')[0];
    return disabled.has(owner);
  });
  return {
    plugins: plugins.sort((a, b) => a.id.localeCompare(b.id)),
    byId,
    hookTrustEntries,
    disabledPluginHookTrustEntries,
  };
}

function scanHookManifests(codexHome, pluginStatusById, longStringThreshold) {
  const candidates = [];
  const userHooks = join(codexHome, 'hooks.json');
  if (existsSync(userHooks)) candidates.push(userHooks);
  const cacheRoot = join(codexHome, 'plugins', 'cache');
  if (existsSync(cacheRoot)) {
    candidates.push(...walkFiles(cacheRoot, {
      maxDepth: 8,
      match: (filePath) => {
        const base = basename(filePath);
        return base === 'hooks.json' || base === 'codex-hooks.json' || base === 'hooks-codex.json';
      },
      skipDir: (dirPath) => {
        const base = basename(dirPath);
        return base === '.git' || base === 'node_modules' || base === '.cache';
      },
    }));
  }
  return candidates.map((filePath) => readHookManifest(filePath, cacheRoot, pluginStatusById, longStringThreshold));
}

function readHookManifest(filePath, cacheRoot, pluginStatusById, longStringThreshold) {
  const text = readText(filePath);
  const pluginId = filePath.startsWith(cacheRoot) ? pluginIdFromCachePath(cacheRoot, filePath) : null;
  const plugin = pluginId ? pluginStatusById.get(pluginId) : null;
  const hook = {
    path: filePath,
    bytes: byteLength(text),
    sha256: sha256(text),
    plugin_id: pluginId,
    plugin_enabled: plugin?.enabled ?? null,
    valid_json: true,
    parse_error: null,
    event_count: 0,
    command_string_count: 0,
    largest_string_bytes: 0,
    long_strings: [],
  };
  try {
    const parsedJson = JSON.parse(text);
    const strings = [];
    collectStrings(parsedJson, strings);
    hook.command_string_count = strings.length;
    hook.largest_string_bytes = strings.reduce((max, value) => Math.max(max, byteLength(value)), 0);
    hook.long_strings = strings
      .map((value) => ({
        bytes: byteLength(value),
        preview: compactOneLine(value).slice(0, 160),
      }))
      .filter((value) => value.bytes >= longStringThreshold)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5);
    hook.event_count = countHookEvents(parsedJson);
  } catch (err) {
    hook.valid_json = false;
    hook.parse_error = err.message;
  }
  return hook;
}

function collectStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function countHookEvents(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.length;
  return Object.values(value).reduce((sum, item) => {
    if (Array.isArray(item)) return sum + item.length;
    if (item && typeof item === 'object') return sum + Object.keys(item).length;
    return sum;
  }, 0);
}

function buildRecommendations({
  activePersonalSkills,
  activeBudgetSkills,
  disabledPluginSkills,
  duplicates,
  hookManifests,
  pluginStatus,
  opts,
}) {
  const heavyPersonalSkillReview = sortByBytes(activePersonalSkills)
    .filter((skill) => skill.bytes >= opts.heavyThreshold && !PROTECTED_PERSONAL_SKILL_NAMES.has(skill.name));
  const bulkyHooks = hookManifests
    .filter((hook) => hook.bytes >= 4_000 || hook.long_strings.length > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const disabledPluginHookTrust = pluginStatus.disabledPluginHookTrustEntries;
  const notes = [];
  if (duplicates.identical.length) {
    notes.push('Move byte-identical duplicate personal skills out of active roots; keep one canonical copy.');
  }
  if (duplicates.divergent.length) {
    notes.push('Resolve divergent duplicate personal skills manually before disabling either copy.');
  }
  if (heavyPersonalSkillReview.length) {
    notes.push('Review heavy optional personal skills for SMA lean waves; keep domain-critical skills active only when needed.');
  }
  if (bulkyHooks.length) {
    notes.push('Keep hook manifests as tiny routers; install/fix or disable plugins whose hooks are bulky or runtime-broken.');
  }
  if (disabledPluginHookTrust.length) {
    notes.push('Remove stale trusted hook-state entries for disabled plugins after confirming they are not active.');
  }
  if (disabledPluginSkills.length) {
    notes.push('Disabled plugin-cache skills are present on disk; if they still appear in new sessions, refresh Codex plugin discovery.');
  }
  if (!notes.length) {
    notes.push('Profile is lean: no duplicate personal skills, no parse-broken hooks, and no heavy optional personal skill above threshold.');
  }
  return {
    identical_duplicate_personal_skills: duplicates.identical,
    divergent_duplicate_personal_skills: duplicates.divergent,
    heavy_personal_skill_review: heavyPersonalSkillReview,
    bulky_hook_manifests: bulkyHooks,
    disabled_plugin_hook_trust: disabledPluginHookTrust,
    disabled_plugin_cache_skills: sortByBytes(disabledPluginSkills).slice(0, opts.top),
    active_budget_top: sortByBytes(activeBudgetSkills).slice(0, opts.top),
    notes,
  };
}

function printAudit(audit) {
  const s = audit.summary;
  console.log('SMA Codex Profile Audit');
  console.log(`generated:       ${audit.generated_at}`);
  console.log(`codex home:      ${audit.roots.codex_home}`);
  console.log(`agents home:     ${audit.roots.agents_home}`);
  console.log(`skill budget:    ${formatBytes(s.active_budget_skill_bytes)} (${s.active_budget_skills} active budget skills, ${s.active_budget_risk} risk)`);
  console.log(`personal skills: ${s.personal_active_skills} active, ${formatBytes(s.personal_active_skill_bytes)}; disabled ${s.personal_disabled_skills}`);
  console.log(`plugin skills:   ${s.enabled_plugin_cache_skills} enabled/unknown, ${formatBytes(s.enabled_plugin_skill_bytes)}; disabled ${s.disabled_plugin_cache_skills}`);
  console.log(`duplicates:      ${s.duplicate_active_skill_names} names, ${s.identical_duplicate_active_skill_names} byte-identical`);
  console.log(`hooks:           ${s.hook_manifests} manifests, ${formatBytes(s.hook_manifest_bytes)}, parse errors ${s.hook_parse_errors}, long strings ${s.long_hook_command_strings}`);
  console.log(`plugins:         ${s.enabled_plugins} enabled, ${s.disabled_plugins} disabled; stale disabled hook trust ${s.disabled_plugin_hook_trust_entries}`);
  console.log(`gains:           ${s.context_budget_gain_percent_estimate}% context-budget reduction estimate from duplicate/heavy-personal review (${formatBytes(s.total_reclaim_bytes_estimate)})`);

  printSkillList('Top active budget skills', audit.top_active_budget_skills);
  printDuplicateList(audit.duplicate_personal_skills.identical);
  printHookList(audit.hook_manifests);

  console.log('');
  console.log('Recommendations:');
  for (const note of audit.recommendations.notes) {
    console.log(`- ${note}`);
  }
  console.log('');
  console.log(`Next: ${audit.commands.audit_json}`);
}

function runLean(opts) {
  const audit = buildAudit(opts);
  const manifest = buildLeanManifest(audit, opts);
  if (opts.apply) applyLeanManifest(manifest);
  return manifest;
}

function buildLeanManifest(audit, opts) {
  const stamp = timestampSlug();
  const manifestDir = profileManifestDir(opts);
  const disabledGroup = `sma-lean-${opts.profile}-${stamp}`;
  const candidates = leanMoveCandidates(audit, opts);
  const moves = candidates.map((candidate) => {
    const disabledRoot = disabledRootForSkill(candidate.skill, audit.roots);
    return {
      name: candidate.skill.name,
      reason: candidate.reason,
      source_kind: candidate.skill.source_kind,
      root_kind: candidate.skill.root_kind,
      bytes: candidate.skill.bytes,
      sha256: candidate.skill.sha256,
      from: dirname(candidate.skill.path),
      to: join(disabledRoot, disabledGroup, candidate.skill.name),
    };
  });
  const totalBytes = sumBytes(moves);
  return {
    schema_version: '1.0.0',
    command: 'lean',
    profile: opts.profile,
    generated_at: new Date().toISOString(),
    applied: Boolean(opts.apply),
    restored: false,
    manifest_path: join(manifestDir, `codex-profile-lean-${opts.profile}-${stamp}.json`),
    disabled_group: disabledGroup,
    roots: audit.roots,
    summary_before: audit.summary,
    summary: {
      move_count: moves.length,
      move_bytes: totalBytes,
      context_budget_gain_percent_estimate: percent(totalBytes, audit.summary.active_budget_skill_bytes),
      dry_run: !opts.apply,
    },
    moves,
    commands: {
      apply: `npm run codex:profile:lean:apply -- --profile ${shellArg(opts.profile)}`,
      restore: `npm run codex:profile:restore -- --manifest ${shellArg(join(manifestDir, `codex-profile-lean-${opts.profile}-${stamp}.json`))}`,
      restore_apply: `npm run codex:profile:restore:apply -- --manifest ${shellArg(join(manifestDir, `codex-profile-lean-${opts.profile}-${stamp}.json`))}`,
    },
  };
}

function leanMoveCandidates(audit, opts) {
  const moves = [];
  const seen = new Set();
  const addCandidate = (skill, reason) => {
    if (!skill?.path || seen.has(skill.path)) return;
    if (PROTECTED_PERSONAL_SKILL_NAMES.has(skill.name)) return;
    if (opts.excludeSkills.has(skill.name)) return;
    const explicit = opts.includeSkills.has(skill.name);
    if (!explicit && reason !== 'identical-duplicate' && skill.bytes < opts.heavyThreshold) return;
    seen.add(skill.path);
    moves.push({ skill, reason });
  };
  for (const skill of audit.recommendations.heavy_personal_skill_review) {
    addCandidate(skill, 'heavy-optional-personal-skill');
  }
  for (const dupe of audit.duplicate_personal_skills.identical) {
    for (const skill of dupe.reclaimable_entries || []) {
      addCandidate(skill, 'identical-duplicate');
    }
  }
  if (opts.includeSkills.size) {
    const byName = new Map();
    for (const skill of audit.top_personal_active_skills || []) byName.set(skill.name, skill);
    for (const skill of audit.recommendations.active_budget_top || []) {
      if (skill.source_kind === 'personal') byName.set(skill.name, skill);
    }
    for (const name of opts.includeSkills) {
      const skill = byName.get(name);
      if (!skill) throw new Error(`included skill is not active personal skill: ${name}`);
      addCandidate(skill, 'explicit-include');
    }
  }
  return sortByBytes(moves.map((item) => item.skill)).map((skill) => moves.find((item) => item.skill.path === skill.path));
}

function disabledRootForSkill(skill, roots) {
  if (skill.root_kind === 'codex') return roots.personal_disabled_skill_roots[0];
  if (skill.root_kind === 'agents') return roots.personal_disabled_skill_roots[1];
  throw new Error(`lean profile can only move personal skills, got ${skill.root_kind}:${skill.name}`);
}

function applyLeanManifest(manifest) {
  mkdirSync(dirname(manifest.manifest_path), { recursive: true });
  validateMoveTargets(manifest.moves);
  writeFileSync(manifest.manifest_path, JSON.stringify({ ...manifest, applied: false, state: 'planned' }, null, 2) + '\n');
  for (const move of manifest.moves) {
    mkdirSync(dirname(move.to), { recursive: true });
    renameSync(move.from, move.to);
  }
  writeFileSync(manifest.manifest_path, JSON.stringify({ ...manifest, applied: true, state: 'applied' }, null, 2) + '\n');
  manifest.applied = true;
  manifest.state = 'applied';
}

function validateMoveTargets(moves) {
  for (const move of moves) {
    if (!existsSync(move.from)) throw new Error(`move source missing: ${move.from}`);
    if (existsSync(move.to)) throw new Error(`move target already exists: ${move.to}`);
  }
}

function runRestore(opts) {
  const manifestPath = opts.manifest || resolveLatestManifest(opts);
  const manifest = JSON.parse(readText(manifestPath));
  const plan = buildRestorePlan(manifest, opts, manifestPath);
  if (opts.apply) applyRestorePlan(plan);
  return plan;
}

function buildRestorePlan(manifest, opts, manifestPath) {
  const moves = (manifest.moves || []).map((move) => ({
    name: move.name,
    bytes: move.bytes,
    sha256: move.sha256,
    from: move.to,
    to: move.from,
    source_manifest_from: move.from,
    source_manifest_to: move.to,
  }));
  const totalBytes = sumBytes(moves);
  const conflicts = [];
  for (const move of moves) {
    if (!existsSync(move.from)) conflicts.push({ name: move.name, reason: 'restore source missing', path: move.from });
    if (existsSync(move.to)) conflicts.push({ name: move.name, reason: 'restore target already exists', path: move.to });
  }
  return {
    schema_version: '1.0.0',
    command: 'restore',
    generated_at: new Date().toISOString(),
    profile: manifest.profile || opts.profile,
    manifest_path: manifestPath,
    apply: Boolean(opts.apply),
    summary: {
      restore_count: moves.length,
      restore_bytes: totalBytes,
      dry_run: !opts.apply,
      conflict_count: conflicts.length,
    },
    conflicts,
    moves,
  };
}

function applyRestorePlan(plan) {
  if (plan.conflicts.length) {
    throw new Error(`restore has ${plan.conflicts.length} conflict(s); run dry-run and resolve first`);
  }
  for (const move of plan.moves) {
    mkdirSync(dirname(move.to), { recursive: true });
    renameSync(move.from, move.to);
  }
  const manifest = JSON.parse(readText(plan.manifest_path));
  writeFileSync(plan.manifest_path, JSON.stringify({
    ...manifest,
    restored: true,
    restored_at: new Date().toISOString(),
  }, null, 2) + '\n');
}

function resolveLatestManifest(opts) {
  const dir = profileManifestDir(opts);
  const prefix = `codex-profile-lean-${opts.profile}-`;
  const candidates = safeReaddir(dir)
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = join(dir, entry.name);
      return { path: filePath, mtime: statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error(`no lean profile manifests found in ${dir}`);
  return candidates[0].path;
}

function profileManifestDir(opts) {
  return opts.manifestDir || join(resolve(opts.codexHome), 'profile-manifests');
}

function printLean(manifest) {
  console.log('SMA Codex Lean Profile');
  console.log(`profile:         ${manifest.profile}`);
  console.log(`mode:            ${manifest.applied ? 'applied' : 'dry-run'}`);
  console.log(`manifest:        ${manifest.manifest_path}`);
  console.log(`moves:           ${manifest.summary.move_count}`);
  console.log(`gain estimate:   ${manifest.summary.context_budget_gain_percent_estimate}% (${formatBytes(manifest.summary.move_bytes)})`);
  if (!manifest.moves.length) {
    console.log('No lean moves selected.');
    return;
  }
  console.log('');
  console.log('Selected moves:');
  for (const move of manifest.moves) {
    console.log(`- ${move.name} ${formatBytes(move.bytes)} [${move.reason}]`);
    console.log(`  from: ${move.from}`);
    console.log(`  to:   ${move.to}`);
  }
  if (!manifest.applied) {
    console.log('');
    console.log(`Apply: ${manifest.commands.apply}`);
  }
}

function printRestore(plan) {
  console.log('SMA Codex Lean Restore');
  console.log(`profile:         ${plan.profile}`);
  console.log(`mode:            ${plan.apply ? 'applied' : 'dry-run'}`);
  console.log(`manifest:        ${plan.manifest_path}`);
  console.log(`moves:           ${plan.summary.restore_count}`);
  console.log(`restore bytes:   ${formatBytes(plan.summary.restore_bytes)}`);
  console.log(`conflicts:       ${plan.summary.conflict_count}`);
  if (plan.conflicts.length) {
    console.log('');
    console.log('Conflicts:');
    for (const conflict of plan.conflicts) console.log(`- ${conflict.name}: ${conflict.reason} (${conflict.path})`);
  }
  if (!plan.moves.length) return;
  console.log('');
  console.log('Restore moves:');
  for (const move of plan.moves) {
    console.log(`- ${move.name} ${formatBytes(move.bytes)}`);
    console.log(`  from: ${move.from}`);
    console.log(`  to:   ${move.to}`);
  }
}

function printSkillList(title, skills) {
  if (!skills.length) return;
  console.log('');
  console.log(`${title}:`);
  for (const skill of skills) {
    const owner = skill.plugin_id || skill.root_kind;
    const enabled = skill.plugin_enabled === false ? ' disabled-plugin' : '';
    console.log(`- ${skill.name} ${formatBytes(skill.bytes)} [${owner}${enabled}] ${relativeOrAbsolute(skill.path)}`);
  }
}

function printDuplicateList(duplicates) {
  if (!duplicates.length) return;
  console.log('');
  console.log('Byte-identical personal duplicates:');
  for (const dupe of duplicates) {
    console.log(`- ${dupe.name}: reclaim ${formatBytes(dupe.reclaimable_bytes)} by keeping ${relativeOrAbsolute(dupe.keep_entry.path)}`);
  }
}

function printHookList(hooks) {
  if (!hooks.length) return;
  console.log('');
  console.log('Hook manifests:');
  for (const hook of hooks.slice(0, 10)) {
    const owner = hook.plugin_id || 'user';
    const enabled = hook.plugin_enabled === false ? ' disabled-plugin' : '';
    const valid = hook.valid_json ? 'ok' : `error: ${hook.parse_error}`;
    const long = hook.long_strings.length ? `, long strings ${hook.long_strings.map((item) => formatBytes(item.bytes)).join('/')}` : '';
    console.log(`- ${formatBytes(hook.bytes)} [${owner}${enabled}] ${valid}${long} ${relativeOrAbsolute(hook.path)}`);
  }
}

function walkFiles(root, options) {
  const files = [];
  const stack = [{ path: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (!current || current.depth > options.maxDepth) continue;
    if (current.depth > 0 && options.skipDir?.(current.path)) continue;
    for (const entry of safeReaddir(current.path)) {
      const entryPath = join(current.path, entry.name);
      if (entry.isDirectory()) {
        stack.push({ path: entryPath, depth: current.depth + 1 });
      } else if (entry.isFile() && options.match(entryPath)) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function sumBytes(items) {
  return items.reduce((sum, item) => sum + Number(item.bytes || 0), 0);
}

function sortByBytes(items) {
  return [...items].sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));
}

function skillBudgetRisk(bytes) {
  if (bytes < RISK_LIMITS.low) return 'low';
  if (bytes < RISK_LIMITS.medium) return 'medium';
  if (bytes < RISK_LIMITS.high) return 'high';
  return 'critical';
}

function percent(part, whole) {
  if (!whole) return 0;
  return Math.round((Number(part || 0) / Number(whole)) * 100);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${value}B`;
}

function relativeOrAbsolute(filePath) {
  const cwd = process.cwd();
  const rel = relative(cwd, filePath);
  if (rel && !rel.startsWith('..') && !resolve(rel).startsWith('..')) return rel;
  return filePath;
}

function compactOneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function runSelftest() {
  const root = mkdtempSync(join(tmpdir(), 'sma-codex-profile-'));
  try {
    const codexHome = join(root, '.codex');
    const agentsHome = join(root, '.agents');
    mkdirSync(join(codexHome, 'skills', 'sma-gen3'), { recursive: true });
    mkdirSync(join(agentsHome, 'skills', 'sma-gen3'), { recursive: true });
    mkdirSync(join(agentsHome, 'skills', 'big-optional'), { recursive: true });
    mkdirSync(join(codexHome, 'plugins', 'cache', 'context-mode', 'context-mode', '1.0.0', 'skills', 'context-mode'), { recursive: true });
    mkdirSync(join(codexHome, 'plugins', 'cache', 'claude-mem-local', 'claude-mem', '13.8.1', 'skills', 'babysit'), { recursive: true });
    mkdirSync(join(codexHome, 'plugins', 'cache', 'claude-mem-local', 'claude-mem', '13.8.1', 'hooks'), { recursive: true });

    const smaSkill = skillFixture('sma-gen3', 'SMA Gen3 skill', 'Use module graphs and leases.');
    writeFileSync(join(codexHome, 'skills', 'sma-gen3', 'SKILL.md'), smaSkill);
    writeFileSync(join(agentsHome, 'skills', 'sma-gen3', 'SKILL.md'), smaSkill);
    writeFileSync(join(agentsHome, 'skills', 'big-optional', 'SKILL.md'), skillFixture('big-optional', 'Large optional skill', 'x'.repeat(60_000)));
    writeFileSync(join(codexHome, 'plugins', 'cache', 'context-mode', 'context-mode', '1.0.0', 'skills', 'context-mode', 'SKILL.md'), skillFixture('context-mode', 'Context mode', 'enabled plugin skill'));
    writeFileSync(join(codexHome, 'plugins', 'cache', 'claude-mem-local', 'claude-mem', '13.8.1', 'skills', 'babysit', 'SKILL.md'), skillFixture('babysit', 'Disabled plugin skill', 'disabled plugin skill'));
    writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ SessionStart: [{ command: 'node tiny.mjs' }] }, null, 2));
    writeFileSync(join(codexHome, 'plugins', 'cache', 'claude-mem-local', 'claude-mem', '13.8.1', 'hooks', 'codex-hooks.json'), JSON.stringify({
      SessionStart: [{ command: `bash -lc '${'bootstrap '.repeat(200)}'` }],
    }, null, 2));
    writeFileSync(join(codexHome, 'config.toml'), `
[plugins."context-mode@context-mode"]
enabled = true

[plugins."claude-mem@claude-mem-local"]
enabled = false

[hooks.state]

[hooks.state."claude-mem@claude-mem-local:hooks/codex-hooks.json:session_start:0:0"]
trusted_hash = "sha256:test"
`);

    const audit = buildAudit({
      codexHome,
      agentsHome,
      top: 20,
      heavyThreshold: 50_000,
      hookStringThreshold: 800,
      pluginCache: true,
    });
    assertSelftest(audit.summary.identical_duplicate_active_skill_names === 1, 'identical duplicate skill should be detected');
    assertSelftest(audit.summary.heavy_personal_review_bytes_estimate > 50_000, 'heavy personal skill review bytes should be detected');
    assertSelftest(audit.summary.enabled_plugin_cache_skills === 1, 'enabled plugin cache skill should be counted');
    assertSelftest(audit.summary.disabled_plugin_cache_skills === 1, 'disabled plugin cache skill should be separated');
    assertSelftest(audit.summary.long_hook_command_strings === 1, 'long hook command string should be detected');
    assertSelftest(audit.summary.disabled_plugin_hook_trust_entries === 1, 'disabled plugin hook trust should be detected');
    const lean = buildLeanManifest(audit, {
      ...parseArgs(['lean']),
      codexHome,
      agentsHome,
      profile: 'sma',
      manifestDir: join(root, 'manifests'),
      heavyThreshold: 50_000,
      hookStringThreshold: 800,
      pluginCache: true,
      apply: true,
    });
    assertSelftest(lean.summary.move_count === 1, 'lean profile should select one heavy optional skill');
    applyLeanManifest(lean);
    assertSelftest(!existsSync(join(agentsHome, 'skills', 'big-optional')), 'lean apply should move heavy skill out of active root');
    assertSelftest(existsSync(lean.moves[0].to), 'lean apply target should exist');
    const restore = buildRestorePlan(JSON.parse(readText(lean.manifest_path)), { apply: true, profile: 'sma' }, lean.manifest_path);
    assertSelftest(restore.summary.conflict_count === 0, 'restore should have no conflicts after lean apply');
    applyRestorePlan(restore);
    assertSelftest(existsSync(join(agentsHome, 'skills', 'big-optional')), 'restore should move heavy skill back to active root');
    console.log('OK sma-codex-profile selftest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function skillFixture(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

function assertSelftest(condition, message) {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}
