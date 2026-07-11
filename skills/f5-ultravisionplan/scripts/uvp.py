#!/usr/bin/env python3
"""uvp — UltraVision Plan tool v2 (F5-UltraVisionPlan / SUP skill). Stdlib only.

Source of truth: .UltraVision/tasks/<module>.jsonl (one task per line, schema
in schema/task.schema.json). Markdown under tasklists/ is a GENERATED view.
All mutations are serialized through a repo-local lock and journaled.

Plan lifecycle:
  expand     inventories x templates -> tasks/*.jsonl (deterministic IDs, idempotent)
             --dry-run prints the volume/tier/effort projection without writing
  validate   schema + DAG + allowed_deps + hot paths + vision registry + coverage
             (--strict fails on warnings; --pedantic promotes info lints too)
  render     tasklists/*.md views + INDEX.md + meta/stats.json
  stats      recompute meta/stats.json
  topo       waves + critical path -> meta/topo.json
  migrate    stamp schema_version, defaults, spec hashes (--rehash re-accepts edits)
  drift      compare vision source hashes (meta/vision-sources.json); --update re-stamps

Execution (consumer contract):
  next       ready tasks (deps satisfied); --critical orders by unlock impact
  dispatch   wave manifest for parallel agents -> meta/wave.json
  claim      todo -> claimed        (--lease bridges SMA start:edit)
  complete   claimed -> done        (--evidence and/or --evidence-cmd, which must pass)
  verify     done -> verified       (records verified_by)
  obsolete   any -> obsolete        (--reason required; warns about dependents)
  report     velocity/burndown/ETA from the journal -> meta/report.md
  audit-claims  re-run gate commands of sampled done tasks -> meta/audit-report.json
  featmap    propose SFM entries for fully-delivered vision pillars
  gen3-draft emit draft sma.gen3.json from modules.json (bootstrap artifact)

Common flags: --root PATH (default ./.UltraVision)
"""

import argparse
import fcntl
import hashlib
import json
import random
import re
import sqlite3
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
SCHEMA_VERSION = 2

DOMAINS = {"backend", "frontend", "design", "ux", "media", "i18n", "a11y", "perf",
           "test", "docs", "infra", "telemetry", "security", "data", "api", "release"}
LANES = {"single-module", "multi-module", "shared-hot-path", "unmapped"}
PAID = {"higgsfield", "fal", "elevenlabs"}
STATUSES = {"todo", "claimed", "done", "verified", "obsolete"}
TIERS = {"haiku", "sonnet", "opus", "fable"}
COMPLEXITIES = ["C1", "C2", "C3", "C4", "C5"]
COMPLEXITY_TIER = {"C1": "haiku", "C2": "sonnet", "C3": "sonnet", "C4": "opus", "C5": "fable"}
COMPLEXITY_EST = {"C1": 15, "C2": 30, "C3": 60, "C4": 120, "C5": 240}
COVERAGE_CATEGORIES = ["test", "telemetry", "a11y", "i18n", "perf", "docs", "security"]
REQUIRED = ["id", "title", "description", "module", "domain", "lane", "milestone",
            "complexity", "model_tier", "status", "acceptance_criteria", "gates"]
REQUIRED_DOCS = ["00-VISION.md", "01-CURRENT-STATE.md", "02-GAP-ANALYSIS.md",
                 "03-TARGET-ARCHITECTURE.md", "04-DESIGN-LANGUAGE.md", "05-MEDIA-PLAN.md",
                 "06-I18N-PLAN.md", "07-PERFORMANCE-PLAN.md", "08-QUALITY-RELEASE-PLAN.md"]
ID_RE = re.compile(r"^UV-[A-Z0-9]+-[a-z0-9][a-z0-9-]*$")
MILESTONE_RE = re.compile(r"^M\d+$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
# Fields that define a task's spec (vs. execution state). spec_hash covers these.
SPEC_FIELDS = ["id", "title", "description", "module", "domain", "lane", "milestone",
               "complexity", "model_tier", "acceptance_criteria", "test_plan", "gates",
               "depends_on", "files_touched", "external_tools", "paid", "prompt",
               "est_minutes", "template", "inventory_ref", "platform", "vision", "gaps"]
OPTIONAL_DEFAULTS = {"depends_on": [], "vision": [], "gaps": [], "test_plan": None,
                     "files_touched": [], "external_tools": [], "paid": [], "prompt": None,
                     "template": None, "inventory_ref": None, "platform": None,
                     "claimed_by": None, "claimed_at": None, "evidence": None,
                     "obsolete_reason": None, "lease": None, "verified_by": None}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def die(msg, code=2):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def load_json(path, what):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        die(f"{what} not found: {path}")
    except json.JSONDecodeError as e:
        die(f"{what} is not valid JSON ({path}): {e}")


def spec_hash(t):
    payload = json.dumps({k: t.get(k) for k in SPEC_FIELDS},
                         sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


@contextmanager
def mutation_lock(root):
    """Serialize all plan mutations. Two agents claiming in the same repo
    otherwise race on the read-modify-write of a module file."""
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    fh = (meta / ".lock").open("a+")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


# ---------------------------------------------------------------- module map

def load_module_map(root):
    return load_json(root / "modules.json", "modules.json (module map)")


def load_modules(root, mmap=None):
    data = mmap or load_module_map(root)
    mods = {}
    for m in data.get("modules", []):
        mods[m["id"]] = m
        m.setdefault("code", re.sub(r"[^a-z0-9]", "", m["id"]).upper())
        m.setdefault("gates", [])
        m.setdefault("lane_default", "single-module")
    if not mods:
        die("modules.json contains no modules")
    return mods


def glob_to_re(pattern):
    out, i = [], 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*":
            if pattern[i:i + 2] == "**":
                out.append(".*")
                i += 2
                if i < len(pattern) and pattern[i] == "/":
                    i += 1
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(c))
        i += 1
    return re.compile("^" + "".join(out) + "$")


def path_matches(path, globs):
    return any(glob_to_re(g).match(path) for g in globs)


# ---------------------------------------------------------------- task io

def task_files(root):
    return sorted((root / "tasks").glob("*.jsonl"))


def load_tasks(root, report=None):
    tasks, by_id = [], {}
    for f in task_files(root):
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            loc = f"tasks/{f.name}:{n}"
            try:
                t = json.loads(line)
            except json.JSONDecodeError as e:
                if report is not None:
                    report["errors"].append(f"{loc}: invalid JSON ({e})")
                continue
            t["_loc"], t["_file"] = loc, f.name
            tasks.append(t)
            tid = t.get("id")
            if tid in by_id and report is not None:
                report["errors"].append(f"{loc}: duplicate id {tid} (also {by_id[tid]['_loc']})")
            by_id[tid] = t
    return tasks, by_id


def load_tasks_fast(root):
    """Read path for next/stats/report/dispatch: sqlite cache keyed on file
    mtimes+sizes. Falls back to a direct parse on any cache trouble; validate
    always uses the direct parse."""
    files = task_files(root)
    sig = {f.name: (f.stat().st_mtime_ns, f.stat().st_size) for f in files}
    db = root / "meta" / "index.sqlite"
    try:
        db.parent.mkdir(exist_ok=True)
        con = sqlite3.connect(db, timeout=5)
        con.execute("CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY, mtime INTEGER, size INTEGER)")
        con.execute("CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, file TEXT, body TEXT)")
        stored = {r[0]: (r[1], r[2]) for r in con.execute("SELECT name, mtime, size FROM files")}
        if sig and stored == sig:
            tasks = []
            for fname, body in con.execute("SELECT file, body FROM tasks"):
                t = json.loads(body)
                t["_loc"], t["_file"] = f"tasks/{fname}", fname
                tasks.append(t)
            con.close()
            return tasks, {t["id"]: t for t in tasks}
        tasks, by_id = load_tasks(root)
        con.execute("DELETE FROM files")
        con.execute("DELETE FROM tasks")
        con.executemany("INSERT INTO files VALUES (?,?,?)",
                        [(n, m, s) for n, (m, s) in sig.items()])
        con.executemany("INSERT INTO tasks VALUES (?,?,?)",
                        [(t["id"], t["_file"], json.dumps(strip_private(t), ensure_ascii=False))
                         for t in tasks])
        con.commit()
        con.close()
        return tasks, by_id
    except Exception as exc:
        print(
            f"warning: area=uvp.task-index severity=warning context=sqlite-fallback error={exc}",
            file=sys.stderr,
        )
        return load_tasks(root)


def write_module_tasks(root, module, records):
    path = root / "tasks" / f"{module}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".jsonl.tmp")
    body = "".join(json.dumps(strip_private(r), ensure_ascii=False, sort_keys=True) + "\n"
                   for r in sorted(records, key=lambda r: r["id"]))
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)


def strip_private(t):
    return {k: v for k, v in t.items() if not k.startswith("_")}


def journal(root, action, tid, agent=None, detail=None):
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    entry = {"ts": now(), "action": action, "id": tid}
    if agent:
        entry["agent"] = agent
    if detail:
        entry["detail"] = detail
    with (meta / "journal.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def m_num(milestone):
    return int(milestone[1:])


def est_of(t):
    return t.get("est_minutes") or COMPLEXITY_EST.get(t.get("complexity"), 60)


# ---------------------------------------------------------------- templates

def load_templates(root):
    """Skill templates + project overrides; files with `"library": true`
    provide shared steps addressable via {"$ref": "<slug>"} composition."""
    templates, library = {}, {}
    for d in (SKILL_DIR / "templates", root / "templates"):
        if d.is_dir():
            for f in sorted(d.glob("*.json")):
                t = load_json(f, f"template {f.name}")
                if t.get("library"):
                    library.update(t.get("steps", {}))
                elif t.get("applies_to"):
                    templates[t["applies_to"]] = t
    return templates, library


def resolve_step(step, library, where, problems):
    if "$ref" not in step:
        return step
    base = library.get(step["$ref"])
    if base is None:
        problems.append(f"{where}: unknown template $ref `{step['$ref']}`")
        return None
    merged = {**base, **{k: v for k, v in step.items() if k != "$ref"}}
    merged.setdefault("slug", step["$ref"])
    return merged


def shift_complexity(comp, shift):
    if not shift or comp not in COMPLEXITIES:
        return comp
    return COMPLEXITIES[max(0, min(4, COMPLEXITIES.index(comp) + shift))]


def interpolate(text, ctx, where, problems):
    def sub(m):
        key = m.group(1)
        if key in ctx:
            return str(ctx[key])
        problems.append(f"{where}: unknown template variable {{{key}}}")
        return m.group(0)
    return re.sub(r"\{([a-z0-9_]+)\}", sub, text)


def expand_gates(gates, ctx, module, where, problems):
    out = []
    for g in gates:
        if g == "{module_gates}":
            out.extend(module["gates"] or ["module gates (define in modules.json)"])
        else:
            out.append(interpolate(g, ctx, where, problems))
    return out or ["module gates (define in modules.json)"]


# ---------------------------------------------------------------- expand

def build_planned(root, problems):
    """Compute the full cross-product: inventories x templates -> records."""
    mmap = load_module_map(root)
    mods = load_modules(root, mmap)
    templates, library = load_templates(root)
    product = mmap.get("product", {})
    platforms = product.get("platforms", [])
    product_shift = product.get("calibration", {}).get("complexity_shift", 0)
    inv_dir = root / "inventories"
    if not inv_dir.is_dir():
        die("no inventories/ directory — build inventories before expanding")
    planned = {}

    for inv_file in sorted(inv_dir.glob("*.json")):
        inv = load_json(inv_file, f"inventory {inv_file.name}")
        itype = inv.get("type")
        tpl = templates.get(itype)
        if tpl is None:
            problems.append(f"{inv_file.name}: no template for type `{itype}` — items skipped")
            continue
        for item in inv.get("items", []):
            islug, imod = item.get("slug"), item.get("module")
            if not islug or not SLUG_RE.match(islug):
                problems.append(f"{inv_file.name}: item missing/invalid slug: {str(item)[:80]}")
                continue
            if imod not in mods:
                problems.append(f"{inv_file.name}:{islug}: module `{imod}` not in modules.json")
                continue
            module = mods[imod]
            shift = product_shift + module.get("calibration", {}).get("complexity_shift", 0)
            base_ctx = {"name": item.get("name", islug), "slug": islug, "module": imod,
                        "path": item.get("path", f"<{imod}>"), "type": itype}
            base_ctx.update(item.get("vars", {}))
            skip = set(item.get("skip_steps", []))
            overrides = item.get("overrides", {})
            for raw_step in tpl["steps"]:
                step = resolve_step(raw_step, library, f"{itype}/{islug}", problems)
                if step is None or step["slug"] in skip:
                    continue
                step_platforms = step.get("platforms")
                if step_platforms and platforms and not set(step_platforms) & set(platforms):
                    continue
                if step.get("per_platform") and platforms:
                    fan = [p for p in platforms
                           if not step_platforms or p in step_platforms]
                    variants = [(f"{step['slug']}-{p}", p) for p in fan]
                else:
                    variants = [(step["slug"], None)]
                for vslug, platform in variants:
                    rec = build_record(step, vslug, platform, item, islug, itype, tpl,
                                       module, imod, base_ctx, overrides, shift, problems)
                    planned[rec["id"]] = rec
    return planned


def build_record(step, vslug, platform, item, islug, itype, tpl, module, imod,
                 base_ctx, overrides, shift, problems):
    sslug = step["slug"]
    ov = overrides.get(sslug, {})
    where = f"{itype}/{islug}#{vslug}"
    ctx = dict(base_ctx)
    if platform:
        ctx["platform"] = platform
    tid = f"UV-{module['code']}-{islug}-{vslug}"
    comp = ov.get("complexity") or shift_complexity(step.get("complexity", "C3"), shift)
    milestone = item.get("milestone", tpl.get("default_milestone", "M1"))
    if step.get("milestone_min"):
        milestone = max(milestone, step["milestone_min"], key=m_num)
    milestone = ov.get("milestone", milestone)
    deps = []
    for d in step.get("depends_on", []):
        deps.append(f"UV-{module['code']}-{islug}-{d[1:]}" if d.startswith("#") else d)
    dep_var = step.get("depends_from_var")
    if dep_var:
        extra = ctx.get(dep_var)
        if extra:
            deps.extend(extra if isinstance(extra, list) else [extra])
    if not deps and item.get("depends_on"):
        # Item-level foundation deps (e.g. shell i18n/bootstrap tasks) attach to the
        # item's entry steps; sibling-dep'd steps inherit them transitively.
        deps = list(item["depends_on"])
    paid = list(step.get("paid", []))
    pvar = step.get("paid_from_var")
    if pvar and ctx.get(pvar) in PAID:
        paid.append(ctx[pvar])
    prompt = step.get("prompt")
    if step.get("prompt_from_var"):
        prompt = ctx.get(step["prompt_from_var"]) or prompt
    title = interpolate(step["title"], ctx, where, problems)
    if platform:
        title = f"{title} [{platform}]"
    rec = {
        "id": tid, "title": title,
        "description": interpolate(step["description"], ctx, where, problems),
        "module": imod, "domain": step.get("domain", "backend"),
        "lane": step.get("lane", module["lane_default"]),
        "milestone": milestone, "complexity": comp,
        "model_tier": ov.get("model_tier", COMPLEXITY_TIER.get(comp, "sonnet")),
        "status": "todo", "depends_on": deps,
        "vision": item.get("vision", []), "gaps": item.get("gaps", []),
        "acceptance_criteria": [interpolate(a, ctx, where, problems)
                                for a in step.get("acceptance_criteria", [])],
        "test_plan": step.get("test_plan"),
        "gates": expand_gates(step.get("gates", []), ctx, module, where, problems),
        "files_touched": [item["path"]] if item.get("path") else [],
        "external_tools": step.get("external_tools", []),
        "paid": paid, "prompt": prompt,
        "est_minutes": ov.get("est_minutes",
                              step.get("est_minutes", COMPLEXITY_EST.get(comp, 60))),
        "template": f"{itype}@{tpl.get('version', 1)}#{sslug}",
        "inventory_ref": f"{itype}/{islug}", "platform": platform,
        "schema_version": SCHEMA_VERSION,
        "claimed_by": None, "claimed_at": None, "evidence": None,
        "obsolete_reason": None, "lease": None, "verified_by": None,
    }
    rec["spec_hash"] = spec_hash(rec)
    return rec


def cmd_expand(args, root):
    problems = []
    planned = build_planned(root, problems)
    _, by_id = load_tasks(root)

    if args.dry_run:
        new = [r for r in planned.values() if r["id"] not in by_id]
        drifted = [r["id"] for r in planned.values()
                   if r["id"] in by_id and by_id[r["id"]].get("spec_hash")
                   and by_id[r["id"]]["spec_hash"] != r["spec_hash"]]
        per_mod, per_tier, total_est = {}, {}, 0
        for r in new:
            per_mod[r["module"]] = per_mod.get(r["module"], 0) + 1
            per_tier[r["model_tier"]] = per_tier.get(r["model_tier"], 0) + 1
            total_est += r["est_minutes"]
        print(f"projection: {len(planned)} templated task(s) total | {len(new)} would be NEW "
              f"| {len(planned) - len(new)} exist | ~{total_est // 60}h new effort")
        for m in sorted(per_mod):
            print(f"  module {m}: +{per_mod[m]}")
        print("  new by tier: " + ", ".join(f"{t}={n}" for t, n in sorted(per_tier.items())))
        if drifted:
            print(f"  TEMPLATE DRIFT: {len(drifted)} existing task(s) differ from current "
                  f"templates — review, then `expand --update-spec` to adopt: "
                  + ", ".join(drifted[:10]) + (" …" if len(drifted) > 10 else ""))
        for p in problems:
            print(f"  problem: {p}")
        return 1 if problems else 0

    with mutation_lock(root):
        _, by_id = load_tasks(root)
        per_module, new_count, kept, updated = {}, 0, 0, 0
        for t in by_id.values():
            per_module.setdefault(t["module"], {})[t["id"]] = t
        for tid, rec in planned.items():
            existing = per_module.get(rec["module"], {}).get(tid)
            if existing is None:
                per_module.setdefault(rec["module"], {})[tid] = rec
                new_count += 1
            elif args.update_spec:
                for k in ("status", "claimed_by", "claimed_at", "evidence",
                          "obsolete_reason", "lease", "verified_by"):
                    rec[k] = existing.get(k, rec[k])
                per_module[rec["module"]][tid] = rec
                updated += 1
            else:
                kept += 1
        for imod, recs in per_module.items():
            write_module_tasks(root, imod, list(recs.values()))
    print(f"expand: {new_count} new, {kept} unchanged, {updated} spec-updated "
          f"across {len(per_module)} module file(s)")
    for p in problems:
        print(f"  problem: {p}")
    journal(root, "expand", "-",
            detail=f"new={new_count} kept={kept} updated={updated} problems={len(problems)}")
    return 1 if problems else 0


# ---------------------------------------------------------------- validate

def validate_record(t, mods, rep):
    loc = f"{t.get('_loc')} {t.get('id', '?')}"
    for k in REQUIRED:
        if not t.get(k) and t.get(k) != 0:
            rep["errors"].append(f"{loc}: missing required field `{k}`")
    tid = t.get("id", "")
    if tid and not ID_RE.match(tid):
        rep["errors"].append(f"{loc}: id does not match UV-<CODE>-<slug> pattern")
    mod = mods.get(t.get("module"))
    if mod is None:
        rep["errors"].append(f"{loc}: module `{t.get('module')}` not in modules.json")
    elif tid and not tid.startswith(f"UV-{mod['code']}-"):
        rep["errors"].append(f"{loc}: id code does not match module code UV-{mod['code']}-*")
    if t.get("_file", "").removesuffix(".jsonl") != t.get("module"):
        rep["errors"].append(f"{loc}: task lives in {t.get('_file')} but module is `{t.get('module')}`")
    if t.get("domain") not in DOMAINS:
        rep["errors"].append(f"{loc}: domain `{t.get('domain')}` not in enum")
    if t.get("lane") not in LANES:
        rep["errors"].append(f"{loc}: lane `{t.get('lane')}` not in enum")
    if not MILESTONE_RE.match(t.get("milestone", "")):
        rep["errors"].append(f"{loc}: milestone must match M<number>")
    if t.get("complexity") not in COMPLEXITY_TIER:
        rep["errors"].append(f"{loc}: complexity `{t.get('complexity')}` not in C1..C5")
    if t.get("model_tier") not in TIERS:
        rep["errors"].append(f"{loc}: model_tier `{t.get('model_tier')}` not in enum")
    if t.get("status") not in STATUSES:
        rep["errors"].append(f"{loc}: status `{t.get('status')}` not in enum")
    bad_paid = set(t.get("paid", [])) - PAID
    if bad_paid:
        rep["errors"].append(f"{loc}: unknown paid service(s): {sorted(bad_paid)}")
    if t.get("paid") and not t.get("prompt"):
        rep["errors"].append(f"{loc}: paid task without ready-to-run `prompt`")
    if t.get("status") in ("done", "verified") and not t.get("evidence"):
        rep["errors"].append(f"{loc}: status {t['status']} without `evidence`")
    if t.get("status") == "obsolete" and not t.get("obsolete_reason"):
        rep["errors"].append(f"{loc}: obsolete without `obsolete_reason`")
    if t.get("status") == "claimed" and not t.get("claimed_by"):
        rep["warnings"].append(f"{loc}: claimed without `claimed_by`")
    if not t.get("vision") and not t.get("gaps"):
        rep["warnings"].append(f"{loc}: no vision/gap traceability")
    if t.get("spec_hash") and spec_hash(t) != t["spec_hash"]:
        rep["warnings"].append(f"{loc}: spec fields changed outside expansion "
                               f"(hand-edit?) — review, then `uvp migrate --rehash` to accept")


def norm_title(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", s.lower()).split())


def cmd_validate(args, root):
    rep = {"errors": [], "warnings": [], "info": []}
    for doc in REQUIRED_DOCS:
        if not (root / doc).is_file():
            rep["errors"].append(f"{doc}: required document missing")
    if not (root / "INDEX.md").is_file():
        rep["info"].append("INDEX.md missing (normal before P9 — `uvp render` writes it)")
    if not (root / "modules.json").is_file():
        rep["errors"].append("modules.json missing (module map is the grouping contract)")
        return finish_report(root, rep, args, tasks=[])
    mmap = load_module_map(root)
    mods = load_modules(root, mmap)
    tasks, by_id = load_tasks(root, rep)

    inv_items = set()
    inv_dir = root / "inventories"
    if inv_dir.is_dir():
        for f in sorted(inv_dir.glob("*.json")):
            inv = json.loads(f.read_text(encoding="utf-8"))
            for item in inv.get("items", []):
                inv_items.add(f"{inv.get('type')}/{item.get('slug')}")

    # Vision registry (meta/vision.json): refs must exist and not be vetoed.
    vpath = root / "meta" / "vision.json"
    pillar_status = None
    if vpath.is_file():
        vreg = json.loads(vpath.read_text(encoding="utf-8"))
        pillar_status = {p["id"]: p.get("status", "proposed")
                         for p in vreg.get("pillars", [])}
    else:
        rep["info"].append("no meta/vision.json registry — vision refs are unchecked "
                           "(G1 should write it: pillars with approved/vetoed status)")
    pipeline_mode = None
    ppath = root / "meta" / "pipeline-state.json"
    if ppath.is_file():
        try:
            pipeline_mode = json.loads(ppath.read_text(encoding="utf-8")).get("mode")
        except json.JSONDecodeError:
            rep["warnings"].append("meta/pipeline-state.json is not valid JSON")

    no_schema_version = 0
    for t in tasks:
        validate_record(t, mods, rep)
        if t.get("schema_version") != SCHEMA_VERSION:
            no_schema_version += 1
        ref = t.get("inventory_ref")
        if ref and inv_items and ref not in inv_items:
            rep["warnings"].append(
                f"{t['_loc']} {t['id']}: inventory_ref `{ref}` no longer exists — mark obsolete or restore item")
        if pillar_status is not None:
            for v in t.get("vision", []):
                if v not in pillar_status:
                    rep["warnings"].append(f"{t['_loc']} {t['id']}: vision ref `{v}` not in registry")
                elif pillar_status[v] == "vetoed":
                    rep["errors"].append(f"{t['_loc']} {t['id']}: references VETOED pillar `{v}` "
                                         f"— vetoed scope must not re-enter the plan")
    if no_schema_version:
        rep["info"].append(f"{no_schema_version} task(s) below schema v{SCHEMA_VERSION} "
                           f"— run `uvp migrate` to stamp versions and spec hashes")

    # Pillar → task coverage: an approved pillar with zero tasks means part of the
    # vision (possibly user-contributed at G1) never reached the tasklists.
    if pillar_status:
        pillar_tasks = {}
        for t in tasks:
            if t.get("status") != "obsolete":
                for v in t.get("vision", []):
                    pillar_tasks[v] = pillar_tasks.get(v, 0) + 1
        sink = rep["info"] if pipeline_mode == "pilot" else rep["warnings"]
        for pid, status in sorted(pillar_status.items()):
            if status == "approved" and not pillar_tasks.get(pid):
                sink.append(f"approved pillar {pid} has ZERO tasks — this part of the "
                            f"vision is not incorporated into the tasklists"
                            + (" (pilot: deferred scope)" if pipeline_mode == "pilot" else ""))

    # SMA mechanical compliance: hot paths, ownership, media classification
    hot_paths = mmap.get("hot_paths", [])
    product = mmap.get("product", {})
    media_class = product.get("media_class")
    if media_class not in ("visual", "utility", None):
        rep["errors"].append("modules.json: product.media_class must be `visual` or `utility`")
    if media_class is None:
        rep["info"].append("modules.json has no product.media_class — classify the product "
                           "per media-pipeline rules so media tasks are mechanically checkable")
    waivers = set()
    wpath = root / "meta" / "waivers.json"
    if wpath.is_file():
        for w in json.loads(wpath.read_text(encoding="utf-8")):
            waivers.add((w.get("module"), w.get("category")))
    for t in tasks:
        loc = f"{t['_loc']} {t.get('id')}"
        mod = mods.get(t.get("module"))
        files = t.get("files_touched", [])
        if hot_paths and files and t.get("lane") != "shared-hot-path" \
                and any(path_matches(p, hot_paths) for p in files):
            rep["errors"].append(f"{loc}: touches a declared hot path but lane is "
                                 f"`{t.get('lane')}` — must be shared-hot-path")
        if mod and mod.get("ownership") and t.get("lane") == "single-module":
            outside = [p for p in files if not path_matches(p, mod["ownership"])]
            if outside:
                rep["warnings"].append(f"{loc}: single-module task touches paths outside "
                                       f"`{t['module']}` ownership: {outside[:3]}")
        if media_class == "utility" and (t.get("domain") == "media" or t.get("paid")) \
                and (t.get("module"), "media") not in waivers:
            rep["errors"].append(f"{loc}: media/paid task in a utility-class product "
                                 f"(media-pipeline rule) — remove or waive with rationale")
    if media_class == "visual" and not any(t.get("domain") == "media" for t in tasks) \
            and not any("media-asset" in i for i in inv_items) \
            and not any(c == "media" for _, c in waivers):
        rep["warnings"].append("product.media_class is `visual` but the plan has zero media "
                               "tasks and no media-asset inventory — forgotten media pipeline, "
                               "wrong classification, or missing pilot-deferred waiver")

    # DAG + allowed dependency directions + obsolete deps
    cross = 0
    edges = {}
    for t in tasks:
        tid = t.get("id")
        deps = []
        mod = mods.get(t.get("module"), {})
        allowed = mod.get("allowed_deps")
        for d in t.get("depends_on", []):
            dt = by_id.get(d)
            if dt is None:
                rep["errors"].append(f"{t['_loc']} {tid}: dep `{d}` does not exist")
                continue
            deps.append(d)
            if dt.get("status") == "obsolete" and t.get("status") in ("todo", "claimed"):
                rep["info"].append(f"{tid}: depends on obsolete `{d}` — review whether "
                                   f"this task still makes sense")
            if dt["module"] != t["module"]:
                cross += 1
                if allowed is not None and dt["module"] not in allowed:
                    rep["errors"].append(
                        f"{t['_loc']} {tid}: forbidden dependency direction "
                        f"`{t['module']}` -> `{dt['module']}` (not in allowed_deps)")
        edges[tid] = deps
    if cross:
        rep["info"].append(f"{cross} cross-module dependency edge(s) — see `uvp topo` for wave ordering")
    indeg = {tid: len(d) for tid, d in edges.items()}
    dependents = {}
    for tid, deps in edges.items():
        for d in deps:
            dependents.setdefault(d, []).append(tid)
    queue = [tid for tid, n in indeg.items() if n == 0]
    seen = 0
    while queue:
        cur = queue.pop()
        seen += 1
        for nxt in dependents.get(cur, []):
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                queue.append(nxt)
    if seen != len(edges):
        cyc = sorted(tid for tid, n in indeg.items() if n > 0)
        rep["errors"].append(f"dependency cycle involving {len(cyc)} task(s): "
                             + ", ".join(cyc[:20]) + (" …" if len(cyc) > 20 else ""))

    # Lints (info by default; --pedantic promotes to warnings):
    lint_sink = rep["warnings"] if args.pedantic else rep["info"]
    # near-duplicate titles (padding detector)
    groups = {}
    for t in tasks:
        if t.get("status") == "obsolete":
            continue
        groups.setdefault(norm_title(t.get("title", "")), []).append(t["id"])
    dupes = {k: v for k, v in groups.items() if k and len(v) > 1}
    for k, ids in sorted(dupes.items())[:20]:
        lint_sink.append(f"near-duplicate title x{len(ids)}: \"{k[:60]}\" — " + ", ".join(ids[:5]))
    if len(dupes) > 20:
        lint_sink.append(f"… {len(dupes) - 20} more near-duplicate title groups")
    # same-file open tasks without ordering (worktree conflict risk).
    # Steps of one inventory item are sibling-disciplined by design — dedupe to one
    # representative per inventory_ref so only genuine cross-item risks surface.
    by_path = {}
    for t in tasks:
        if t.get("status") in ("todo", "claimed"):
            for p in t.get("files_touched", []):
                by_path.setdefault(p, []).append(t)
    conflict_count = 0
    for p, group in sorted(by_path.items()):
        reps, seen_refs = [], set()
        for x in group:
            ref = x.get("inventory_ref")
            if ref is None:
                reps.append(x)
            elif ref not in seen_refs:
                seen_refs.add(ref)
                reps.append(x)
        ts = reps
        if len(ts) < 2:
            continue
        ids = {x["id"] for x in ts}
        unordered = any(not (set(a.get("depends_on", [])) & ids or
                             any(a["id"] in x.get("depends_on", []) for x in ts))
                        for a in ts)
        if unordered:
            conflict_count += 1
            if conflict_count <= 20:
                lint_sink.append(f"unordered co-edit risk on `{p}`: "
                                 + ", ".join(sorted(x["id"] for x in ts)[:5]))
    if conflict_count > 20:
        lint_sink.append(f"… {conflict_count - 20} more unordered co-edit paths")

    # Coverage matrix: module x quality category
    cov = {m: {c: 0 for c in COVERAGE_CATEGORIES} for m in mods}
    for t in tasks:
        if t.get("module") in cov and t.get("domain") in COVERAGE_CATEGORIES:
            cov[t["module"]][t["domain"]] += 1
    for m, row in cov.items():
        for c, n in row.items():
            if n == 0 and (m, c) not in waivers:
                rep["warnings"].append(
                    f"coverage: module `{m}` has no `{c}` tasks and no waiver in meta/waivers.json")

    return finish_report(root, rep, args, tasks)


def finish_report(root, rep, args, tasks):
    strict = args.strict
    passed = not rep["errors"] and not (strict and rep["warnings"])
    out = {"generated": now(), "root": str(root.resolve()), "strict": strict,
           "pedantic": getattr(args, "pedantic", False), "pass": passed,
           "task_count": len(tasks), "error_count": len(rep["errors"]),
           "warning_count": len(rep["warnings"]), **rep}
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    (meta / "validation-report.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"validate: {len(tasks)} task(s) | errors {len(rep['errors'])} | "
          f"warnings {len(rep['warnings'])} | info {len(rep['info'])}"
          f"{' (strict)' if strict else ''}{' (pedantic)' if getattr(args, 'pedantic', False) else ''}")
    for e in rep["errors"][:50]:
        print(f"  ERROR {e}")
    if len(rep["errors"]) > 50:
        print(f"  … {len(rep['errors']) - 50} more (meta/validation-report.json)")
    for w in rep["warnings"][:20]:
        print(f"  warn  {w}")
    if len(rep["warnings"]) > 20:
        print(f"  … {len(rep['warnings']) - 20} more (meta/validation-report.json)")
    for i in rep["info"][:10]:
        print(f"  info  {i}")
    if len(rep["info"]) > 10:
        print(f"  … {len(rep['info']) - 10} more info (meta/validation-report.json)")
    print("  RESULT:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


# ---------------------------------------------------------------- stats/render/topo

def compute_stats(tasks):
    def tally(fn):
        out = {}
        for t in tasks:
            k = fn(t)
            out[k] = out.get(k, 0) + 1
        return dict(sorted(out.items()))
    active = [t for t in tasks if t.get("status") != "obsolete"]
    done = [t for t in tasks if t.get("status") in ("done", "verified")]
    stats = {
        "generated": now(),
        "totals": {"tasks": len(tasks), "active": len(active), "done": len(done),
                   "obsolete": len(tasks) - len(active),
                   "percent_complete": round(100 * len(done) / len(active), 2) if active else 0.0,
                   "est_minutes_remaining": sum(est_of(t) for t in active
                                                if t.get("status") not in ("done", "verified"))},
        "by_status": tally(lambda t: t.get("status", "?")),
        "by_complexity": tally(lambda t: t.get("complexity", "?")),
        "by_model_tier": tally(lambda t: t.get("model_tier", "?")),
        "by_module": tally(lambda t: t.get("module", "?")),
        "by_domain": tally(lambda t: t.get("domain", "?")),
        "by_lane": tally(lambda t: t.get("lane", "?")),
        "by_milestone": tally(lambda t: t.get("milestone", "?")),
        "paid_tasks": sum(1 for t in tasks if t.get("paid")),
    }
    if any(t.get("platform") for t in tasks):
        stats["by_platform"] = tally(lambda t: t.get("platform") or "-")
    return stats


def write_stats(root, tasks):
    stats = compute_stats(tasks)
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    (meta / "stats.json").write_text(json.dumps(stats, indent=2) + "\n", encoding="utf-8")
    return stats


def cmd_stats(args, root):
    tasks, _ = load_tasks_fast(root)
    stats = write_stats(root, tasks)
    print(json.dumps(stats["totals"], indent=2))
    return 0


CHECKBOX = {"todo": "[ ]", "claimed": "[ ]", "done": "[x]", "verified": "[x]", "obsolete": "[-]"}


def cmd_render(args, root):
    mods = load_modules(root)
    tasks, _ = load_tasks(root)
    stats = write_stats(root, tasks)

    banner = ("<!-- GENERATED by uvp render from tasks/*.jsonl — do not hand-edit. -->\n"
              "<!-- Change tasks via `uvp claim/complete/verify/obsolete` or re-expansion. -->\n\n")
    by_mod = {}
    for t in tasks:
        by_mod.setdefault(t["module"], []).append(t)
    for mod, mts in sorted(by_mod.items()):
        mdir = root / "tasklists" / mod
        mdir.mkdir(parents=True, exist_ok=True)
        by_dom = {}
        for t in mts:
            by_dom.setdefault(t["domain"], []).append(t)
        for dom, dts in sorted(by_dom.items()):
            lines = [banner + f"# {mod} · {dom} — {len(dts)} task(s)\n"]
            for ms in sorted({t["milestone"] for t in dts}, key=m_num):
                lines.append(f"\n## {ms}\n")
                for t in sorted((x for x in dts if x["milestone"] == ms), key=lambda x: x["id"]):
                    title = t["title"]
                    if t["status"] == "obsolete":
                        title = f"~~{title}~~ (obsolete: {t.get('obsolete_reason')})"
                    dep = f" · deps: {', '.join(t['depends_on'])}" if t.get("depends_on") else ""
                    paidmark = f" · PAID:{'+'.join(t['paid'])}" if t.get("paid") else ""
                    lines.append(f"- {CHECKBOX[t['status']]} **{t['id']}** ({t['complexity']}→{t['model_tier']})"
                                 f" {title}{dep}{paidmark}")
            (mdir / f"{dom}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    tot = stats["totals"]
    idx = ["<!-- GENERATED by uvp render — hand-written guidance belongs in meta/index-notes.md -->",
           "# UltraVision Index", "",
           f"> Generated {stats['generated']} · validator: see meta/validation-report.json", "",
           f"**{tot['tasks']} tasks** · {tot['done']} done · {tot['percent_complete']}% complete · "
           f"~{tot['est_minutes_remaining'] // 60}h estimated remaining"
           + (f" · {stats['paid_tasks']} paid task(s) awaiting batch approval" if stats["paid_tasks"] else ""),
           ""]
    topo_path = root / "meta" / "topo.json"
    if topo_path.is_file():
        tp = json.loads(topo_path.read_text(encoding="utf-8"))
        idx += [f"Critical path: **{tp.get('critical_path_minutes', 0)} min** across "
                f"{len(tp.get('critical_path', []))} task(s) · {tp.get('waves', 0)} parallel wave(s)", ""]
    idx += ["## Delegation map (complexity → model tier)", "",
            "| Complexity | Tasks | Tier |", "| --- | --- | --- |"]
    for c in COMPLEXITIES:
        idx.append(f"| {c} | {stats['by_complexity'].get(c, 0)} | {COMPLEXITY_TIER[c]}"
                   f"{' + controller review' if c == 'C5' else ''} |")
    idx += ["", "## Modules", "", "| Module | Tasks | Lane default | Charter |", "| --- | --- | --- | --- |"]
    for mid in sorted(mods):
        idx.append(f"| {mid} | {stats['by_module'].get(mid, 0)} | {mods[mid]['lane_default']} "
                   f"| tasklists/{mid}/_MODULE.md |")
    idx += ["", "## By milestone", "", "| Milestone | Tasks |", "| --- | --- |"]
    for ms in sorted(stats["by_milestone"], key=lambda s: m_num(s) if MILESTONE_RE.match(s) else 99):
        idx.append(f"| {ms} | {stats['by_milestone'][ms]} |")
    notes = root / "meta" / "index-notes.md"
    if notes.is_file():
        idx += ["", notes.read_text(encoding="utf-8").strip()]
    (root / "INDEX.md").write_text("\n".join(idx) + "\n", encoding="utf-8")
    print(f"render: {len(by_mod)} module view set(s) + INDEX.md + meta/stats.json")
    return 0


def active_graph(tasks):
    active = {t["id"]: t for t in tasks if t.get("status") != "obsolete"}
    deps = {tid: [d for d in t.get("depends_on", []) if d in active]
            for tid, t in active.items()}
    return active, deps


def topo_waves(active, deps):
    indeg = {tid: len(d) for tid, d in deps.items()}
    dependents = {}
    for tid, ds in deps.items():
        for d in ds:
            dependents.setdefault(d, []).append(tid)
    wave_index, frontier, wave = {}, sorted(t for t, n in indeg.items() if n == 0), 0
    while frontier:
        nxt = []
        for tid in frontier:
            wave_index[tid] = wave
            for dep in dependents.get(tid, []):
                indeg[dep] -= 1
                if indeg[dep] == 0:
                    nxt.append(dep)
        frontier, wave = sorted(nxt), wave + 1
    return wave_index, wave, dependents


def forward_scores(active, deps):
    """Downstream-unlock weight: est of the longest chain STARTING at each task.
    High score = completing this task shortens the wall-clock most."""
    wave_index, _, dependents = topo_waves(active, deps)
    if len(wave_index) != len(active):
        return None  # cycle
    score = {}
    for tid in sorted(wave_index, key=lambda x: -wave_index[x]):
        down = max((score[d] for d in dependents.get(tid, [])), default=0)
        score[tid] = est_of(active[tid]) + down
    return score


def cmd_topo(args, root):
    tasks, _ = load_tasks(root)
    active, deps = active_graph(tasks)
    wave_index, wave, _ = topo_waves(active, deps)
    if len(wave_index) != len(active):
        die("cycle detected — run `uvp validate` for the involved tasks")
    dist, parent = {}, {}
    for tid in sorted(wave_index, key=lambda x: wave_index[x]):
        best, bp = 0, None
        for d in deps[tid]:
            if dist[d] > best:
                best, bp = dist[d], d
        dist[tid] = best + est_of(active[tid])
        parent[tid] = bp
    if dist:
        end = max(dist, key=lambda x: dist[x])
        path, cur = [], end
        while cur:
            path.append(cur)
            cur = parent[cur]
        path.reverse()
    else:
        path, end = [], None
    out = {"generated": now(), "waves": wave,
           "wave_sizes": [sum(1 for w in wave_index.values() if w == i) for i in range(wave)],
           "critical_path_minutes": dist.get(end, 0), "critical_path": path,
           "wave_index": wave_index}
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    (meta / "topo.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"topo: {wave} wave(s), critical path {dist.get(end, 0)} min across {len(path)} task(s)")
    return 0


# ---------------------------------------------------------------- consumer contract

def ready_tasks(tasks, by_id):
    satisfied = {"done", "verified", "obsolete"}
    out = []
    for t in tasks:
        if t.get("status") != "todo":
            continue
        if all(by_id.get(d, {}).get("status") in satisfied for d in t.get("depends_on", [])):
            out.append(t)
    return out


def cmd_next(args, root):
    tasks, by_id = load_tasks_fast(root)
    ready = ready_tasks(tasks, by_id)
    if args.module:
        ready = [t for t in ready if t["module"] == args.module]
    if args.tier:
        ready = [t for t in ready if t["model_tier"] == args.tier]
    if args.milestone:
        ready = [t for t in ready if t["milestone"] == args.milestone]
    prio_rank = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    if args.critical:
        active, deps = active_graph(tasks)
        scores = forward_scores(active, deps) or {}
        ready.sort(key=lambda t: (-scores.get(t["id"], 0), m_num(t["milestone"]), t["id"]))
    else:
        ready.sort(key=lambda t: (m_num(t["milestone"]),
                                  prio_rank.get(t.get("prio", "P2"), 2), t["id"]))
    for t in ready[: args.limit]:
        print(json.dumps(strip_private(t), ensure_ascii=False, sort_keys=True))
    print(f"# {min(len(ready), args.limit)} of {len(ready)} ready task(s)", file=sys.stderr)
    return 0


def cmd_dispatch(args, root):
    """Wave manifest: per-module ready queues for parallel agents, shared-hot-path
    serialized to a controller queue, respecting the Gen3 one-owner-per-module rule."""
    tasks, by_id = load_tasks_fast(root)
    ready = ready_tasks(tasks, by_id)
    if args.milestone:
        ready = [t for t in ready if t["milestone"] == args.milestone]
    active, deps = active_graph(tasks)
    scores = forward_scores(active, deps) or {}
    serial = sorted((t for t in ready if t["lane"] == "shared-hot-path"),
                    key=lambda t: -scores.get(t["id"], 0))
    per_mod = {}
    for t in ready:
        if t["lane"] != "shared-hot-path":
            per_mod.setdefault(t["module"], []).append(t)
    for mts in per_mod.values():
        mts.sort(key=lambda t: -scores.get(t["id"], 0))
    ranked_modules = sorted(per_mod, key=lambda m: -max((scores.get(t["id"], 0)
                                                          for t in per_mod[m]), default=0))
    assignments = []
    for slot, mod in enumerate(ranked_modules[: args.ceiling], 1):
        batch = per_mod[mod][: args.batch]
        assignments.append({"agent_slot": slot, "module": mod,
                            "tasks": [t["id"] for t in batch],
                            "tiers": sorted({t["model_tier"] for t in batch}),
                            "est_minutes": sum(est_of(t) for t in batch)})
    out = {"generated": now(), "ceiling": args.ceiling, "batch": args.batch,
           "milestone": args.milestone,
           "controller_serial_queue": [t["id"] for t in serial[: args.batch]],
           "assignments": assignments,
           "overflow_modules": ranked_modules[args.ceiling:]}
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    (meta / "wave.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"dispatch: {len(assignments)} parallel module lane(s) + "
          f"{len(out['controller_serial_queue'])} serialized hot-path task(s) -> meta/wave.json")
    for a in assignments:
        print(f"  slot {a['agent_slot']}: {a['module']} — {len(a['tasks'])} task(s), "
              f"~{a['est_minutes']}min, tiers {'/'.join(a['tiers'])}")
    if out["overflow_modules"]:
        print(f"  waiting modules (over ceiling): {', '.join(out['overflow_modules'])}")
    return 0


def sma_config(root):
    cfg = load_module_map(root).get("sma") or {}
    cp, pid = cfg.get("control_plane"), cfg.get("project_id")
    return (Path(cp), pid) if cp and pid else (None, None)


def sma_start_edit(root, module, title):
    cp, pid = sma_config(root)
    if cp is None:
        die("--lease requires modules.json `sma`: {control_plane, project_id}")
    res = subprocess.run(["npm", "run", "start:edit", "--", "--project", pid,
                          "--brick", f"uv-{module}", "--intent", title[:120]],
                         cwd=cp, capture_output=True, text=True, timeout=120)
    m = re.search(r"acquired (lease-\S+)", res.stdout)
    if res.returncode != 0 or not m:
        tail = (res.stdout + res.stderr)[-500:]
        die(f"SMA lease NOT acquired for brick uv-{module} — back off per Gen3 "
            f"conflict rules.\n{tail}", code=1)
    return m.group(1)


def sma_end_edit(root, module, lease, tid):
    cp, pid = sma_config(root)
    if cp is None:
        return False
    res = subprocess.run(["npm", "run", "end:edit", "--", "--lease", lease,
                          "--project", pid, "--brick", f"uv-{module}",
                          "--intent", f"completed {tid}"],
                         cwd=cp, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        print(f"warning: end:edit failed for {lease} — release it manually",
              file=sys.stderr)
        return False
    return True


def transition(root, tid, expect, new, updates, action, agent=None, detail=None, force=False):
    with mutation_lock(root):
        tasks, by_id = load_tasks(root)
        t = by_id.get(tid)
        if t is None:
            die(f"task {tid} not found")
        if t["status"] not in expect and not force:
            die(f"task {tid} is `{t['status']}`, expected {expect} (use --force to override)")
        t.update(updates)
        t["status"] = new
        module = t["module"]
        write_module_tasks(root, module,
                           [strip_private(x) for x in tasks if x["module"] == module])
    journal(root, action, tid, agent=agent, detail=detail)
    print(f"{action}: {tid} -> {new}")
    return t


def run_evidence_cmd(root, cmd):
    res = subprocess.run(cmd, shell=True, cwd=root.parent,
                         capture_output=True, text=True, timeout=1800)
    output = (res.stdout or "") + (res.stderr or "")
    return {"cmd": cmd, "exit": res.returncode, "ts": now(),
            "output_sha256": hashlib.sha256(output.encode()).hexdigest()[:16],
            "output_tail": output[-800:]}


def cmd_claim(args, root):
    _, by_id = load_tasks(root)
    t = by_id.get(args.id)
    if t is None:
        die(f"task {args.id} not found")
    if t["status"] != "todo" and not args.force:
        die(f"task {args.id} is `{t['status']}`, expected todo (use --force to override)")
    updates = {"claimed_by": args.agent, "claimed_at": now()}
    lease = None
    if args.lease:
        lease = sma_start_edit(root, t["module"], t["title"])
        updates["lease"] = lease
    try:
        transition(root, args.id, {"todo"}, "claimed", updates, "claim",
                   agent=args.agent, force=args.force)
    except SystemExit:
        # Lost the claim race after acquiring the SMA lease — release it so the
        # brick isn't leaked, then propagate the failure.
        if lease:
            sma_end_edit(root, t["module"], lease, args.id)
            print(f"released orphaned lease {lease}", file=sys.stderr)
        raise
    return 0


def cmd_complete(args, root):
    if not args.evidence and not args.evidence_cmd:
        die("complete requires --evidence and/or --evidence-cmd")
    evidence = None
    if args.evidence_cmd:
        evidence = run_evidence_cmd(root, args.evidence_cmd)
        if evidence["exit"] != 0:
            print(evidence["output_tail"], file=sys.stderr)
            die(f"evidence command failed (exit {evidence['exit']}) — gates must pass "
                f"before a task is done; task stays as-is", code=1)
        if args.evidence:
            evidence["text"] = args.evidence
    else:
        evidence = args.evidence
    t = transition(root, args.id, {"claimed", "todo"}, "done",
                   {"evidence": evidence}, "complete", agent=args.agent,
                   detail=args.evidence or args.evidence_cmd)
    if t.get("lease"):
        if sma_end_edit(root, t["module"], t["lease"], t["id"]):
            transition(root, args.id, {"done"}, "done", {"lease": None},
                       "lease-released", force=True)
    return 0


def cmd_obsolete(args, root):
    _, by_id = load_tasks(root)
    dependents = [x["id"] for x in by_id.values()
                  if args.id in x.get("depends_on", []) and x.get("status") != "obsolete"]
    if dependents:
        print(f"warning: {len(dependents)} open task(s) depend on {args.id}: "
              + ", ".join(dependents[:8]) + (" …" if len(dependents) > 8 else "")
              + " — review them (deps on obsolete tasks are treated as satisfied)")
    transition(root, args.id, set(STATUSES), "obsolete",
               {"obsolete_reason": args.reason}, "obsolete",
               detail=args.reason, force=True)
    return 0


# ---------------------------------------------------------------- reporting/audit

def cmd_report(args, root):
    tasks, by_id = load_tasks_fast(root)
    jpath = root / "meta" / "journal.jsonl"
    events = []
    if jpath.is_file():
        for line_number, line in enumerate(
            jpath.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if line.strip():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    print(
                        "warning: area=uvp.stats severity=warning "
                        f"context=journal-line-{line_number} error={exc}",
                        file=sys.stderr,
                    )
    completes = [e for e in events if e.get("action") == "complete" and e.get("id") in by_id]
    per_day, per_agent, per_tier = {}, {}, {}
    for e in completes:
        day = e["ts"][:10]
        t = by_id[e["id"]]
        per_day[day] = per_day.get(day, 0) + est_of(t)
        per_agent[e.get("agent") or "?"] = per_agent.get(e.get("agent") or "?", 0) + 1
        per_tier[t.get("model_tier", "?")] = per_tier.get(t.get("model_tier", "?"), 0) + 1
    active_days = len(per_day)
    rate = (sum(per_day.values()) / active_days) if active_days else 0  # est-min/day
    remaining_by_ms = {}
    for t in tasks:
        if t.get("status") in ("todo", "claimed"):
            remaining_by_ms[t["milestone"]] = remaining_by_ms.get(t["milestone"], 0) + est_of(t)
    lines = ["# UltraVision Progress Report", "",
             f"> Generated {now()} · {len(completes)} completion(s) journaled "
             f"across {active_days} active day(s)", "",
             f"Observed velocity: **{rate:.0f} est-min/day**" if rate else
             "Observed velocity: no completion data yet", ""]
    if per_agent:
        lines += ["## Throughput", "", "| Agent | Completions |", "| --- | --- |"]
        lines += [f"| {a} | {n} |" for a, n in sorted(per_agent.items(), key=lambda x: -x[1])]
        lines += ["", "| Tier | Completions |", "| --- | --- |"]
        lines += [f"| {a} | {n} |" for a, n in sorted(per_tier.items())]
        lines += [""]
    lines += ["## Remaining effort / ETA per milestone", "",
              "| Milestone | Est remaining | ETA at current velocity |", "| --- | --- | --- |"]
    for ms in sorted(remaining_by_ms, key=m_num):
        rem = remaining_by_ms[ms]
        eta = f"~{rem / rate:.1f} day(s)" if rate else "n/a"
        lines.append(f"| {ms} | ~{rem // 60}h | {eta} |")
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    (meta / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:4]))
    print(f"report: written to meta/report.md "
          f"({len(remaining_by_ms)} milestone(s) with open work)")
    return 0


def cmd_audit_claims(args, root):
    """Trust-but-verify: re-run the recorded evidence commands of sampled
    done/verified tasks and confirm their gates still pass."""
    tasks, _ = load_tasks(root)
    done = [t for t in tasks if t.get("status") in ("done", "verified")]
    auditable = [t for t in done if isinstance(t.get("evidence"), dict)
                 and t["evidence"].get("cmd")]
    rng = random.Random(args.seed)
    sample = rng.sample(auditable, min(args.sample, len(auditable)))
    results, failures = [], 0
    for t in sample:
        res = run_evidence_cmd(root, t["evidence"]["cmd"])
        ok = res["exit"] == 0
        failures += 0 if ok else 1
        results.append({"id": t["id"], "cmd": t["evidence"]["cmd"],
                        "exit": res["exit"], "pass": ok})
        print(f"  {'PASS' if ok else 'FAIL'} {t['id']} ({t['evidence']['cmd']})")
    out = {"generated": now(), "sampled": len(sample), "auditable": len(auditable),
           "unauditable_done": len(done) - len(auditable), "failures": failures,
           "results": results}
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    (meta / "audit-report.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"audit-claims: {len(sample)} sampled, {failures} failure(s), "
          f"{out['unauditable_done']} done task(s) have only textual evidence")
    return 1 if failures else 0


def cmd_migrate(args, root):
    changed = 0
    with mutation_lock(root):
        tasks, _ = load_tasks(root)
        per_module = {}
        for t in tasks:
            rec = strip_private(t)
            before = json.dumps(rec, sort_keys=True)
            for k, v in OPTIONAL_DEFAULTS.items():
                rec.setdefault(k, v)
            rec["schema_version"] = SCHEMA_VERSION
            if args.rehash or not rec.get("spec_hash"):
                rec["spec_hash"] = spec_hash(rec)
            if json.dumps(rec, sort_keys=True) != before:
                changed += 1
            per_module.setdefault(rec["module"], []).append(rec)
        for mod, recs in per_module.items():
            write_module_tasks(root, mod, recs)
    journal(root, "migrate", "-", detail=f"changed={changed} rehash={args.rehash}")
    print(f"migrate: {changed} record(s) updated to schema v{SCHEMA_VERSION}"
          + (" (hashes re-accepted)" if args.rehash else ""))
    return 0


def cmd_drift(args, root):
    """Vision-source drift: compare stored hashes of the files each pillar's
    evidence came from. Drift means the vision may need re-approval."""
    vs = root / "meta" / "vision-sources.json"
    if not vs.is_file():
        die("meta/vision-sources.json not found — P1 should record "
            '{"V-01": {"sources": ["README.md", ...]}} for every pillar')
    data = json.loads(vs.read_text(encoding="utf-8"))
    repo = root.parent
    drifted = []
    for pillar, entry in sorted(data.items()):
        hashes = entry.setdefault("hashes", {})
        for src in entry.get("sources", []):
            p = repo / src
            digest = hashlib.sha256(p.read_bytes()).hexdigest()[:16] if p.is_file() else "MISSING"
            old = hashes.get(src)
            if old is None:
                state = "NEW"
            elif old != digest:
                state = "CHANGED" if digest != "MISSING" else "MISSING"
            else:
                state = "ok"
            if state != "ok":
                drifted.append(f"{pillar}: {src} [{state}]")
            if args.update:
                hashes[src] = digest
    if args.update:
        vs.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print(f"drift: hashes stamped for {len(data)} pillar(s)")
        return 0
    if drifted:
        print("drift: vision sources changed since last stamp — re-run P1 for these "
              "pillars (and gate G1 for the delta):")
        for d in drifted:
            print(f"  {d}")
        return 1
    print("drift: all vision sources unchanged")
    return 0


def cmd_featmap(args, root):
    """SFM round-trip: pillars whose every task is delivered become proposed
    FEATMAP rows (Feature | What it does | Status | Code)."""
    vpath = root / "meta" / "vision.json"
    if not vpath.is_file():
        die("meta/vision.json not found — the G1 gate writes the pillar registry")
    vreg = json.loads(vpath.read_text(encoding="utf-8"))
    tasks, _ = load_tasks_fast(root)
    by_pillar = {}
    for t in tasks:
        if t.get("status") == "obsolete":
            continue
        for v in t.get("vision", []):
            by_pillar.setdefault(v, []).append(t)
    rows, pending = [], []
    for p in vreg.get("pillars", []):
        if p.get("status") == "vetoed":
            continue
        pts = by_pillar.get(p["id"], [])
        done = [t for t in pts if t.get("status") in ("done", "verified")]
        if pts and len(done) == len(pts):
            mods = sorted({t["module"] for t in pts})
            rows.append(f"| {p.get('title', p['id'])} | {p.get('promise', p.get('title', ''))} "
                        f"| live | {', '.join(mods)} |")
        elif pts:
            pending.append(f"{p['id']}: {len(done)}/{len(pts)} tasks delivered")
    lines = ["# FEATMAP proposals (generated by uvp featmap)", "",
             f"> Generated {now()} — pillars with 100% delivered tasks. "
             "Copy curated rows into the repo's /FEATMAP registers (SFM rule: "
             "a feature that is not registered does not exist).", ""]
    if rows:
        lines += ["| Feature | What it does | Status | Code |", "| --- | --- | --- | --- |"] + rows
    else:
        lines += ["No pillar is fully delivered yet."]
    if pending:
        lines += ["", "## In progress"] + [f"- {p}" for p in pending]
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    (meta / "featmap-proposals.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"featmap: {len(rows)} deliverable feature row(s), {len(pending)} in progress "
          f"-> meta/featmap-proposals.md")
    return 0


def cmd_gen3_draft(args, root):
    """Emit a draft sma.gen3.json in the portable SMA Gen3 house format
    (schemaVersion/project/costPolicy/targetConcurrency/moduleDefaults/
    modules[]/sharedHotPaths[] — same shape as existing Gen3 projects)."""
    mmap = load_module_map(root)
    product = mmap.get("product", {})
    pid = product.get("project_id", root.parent.name)
    draft = {
        "$comment": "DRAFT generated by `uvp gen3-draft` from .UltraVision/modules.json. "
                    "Review labels/descriptions and classifier expectations before "
                    "adopting; adopting it is a shared-hot-path (M0) task.",
        "schemaVersion": 1,
        "name": f"{pid} SMA Gen3 Control Plane",
        "version": "draft",
        "portable": True,
        "project": {"id": pid, "graphifyProjectId": pid.lower(),
                    "description": product.get("rationale", "")},
        "costPolicy": {"defaultMode": "free-local-first",
                       "paidServicesEnabledByDefault": False,
                       "paidActivation": "manual-only"},
        "targetConcurrency": {"runnerSwapOnly": {"min": 5, "max": 5},
                              "affectedCacheWorktrees": {"min": 8, "max": 12},
                              "gen3ControlPlane": {"min": 15, "max": 25}},
        "moduleDefaults": {"maxParallelAgents": 2, "requiredLocalGates": []},
        "modules": [{"id": m["id"], "label": m["id"].upper(),
                     "description": f"{m['id']} module (see .UltraVision/tasklists/{m['id']}/_MODULE.md)",
                     "paths": m.get("ownership", []),
                     "requiredLocalGates": m.get("gates", []),
                     "maxParallelAgents": 2}
                    for m in mmap.get("modules", [])],
        "sharedHotPaths": [{"id": f"hot-path-{i + 1}",
                            "label": f"Declared hot path: {p}",
                            "paths": [p], "risk": "high",
                            "requiredGates": ["affected-ci", "merge-queue"]}
                           for i, p in enumerate(mmap.get("hot_paths", []))],
    }
    meta = root / "meta"
    meta.mkdir(exist_ok=True)
    out = meta / "sma.gen3.draft.json"
    out.write_text(json.dumps(draft, indent=2) + "\n", encoding="utf-8")
    print(f"gen3-draft: {out} ({len(draft['modules'])} module(s), "
          f"{len(draft['sharedHotPaths'])} hot path(s), house schema v1)")
    return 0


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(prog="uvp", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=".UltraVision",
                    help="path to .UltraVision (default ./.UltraVision)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("expand")
    p.add_argument("--update-spec", action="store_true",
                   help="refresh spec fields of existing tasks from templates (statuses preserved)")
    p.add_argument("--dry-run", action="store_true",
                   help="print volume/tier/effort projection and template drift; write nothing")
    p = sub.add_parser("validate")
    p.add_argument("--strict", action="store_true")
    p.add_argument("--pedantic", action="store_true",
                   help="promote dedup/co-edit lints from info to warnings")
    sub.add_parser("render")
    sub.add_parser("stats")
    sub.add_parser("topo")
    p = sub.add_parser("migrate")
    p.add_argument("--rehash", action="store_true",
                   help="recompute spec hashes (accept intentional hand-edits)")
    p = sub.add_parser("drift")
    p.add_argument("--update", action="store_true", help="stamp current source hashes")
    p = sub.add_parser("next")
    p.add_argument("--module")
    p.add_argument("--tier", choices=sorted(TIERS))
    p.add_argument("--milestone")
    p.add_argument("--critical", action="store_true",
                   help="order by downstream-unlock weight (critical chain first)")
    p.add_argument("--limit", type=int, default=10)
    p = sub.add_parser("dispatch")
    p.add_argument("--ceiling", type=int, default=8,
                   help="max parallel module lanes (match the repo's Gen3 maturity)")
    p.add_argument("--batch", type=int, default=10, help="tasks per agent slot")
    p.add_argument("--milestone")
    p = sub.add_parser("claim")
    p.add_argument("id")
    p.add_argument("--agent", required=True)
    p.add_argument("--lease", action="store_true",
                   help="acquire the SMA brick lease via modules.json sma config")
    p.add_argument("--force", action="store_true")
    p = sub.add_parser("complete")
    p.add_argument("id")
    p.add_argument("--evidence", help="textual proof")
    p.add_argument("--evidence-cmd", help="gate command to run; must exit 0; recorded as structured evidence")
    p.add_argument("--agent")
    p = sub.add_parser("verify")
    p.add_argument("id")
    p.add_argument("--agent")
    p = sub.add_parser("obsolete")
    p.add_argument("id")
    p.add_argument("--reason", required=True)
    p = sub.add_parser("report")
    p = sub.add_parser("audit-claims")
    p.add_argument("--sample", type=int, default=5)
    p.add_argument("--seed", type=int, default=0)
    p = sub.add_parser("featmap")
    p = sub.add_parser("gen3-draft")

    args = ap.parse_args()
    root = Path(args.root)
    if not root.is_dir():
        die(f"{root} is not a directory")

    if args.cmd == "expand":
        return cmd_expand(args, root)
    if args.cmd == "validate":
        return cmd_validate(args, root)
    if args.cmd == "render":
        return cmd_render(args, root)
    if args.cmd == "stats":
        return cmd_stats(args, root)
    if args.cmd == "topo":
        return cmd_topo(args, root)
    if args.cmd == "migrate":
        return cmd_migrate(args, root)
    if args.cmd == "drift":
        return cmd_drift(args, root)
    if args.cmd == "next":
        return cmd_next(args, root)
    if args.cmd == "dispatch":
        return cmd_dispatch(args, root)
    if args.cmd == "claim":
        return cmd_claim(args, root)
    if args.cmd == "complete":
        return cmd_complete(args, root)
    if args.cmd == "verify":
        transition(root, args.id, {"done"}, "verified",
                   {"verified_by": args.agent or "controller"}, "verify", agent=args.agent)
        return 0
    if args.cmd == "obsolete":
        return cmd_obsolete(args, root)
    if args.cmd == "report":
        return cmd_report(args, root)
    if args.cmd == "audit-claims":
        return cmd_audit_claims(args, root)
    if args.cmd == "featmap":
        return cmd_featmap(args, root)
    if args.cmd == "gen3-draft":
        return cmd_gen3_draft(args, root)
    return 2


if __name__ == "__main__":
    sys.exit(main())
