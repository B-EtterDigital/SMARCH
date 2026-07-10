#!/usr/bin/env python3
"""Golden regression suite for the F5-UltraVisionPlan skill (uvp v2 + templates).

Builds a synthetic .UltraVision fixture in a temp dir and exercises the full
engine contract through the real CLI. Run after ANY edit to scripts/uvp.py or
templates/*.json:

    python3 <skill>/tests/run_tests.py

Exit 0 = all assertions pass. Failures print expected-vs-actual.
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
UVP = SKILL / "scripts" / "uvp.py"

PASSED, FAILED = 0, []


def check(name, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILED.append(f"{name}  {detail}")
        print(f"  FAIL {name}  {detail}")


def run(root, *args, expect=0):
    res = subprocess.run([sys.executable, str(UVP), "--root", str(root), *args],
                         capture_output=True, text=True, timeout=300)
    out = res.stdout + res.stderr
    if expect is not None:
        check(f"exit[{' '.join(args[:2])}]={expect}", res.returncode == expect,
              f"got {res.returncode}: {out[-400:]}")
    return res.returncode, out


def read_tasks(root, module):
    p = root / "tasks" / f"{module}.jsonl"
    return {t["id"]: t for t in
            (json.loads(l) for l in p.read_text().splitlines() if l.strip())}


def build_fixture(base):
    repo = base / "repo"
    root = repo / ".UltraVision"
    (root / "inventories").mkdir(parents=True)
    (root / "meta").mkdir()
    (root / "templates").mkdir()
    (repo / "README.md").write_text("# FixtureGame\nA tiny arcade game.\n")
    for f in ["00-VISION", "01-CURRENT-STATE", "02-GAP-ANALYSIS", "03-TARGET-ARCHITECTURE",
              "04-DESIGN-LANGUAGE", "05-MEDIA-PLAN", "06-I18N-PLAN", "07-PERFORMANCE-PLAN",
              "08-QUALITY-RELEASE-PLAN"]:
        (root / f"{f}.md").write_text(f"# {f}\n")
    (root / "modules.json").write_text(json.dumps({
        "product": {"media_class": "visual", "rationale": "arcade game",
                    "platforms": ["web", "desktop"]},
        "hot_paths": ["package.json", ".github/workflows/**"],
        "modules": [
            {"id": "shell", "code": "SHELL", "ownership": ["src/shell/**", "package.json"],
             "gates": ["true"], "lane_default": "shared-hot-path", "allowed_deps": []},
            {"id": "ui", "code": "UI", "ownership": ["src/ui/**"], "gates": ["true"],
             "lane_default": "single-module", "allowed_deps": ["shell"]},
            {"id": "engine", "code": "ENGINE", "ownership": ["src/engine/**"], "gates": ["true"],
             "lane_default": "single-module", "allowed_deps": ["shell"],
             "calibration": {"complexity_shift": 1}},
        ]}, indent=1))
    # project-local template exercising per_platform fan-out + $ref composition
    (root / "templates" / "test-widget.json").write_text(json.dumps({
        "applies_to": "test-widget", "version": 1, "steps": [
            {"slug": "render", "title": "Render {name}", "domain": "frontend",
             "complexity": "C2", "per_platform": True, "est_minutes": 20,
             "description": "Render {name} on {platform} at {path}.",
             "acceptance_criteria": ["renders on {platform}"], "gates": ["{module_gates}"]},
            {"$ref": "telemetry", "depends_on": ["#render-web"]}]}))
    inv = root / "inventories"
    (inv / "all.module.json").write_text(json.dumps({"type": "module", "items": [
        {"slug": "shell-mod", "name": "shell", "module": "shell", "vision": ["V-01"]},
        {"slug": "engine-mod", "name": "engine", "module": "engine", "vision": ["V-01"]}]}))
    (inv / "ui.ui-component.json").write_text(json.dumps({"type": "ui-component", "items": [
        {"slug": "hud", "name": "HUD", "module": "ui", "milestone": "M1",
         "path": "src/ui/hud.js", "vision": ["V-02"], "gaps": ["G-01"],
         "evidence": "audit", "depends_on": ["UV-SHELL-foundation-i18n"],
         "skip_steps": ["motion"], "overrides": {"impl": {"complexity": "C4"}}}]}))
    (inv / "ui.test-widget.json").write_text(json.dumps({"type": "test-widget", "items": [
        {"slug": "speedo", "name": "Speedometer", "module": "ui", "milestone": "M1",
         "path": "src/ui/speedo.js", "vision": ["V-02"]}]}))
    (inv / "ui.media-asset.json").write_text(json.dumps({"type": "media-asset", "items": [
        {"slug": "chime", "name": "Success chime", "module": "ui", "milestone": "M2",
         "path": "src/ui/sfx/chime.ogg", "vision": ["V-03"],
         "vars": {"tool": "elevenlabs", "prompt": "soft marimba chime 400ms",
                  "format": "OGG", "budget": "<=50KB", "style_ref": ""}}]}))
    # bespoke foundation task (dep target for the ui inventory item)
    (root / "tasks").mkdir()
    foundation = {"id": "UV-SHELL-foundation-i18n", "title": "Build the i18n foundation layer",
                  "description": "Create the i18n layer in src/shell/i18n.js with namespaced keys.",
                  "module": "shell", "domain": "i18n", "lane": "shared-hot-path",
                  "milestone": "M0", "complexity": "C3", "model_tier": "sonnet",
                  "status": "todo", "depends_on": [], "vision": ["V-01"], "gaps": ["G-01"],
                  "acceptance_criteria": ["i18n layer exists"], "gates": ["true"],
                  "files_touched": ["src/shell/i18n.js"], "paid": [], "prompt": None,
                  "est_minutes": 60, "template": None, "inventory_ref": None,
                  "claimed_by": None, "claimed_at": None, "evidence": None,
                  "obsolete_reason": None}
    (root / "tasks" / "shell.jsonl").write_text(json.dumps(foundation) + "\n")
    (root / "meta" / "vision.json").write_text(json.dumps({
        "pillars": [{"id": "V-01", "title": "Solid foundation", "status": "approved"},
                    {"id": "V-02", "title": "Living HUD", "status": "approved"},
                    {"id": "V-03", "title": "Sound with soul", "status": "approved"},
                    {"id": "V-09", "title": "NFT marketplace", "status": "vetoed"}],
        "non_goals": [{"id": "NG-01", "title": "No ads"}]}))
    (root / "meta" / "waivers.json").write_text(json.dumps(
        [{"module": m, "category": c, "reason": "fixture"}
         for m in ("shell", "ui", "engine")
         for c in ("test", "telemetry", "a11y", "i18n", "perf", "docs", "security")]))
    return repo, root


def main():
    base = Path(tempfile.mkdtemp(prefix="uvp-regression-"))
    try:
        repo, root = build_fixture(base)

        print("== expand: dry-run projection ==")
        rc, out = run(root, "expand", "--dry-run")
        check("dry-run reports NEW", "would be NEW" in out, out[:200])
        check("dry-run writes nothing", not (root / "tasks" / "ui.jsonl").exists())

        print("== expand + idempotency ==")
        rc, out = run(root, "expand")
        check("expand reports new", " new," in out, out[:200])
        rc, out2 = run(root, "expand")
        check("idempotent", "0 new" in out2, out2[:200])

        ui = read_tasks(root, "ui")
        engine = read_tasks(root, "engine")
        print("== expansion semantics ==")
        check("override honored", ui["UV-UI-hud-impl"]["complexity"] == "C4")
        check("skip_steps honored", "UV-UI-hud-motion" not in ui)
        check("item depends_on -> entry steps",
              "UV-SHELL-foundation-i18n" in ui["UV-UI-hud-impl"]["depends_on"])
        check("sibling deps unpolluted",
              "UV-SHELL-foundation-i18n" not in ui["UV-UI-hud-unit"]["depends_on"])
        check("platform fan-out ids", "UV-UI-speedo-render-web" in ui
              and "UV-UI-speedo-render-desktop" in ui)
        check("platform field", ui["UV-UI-speedo-render-web"]["platform"] == "web")
        check("$ref composed telemetry", "UV-UI-speedo-telemetry" in ui
              and ui["UV-UI-speedo-telemetry"]["domain"] == "telemetry")
        check("calibration shift C1->C2",
              engine["UV-ENGINE-engine-mod-charter"]["complexity"] == "C2")
        check("module-baseline default M0",
              engine["UV-ENGINE-engine-mod-charter"]["milestone"] == "M0")
        check("paid_from_var", ui["UV-UI-chime-gen"]["paid"] == ["elevenlabs"])
        check("spec_hash stamped", len(ui["UV-UI-hud-impl"].get("spec_hash", "")) == 16)
        check("schema_version stamped", ui["UV-UI-hud-impl"].get("schema_version") == 2)

        print("== validate: clean strict PASS ==")
        rc, out = run(root, "validate", "--strict")
        check("strict pass", "RESULT: PASS" in out, out[-300:])

        print("== validate: error detection ==")
        shell_path = root / "tasks" / "shell.jsonl"
        good = shell_path.read_text()
        bad = dict(json.loads(good.splitlines()[0]))
        bad.update({"id": "UV-SHELL-badspec-x", "title": "Forbidden dep + hot path",
                    "depends_on": ["UV-UI-hud-impl", "UV-GHOST-nope-x"],
                    "lane": "single-module", "files_touched": ["package.json"],
                    "vision": ["V-09"]})
        shell_path.write_text(good + json.dumps(bad) + "\n")
        rc, out = run(root, "validate", expect=1)
        check("forbidden direction", "forbidden dependency direction `shell` -> `ui`" in out)
        check("dangling dep", "does not exist" in out)
        check("hot-path lane", "touches a declared hot path" in out)
        check("vetoed pillar", "VETOED pillar `V-09`" in out)
        shell_path.write_text(good)

        print("== validate: media/utility + tamper + visual-no-media ==")
        mj = json.loads((root / "modules.json").read_text())
        mj["product"]["media_class"] = "utility"
        (root / "modules.json").write_text(json.dumps(mj))
        rc, out = run(root, "validate", expect=1)
        check("utility rejects media", "utility-class product" in out)
        mj["product"]["media_class"] = "visual"
        (root / "modules.json").write_text(json.dumps(mj))
        uipath = root / "tasks" / "ui.jsonl"
        tampered = uipath.read_text().replace("Implement HUD component",
                                              "Implement HUD component NOW")
        uipath.write_text(tampered)
        rc, out = run(root, "validate", expect=None)
        check("tamper detected", "spec fields changed outside expansion" in out, out[-300:])
        rc, out = run(root, "migrate", "--rehash")
        rc, out = run(root, "validate", "--strict")
        check("rehash accepts edit", "RESULT: PASS" in out, out[-200:])

        print("== topo / next / dispatch ==")
        rc, out = run(root, "topo")
        check("topo waves", "wave(s)" in out and "critical path" in out, out)
        rc, out = run(root, "next", "--module", "ui", "--tier", "sonnet", "--critical", "--limit", "3")
        check("next returns jsonl", out.strip().startswith("{"), out[:120])
        rc, out = run(root, "dispatch", "--ceiling", "2", "--batch", "5")
        check("dispatch manifest", (root / "meta" / "wave.json").is_file())
        wave = json.loads((root / "meta" / "wave.json").read_text())
        check("hot-path serialized", "UV-SHELL-foundation-i18n" in wave["controller_serial_queue"])
        check("ceiling respected", len(wave["assignments"]) <= 2)

        print("== lifecycle: claim/complete/verify + evidence-cmd ==")
        rc, out = run(root, "claim", "UV-SHELL-foundation-i18n", "--agent", "tester")
        rc, out = run(root, "complete", "UV-SHELL-foundation-i18n",
                      "--evidence-cmd", "false", expect=1)
        check("failing gate blocks done", "gates must pass" in out, out[-200:])
        rc, out = run(root, "complete", "UV-SHELL-foundation-i18n",
                      "--evidence-cmd", "echo gates-green", "--evidence", "manual note")
        shell = read_tasks(root, "shell")
        ev = shell["UV-SHELL-foundation-i18n"]["evidence"]
        check("structured evidence", isinstance(ev, dict) and ev["exit"] == 0
              and ev.get("text") == "manual note", str(ev)[:150])
        rc, out = run(root, "verify", "UV-SHELL-foundation-i18n", "--agent", "controller")
        shell = read_tasks(root, "shell")
        check("verified_by recorded", shell["UV-SHELL-foundation-i18n"]["verified_by"] == "controller")
        journal = (root / "meta" / "journal.jsonl").read_text()
        check("journal trail", all(a in journal for a in ('"claim"', '"complete"', '"verify"')))

        print("== audit-claims / obsolete cascade / reports ==")
        rc, out = run(root, "audit-claims", "--sample", "3")
        check("audit passes", "0 failure(s)" in out, out)
        rc, out = run(root, "obsolete", "UV-UI-chime-gen", "--reason", "asset licensed instead")
        rc, out = run(root, "obsolete", "UV-UI-chime-optimize", "--reason", "cascade test")
        check("cascade warned", "depend on" in out or "0 open" not in out, out[:300])
        rc, out = run(root, "report")
        check("report written", (root / "meta" / "report.md").is_file())
        rc, out = run(root, "featmap")
        check("featmap written", (root / "meta" / "featmap-proposals.md").is_file())
        rc, out = run(root, "gen3-draft")
        draft = json.loads((root / "meta" / "sma.gen3.draft.json").read_text())
        check("gen3 draft sane", draft["costPolicy"]["paidServicesEnabledByDefault"] is False
              and any(m["id"] == "shell" for m in draft["modules"]))

        print("== pillar coverage (user-added vision must reach tasklists) ==")
        vpath = root / "meta" / "vision.json"
        vreg = json.loads(vpath.read_text())
        vreg["pillars"].append({"id": "V-05", "title": "Replay ghosts",
                                "status": "approved", "origin": "user"})
        vpath.write_text(json.dumps(vreg))
        rc, out = run(root, "validate", expect=None)
        check("zero-task pillar flagged", "approved pillar V-05 has ZERO tasks" in out, out[-400:])
        (root / "meta" / "pipeline-state.json").write_text(json.dumps({"mode": "pilot"}))
        rc, out = run(root, "validate", "--strict")
        check("pilot downgrades to info", "RESULT: PASS" in out
              and "(pilot: deferred scope)" in out, out[-400:])
        (root / "meta" / "pipeline-state.json").unlink()
        vreg["pillars"] = [p for p in vreg["pillars"] if p["id"] != "V-05"]
        vpath.write_text(json.dumps(vreg))

        print("== co-edit lint: siblings quiet, cross-item loud ==")
        rc, out = run(root, "validate", expect=None)
        check("template siblings not flagged", "unordered co-edit" not in out, out[-300:])
        uipath = root / "tasks" / "ui.jsonl"
        saved_ui = uipath.read_text()
        intruder = {"id": "UV-UI-bespoke-hudpolish", "title": "Polish HUD glow effect layer",
                    "description": "Add glow layering to src/ui/hud.js per design language.",
                    "module": "ui", "domain": "frontend", "lane": "single-module",
                    "milestone": "M2", "complexity": "C2", "model_tier": "sonnet",
                    "status": "todo", "depends_on": [], "vision": ["V-02"], "gaps": [],
                    "acceptance_criteria": ["glow per design spec"], "gates": ["true"],
                    "files_touched": ["src/ui/hud.js"], "paid": [], "prompt": None,
                    "est_minutes": 30, "template": None, "inventory_ref": None,
                    "claimed_by": None, "claimed_at": None, "evidence": None,
                    "obsolete_reason": None}
        uipath.write_text(saved_ui + json.dumps(intruder) + "\n")
        rc, out = run(root, "validate", expect=None)
        check("cross-item co-edit flagged", "unordered co-edit risk on `src/ui/hud.js`" in out
              and "UV-UI-bespoke-hudpolish" in out, out[-400:])
        uipath.write_text(saved_ui)

        print("== gen3-draft house format ==")
        rc, out = run(root, "gen3-draft")
        draft2 = json.loads((root / "meta" / "sma.gen3.draft.json").read_text())
        check("house schema", draft2.get("schemaVersion") == 1
              and isinstance(draft2.get("modules"), list)
              and any(m["id"] == "shell" for m in draft2["modules"])
              and draft2["modules"][0].get("paths") is not None
              and isinstance(draft2.get("sharedHotPaths"), list)
              and draft2["costPolicy"]["paidServicesEnabledByDefault"] is False)

        print("== drift ==")
        (root / "meta" / "vision-sources.json").write_text(json.dumps(
            {"V-01": {"sources": ["README.md"]}}))
        rc, out = run(root, "drift", "--update")
        rc, out = run(root, "drift")
        check("no drift when unchanged", "unchanged" in out, out)
        (repo / "README.md").write_text("# FixtureGame v2 — the vision grew.\n")
        rc, out = run(root, "drift", expect=1)
        check("drift detected", "CHANGED" in out, out)

        print("== render + final strict ==")
        rc, out = run(root, "render")
        check("INDEX written", (root / "INDEX.md").is_file())
        rc, out = run(root, "validate", "--strict")
        check("final strict PASS", "RESULT: PASS" in out, out[-300:])

    finally:
        shutil.rmtree(base, ignore_errors=True)

    print(f"\n{'=' * 50}\n{PASSED} passed, {len(FAILED)} failed")
    for f in FAILED:
        print(f"  FAIL {f}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
