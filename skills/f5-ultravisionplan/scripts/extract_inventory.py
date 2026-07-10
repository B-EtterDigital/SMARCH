#!/usr/bin/env python3
"""extract_inventory.py — mechanical inventory extraction for F5-UltraVisionPlan (SUP).

Scans a repository with pragmatic, regex/line-based heuristics (no full parsing)
and proposes inventory items for a planning agent to curate. It writes ONLY into
``<root>/inventories/proposed/`` and never touches curated inventories.

Usage:
    python3 extract_inventory.py <repo-path> [--root DIR] [--types t1,t2] [--out DIR] [--list]

Arguments:
    repo-path        Repository to scan.
    --root DIR       UltraVision root (default: <repo-path>/.UltraVision). If the
                     root or its modules.json is absent, module auto-assignment
                     is skipped and "module" stays null.
    --types LIST     Comma-separated subset of: ui-component, screen,
                     api-endpoint, data-entity, media-asset (default: all).
    --out DIR        Output directory (default: <root>/inventories/proposed/,
                     created if missing). Writing directly into the curated
                     <root>/inventories/ directory is refused.
    --list           Print a summary table only; write nothing.

Output: one ``<out>/<type>.proposed.json`` per extracted type:
    {"type": "...", "proposed": true, "generated_by": "extract_inventory.py",
     "items": [{"slug", "name", "module", "milestone", "path", "vision",
                "gaps", "vars", "evidence", "confidence"}]}

Exit codes: 0 on success (even when 0 items are found), 2 on usage errors.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from functools import lru_cache
from typing import Dict, Iterable, List, Optional, Pattern, Sequence, Set, Tuple

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

GENERATOR = "extract_inventory.py"
ALL_TYPES: Tuple[str, ...] = (
    "ui-component",
    "screen",
    "api-endpoint",
    "data-entity",
    "media-asset",
)

MAX_FILES = 20_000
MAX_FILE_BYTES = 1_048_576  # 1 MB

SKIP_DIRS: Set[str] = {
    "node_modules", ".git", "dist", "build", "out", "vendor", "coverage",
    ".next", "target", "__pycache__", ".UltraVision", ".venv", "venv",
    ".cache", ".turbo", ".output", ".idea", ".vscode",
}

# Framework detection hints: file extensions + import/module names that mark a
# file as belonging to a framework. Detection is by extension and imports only —
# never by full parsing.
FRAMEWORK_HINTS: Dict[str, Dict[str, Tuple[str, ...]]] = {
    "react":    {"extensions": (".jsx", ".tsx"), "imports": ("react",)},
    "vue":      {"extensions": (".vue",), "imports": ("vue",)},
    "svelte":   {"extensions": (".svelte",), "imports": ("svelte",)},
    "nextjs":   {"extensions": (".ts", ".tsx", ".js", ".jsx"), "imports": ("next",)},
    "express":  {"extensions": (".js", ".ts", ".mjs", ".cjs"), "imports": ("express",)},
    "fastify":  {"extensions": (".js", ".ts", ".mjs", ".cjs"), "imports": ("fastify",)},
    "fastapi":  {"extensions": (".py",), "imports": ("fastapi",)},
    "flask":    {"extensions": (".py",), "imports": ("flask",)},
    "electron": {"extensions": (".js", ".ts", ".mjs", ".cjs"), "imports": ("electron",)},
    "prisma":   {"extensions": (".prisma",), "imports": ()},
    "typeorm":  {"extensions": (".ts", ".js"), "imports": ("typeorm",)},
    "mongoose": {"extensions": (".js", ".ts", ".mjs", ".cjs"), "imports": ("mongoose",)},
}

CODE_EXTS: Set[str] = {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"}
JS_EXTS: Set[str] = {".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx"}
SCREEN_DIRS: Set[str] = {"pages", "screens", "views", "routes"}
INDEX_STEMS: Set[str] = {"index", "page", "+page"}

ASSET_DIR_NAMES: Set[str] = {"assets", "public", "static"}
MEDIA_CLASSES: Dict[str, Set[str]] = {
    "image": {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".avif",
              ".bmp", ".tiff"},
    "audio": {".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"},
    "video": {".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v"},
    "3d":    {".glb", ".gltf", ".obj", ".fbx", ".stl", ".usdz", ".blend"},
}
EXT_TO_CLASS: Dict[str, str] = {
    ext: cls for cls, exts in MEDIA_CLASSES.items() for ext in exts
}

HTTP_METHODS = ("get", "post", "put", "patch", "delete")

# --------------------------------------------------------------------------- #
# Regexes (pragmatic, line/content based)
# --------------------------------------------------------------------------- #

RE_EXPORT_FUNC = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Z]\w*)")
RE_EXPORT_CONST = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:const|let|var)\s+([A-Z]\w*)")
RE_JSX_LIKE = re.compile(r"<[A-Za-z][\w.]*(?:\s|/?>)")

RE_JS_ROUTE = re.compile(
    r"\b(app|router|server|fastify)\s*\.\s*(get|post|put|patch|delete)"
    r"\s*\(\s*['\"`]([^'\"`\n]+)['\"`]")
RE_NEXT_METHOD = re.compile(
    r"export\s+(?:async\s+)?(?:function\s+|const\s+)"
    r"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b")
RE_FASTAPI = re.compile(
    r"^\s*@(\w+)\.(get|post|put|patch|delete)\s*\(\s*['\"]([^'\"]+)['\"]", re.M)
RE_FLASK = re.compile(
    r"^\s*@(\w+)\.route\s*\(\s*['\"]([^'\"]+)['\"]([^)]*)\)", re.M)
RE_FLASK_METHODS = re.compile(r"['\"](GET|POST|PUT|PATCH|DELETE)['\"]", re.I)
RE_IPC_HANDLE = re.compile(r"ipcMain\s*\.\s*handle\s*\(\s*['\"`]([^'\"`\n]+)['\"`]")

RE_CREATE_TABLE = re.compile(
    r"create\s+table\s+(?:if\s+not\s+exists\s+)?"
    r"(?:[\"'`\[]?(\w+)[\"'`\]]?\s*\.\s*)?[\"'`\[]?(\w+)[\"'`\]]?", re.I)
RE_PRISMA_MODEL = re.compile(r"^\s*model\s+(\w+)\s*\{", re.M)
RE_TYPEORM_ENTITY = re.compile(
    r"@Entity\s*(?:\([^)]*\))?\s*(?:@\w+\s*(?:\([^)]*\))?\s*)*"
    r"(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)")
RE_MONGOOSE_MODEL = re.compile(r"\bmodel\s*(?:<[^>]*>)?\s*\(\s*['\"](\w+)['\"]")

RE_IMPORT_JS = re.compile(r"""(?:\bfrom|\brequire\s*\()\s*['"]([^'"]+)['"]""")
RE_IMPORT_PY = re.compile(r"^\s*(?:from\s+([\w.]+)|import\s+([\w.]+))", re.M)

# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def kebab(text: str) -> str:
    """Convert arbitrary text (incl. CamelCase, paths) to a kebab-case slug."""
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", text)
    text = re.sub(r"[^A-Za-z0-9]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-").lower()
    return text or "item"


def humanize(text: str) -> str:
    """Turn a stem/identifier into a human-readable Title Case name."""
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    text = re.sub(r"[-_/.]+", " ", text).strip()
    words = [w if (w.isupper() and len(w) > 1) else w.capitalize()
             for w in text.split()]
    return " ".join(words) or text


def line_of(content: str, pos: int) -> int:
    """1-based line number of a character offset."""
    return content.count("\n", 0, pos) + 1


def ext_of(rel: str) -> str:
    return os.path.splitext(rel)[1].lower()


def is_test_path(rel: str) -> bool:
    low = rel.lower()
    return ("__tests__" in low or ".test." in low or ".spec." in low
            or low.startswith("tests/") or "/tests/" in low
            or low.startswith("test/") or "/test/" in low)


@lru_cache(maxsize=512)
def read_text(path: str) -> str:
    """Read a file defensively: size-capped, undecodable bytes ignored."""
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return ""
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            return fh.read()
    except OSError:
        return ""


def imported_modules(content: str, ext: str) -> Set[str]:
    """Best-effort set of imported top-level module/package names."""
    mods: Set[str] = set()
    if ext == ".py":
        for m in RE_IMPORT_PY.finditer(content):
            name = m.group(1) or m.group(2) or ""
            if name:
                mods.add(name.split(".")[0].lower())
    else:
        for m in RE_IMPORT_JS.finditer(content):
            spec = m.group(1)
            if spec.startswith("@"):
                mods.add("/".join(spec.split("/")[:2]).lower())
            else:
                mods.add(spec.split("/")[0].lower())
    return mods


def has_framework(mods: Set[str], framework: str) -> bool:
    return any(imp in mods for imp in FRAMEWORK_HINTS[framework]["imports"])


def make_item(slug: str, name: str, path: str, evidence: str,
              confidence: str, vars_: Optional[Dict[str, object]] = None) -> Dict[str, object]:
    return {
        "slug": kebab(slug),
        "name": name,
        "module": None,
        "milestone": "M1",
        "path": path,
        "vision": [],
        "gaps": [],
        "vars": vars_ or {},
        "evidence": evidence,
        "confidence": confidence,
    }


# --------------------------------------------------------------------------- #
# Module auto-assignment (modules.json ownership globs)
# --------------------------------------------------------------------------- #


def glob_to_regex(pattern: str) -> Pattern[str]:
    """Translate an ownership glob (supporting **, *, ?) to a compiled regex."""
    pat = pattern.strip().replace(os.sep, "/")
    while pat.startswith("./"):
        pat = pat[2:]
    pat = pat.lstrip("/")
    if pat.endswith("/"):
        pat += "**"
    out: List[str] = []
    i = 0
    while i < len(pat):
        ch = pat[i]
        if ch == "*":
            if pat.startswith("**/", i):
                out.append("(?:[^/]+/)*")
                i += 3
            elif pat.startswith("**", i):
                out.append(".*")
                i += 2
            else:
                out.append("[^/]*")
                i += 1
        elif ch == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(ch))
            i += 1
    return re.compile("^" + "".join(out) + "$")


class ModuleMatcher:
    """Assigns module ids by matching repo-relative paths against ownership globs."""

    def __init__(self, modules: Sequence[Tuple[str, List[Pattern[str]]]]) -> None:
        self._modules = list(modules)

    @classmethod
    def load(cls, modules_json_path: str) -> Optional["ModuleMatcher"]:
        if not os.path.isfile(modules_json_path):
            return None
        try:
            with open(modules_json_path, "r", encoding="utf-8", errors="ignore") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[extract_inventory] warning: cannot parse {modules_json_path}: {exc}",
                  file=sys.stderr)
            return None
        raw = data.get("modules", []) if isinstance(data, dict) else data
        modules: List[Tuple[str, List[Pattern[str]]]] = []
        if isinstance(raw, list):
            for mod in raw:
                if not isinstance(mod, dict):
                    continue
                mid = mod.get("id") or mod.get("name") or mod.get("slug")
                globs = mod.get("ownership") or []
                if not mid or not isinstance(globs, list):
                    continue
                regexes = [glob_to_regex(g) for g in globs if isinstance(g, str) and g]
                if regexes:
                    modules.append((str(mid), regexes))
        return cls(modules) if modules else None

    def assign(self, path: str) -> Optional[str]:
        for mid, regexes in self._modules:  # first match wins
            if any(rx.match(path) for rx in regexes):
                return mid
        return None


# --------------------------------------------------------------------------- #
# Repository walk
# --------------------------------------------------------------------------- #


def walk_repo(repo: str) -> Tuple[List[Tuple[str, str]], bool]:
    """Return sorted (repo-relative-posix-path, absolute-path) pairs.

    Prunes SKIP_DIRS and dot-directories, caps at MAX_FILES, and skips
    files >1MB except media assets (which are counted, never read).
    """
    files: List[Tuple[str, str]] = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = sorted(
            d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            if len(files) >= MAX_FILES:
                truncated = True
                break
            ab = os.path.join(dirpath, fn)
            rel = os.path.relpath(ab, repo).replace(os.sep, "/")
            if ext_of(rel) not in EXT_TO_CLASS:
                try:
                    if os.path.getsize(ab) > MAX_FILE_BYTES:
                        continue
                except OSError:
                    continue
            files.append((rel, ab))
        if truncated:
            break
    return files, truncated


# --------------------------------------------------------------------------- #
# Extractors
# --------------------------------------------------------------------------- #


def extract_screens(files: List[Tuple[str, str]]) -> Tuple[List[Dict[str, object]], Set[str]]:
    """Screens: files under pages/screens/views/routes dirs + Next.js app-router pages."""
    items: List[Dict[str, object]] = []
    screen_paths: Set[str] = set()
    for rel, _ab in files:
        if is_test_path(rel):
            continue
        parts = rel.split("/")
        dirs, fname = parts[:-1], parts[-1]
        stem, ext = os.path.splitext(fname)
        ext = ext.lower()
        if ext not in CODE_EXTS:
            continue

        # Next.js app router: any page.{tsx,jsx,ts,js} under an app/ segment.
        if stem == "page" and "app" in dirs and ext in JS_EXTS:
            idx = len(dirs) - 1 - dirs[::-1].index("app")
            segs = [s for s in dirs[idx + 1:]
                    if not (s.startswith("(") and s.endswith(")"))]
            if "api" in segs:
                continue  # route handlers, not screens
            route = "/" + "/".join(segs)
            name = humanize(segs[-1]) if segs else "Home"
            screen_paths.add(rel)
            items.append(make_item(
                slug=kebab(" ".join(segs) or "home"),
                name=name, path=rel, evidence=f"{rel}:1", confidence="high",
                vars_={"route": route, "framework": "nextjs-app-router"}))
            continue

        # Conventional screen directories.
        sd_idx = next((i for i, d in enumerate(dirs) if d in SCREEN_DIRS), None)
        if sd_idx is None:
            continue
        screen_dir = dirs[sd_idx]
        after = dirs[sd_idx + 1:]
        if "api" in after:
            continue  # e.g. Next.js pages/api/** -> api-endpoint territory
        if stem.startswith("_"):
            continue  # _app, _document, private files
        if screen_dir == "routes" and ext not in {".jsx", ".tsx", ".vue", ".svelte"}:
            continue  # plain .js/.ts under routes/ is usually server code
        if stem in INDEX_STEMS:
            base = after[-1] if after else "home"
        else:
            base = stem
        route_segs = after + ([] if stem in INDEX_STEMS else [stem])
        screen_paths.add(rel)
        items.append(make_item(
            slug=kebab(" ".join(route_segs) or "home"),
            name=humanize(base), path=rel, evidence=f"{rel}:1",
            confidence="high" if screen_dir != "routes" else "medium",
            vars_={"route": "/" + "/".join(route_segs), "screen_dir": screen_dir}))
    return items, screen_paths


def extract_ui_components(files: List[Tuple[str, str]],
                          screen_paths: Set[str]) -> List[Dict[str, object]]:
    """UI components: exported capitalized React components, .vue/.svelte files."""
    items: List[Dict[str, object]] = []
    arrow_hints = ("=>", "function", "memo(", "forwardRef(", "styled")
    for rel, ab in files:
        if rel in screen_paths or is_test_path(rel):
            continue
        ext = ext_of(rel)
        stem = os.path.splitext(rel.split("/")[-1])[0]
        if ext in {".vue", ".svelte"}:
            framework = "vue" if ext == ".vue" else "svelte"
            items.append(make_item(
                slug=kebab(stem), name=humanize(stem), path=rel,
                evidence=f"{rel}:1", confidence="high",
                vars_={"framework": framework}))
        elif ext in FRAMEWORK_HINTS["react"]["extensions"]:
            content = read_text(ab)
            if not content:
                continue
            jsx_like = bool(RE_JSX_LIKE.search(content))
            for lineno, line in enumerate(content.splitlines(), 1):
                m = RE_EXPORT_FUNC.match(line)
                kind = "function"
                if not m:
                    m = RE_EXPORT_CONST.match(line)
                    kind = "const"
                if not m:
                    continue
                name = m.group(1)
                if name.upper() == name:
                    continue  # SCREAMING_CASE constants, not components
                if kind == "const" and not any(h in line for h in arrow_hints):
                    continue  # likely a plain object/value export
                confidence = "high" if (kind == "function" or jsx_like) else "medium"
                if not jsx_like:
                    confidence = "medium"
                items.append(make_item(
                    slug=kebab(name), name=humanize(name), path=rel,
                    evidence=f"{rel}:{lineno}", confidence=confidence,
                    vars_={"framework": "react", "export_kind": kind}))
    return items


def _next_route_items(rel: str, dirs: List[str], content: str) -> List[Dict[str, object]]:
    idx = len(dirs) - 1 - dirs[::-1].index("app")
    segs = [s for s in dirs[idx + 1:] if not (s.startswith("(") and s.endswith(")"))]
    route = "/" + "/".join(segs)
    methods = RE_NEXT_METHOD.findall(content) or ["ANY"]
    confidence = "high" if "api" in segs else "medium"
    return [make_item(
        slug=kebab(f"{method} {route}"), name=f"{method} {route}", path=rel,
        evidence=f"{rel}:1", confidence=confidence,
        vars_={"method": method, "route": route, "framework": "nextjs-route-handler"})
        for method in methods]


def extract_api_endpoints(files: List[Tuple[str, str]]) -> List[Dict[str, object]]:
    """API endpoints: Express/Fastify, Next.js route handlers, FastAPI, Flask,
    Supabase edge functions, Electron ipcMain.handle channels."""
    items: List[Dict[str, object]] = []
    supabase_fns: Dict[str, List[str]] = {}
    supabase_dirs: Dict[str, str] = {}

    for rel, ab in files:
        if is_test_path(rel):
            continue
        parts = rel.split("/")
        dirs, fname = parts[:-1], parts[-1]
        ext = ext_of(rel)

        # Supabase edge functions: supabase/functions/<name>/**
        for i in range(len(parts) - 3):
            if parts[i] == "supabase" and parts[i + 1] == "functions":
                name = parts[i + 2]
                if not name.startswith(("_", ".")):
                    supabase_fns.setdefault(name, []).append(rel)
                    supabase_dirs[name] = "/".join(parts[:i + 3])
                break

        # Next.js app-router route handlers.
        if fname in {"route.ts", "route.js", "route.tsx", "route.jsx"} and "app" in dirs:
            items.extend(_next_route_items(rel, dirs, read_text(ab)))
            continue

        if ext in {".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx"}:
            content = read_text(ab)
            if not content:
                continue
            mods = imported_modules(content, ext)
            framework = ("express" if has_framework(mods, "express")
                         else "fastify" if has_framework(mods, "fastify") else None)
            for m in RE_JS_ROUTE.finditer(content):
                _obj, method, route = m.group(1), m.group(2), m.group(3)
                if framework is None and not route.startswith("/"):
                    continue  # without an import hint, require a route-like path
                method_u = method.upper()
                items.append(make_item(
                    slug=kebab(f"{method_u} {route}"), name=f"{method_u} {route}",
                    path=rel, evidence=f"{rel}:{line_of(content, m.start())}",
                    confidence="high" if framework else "medium",
                    vars_={"method": method_u, "route": route,
                           "framework": framework or "express-like"}))
            if "ipcMain" in content:
                for m in RE_IPC_HANDLE.finditer(content):
                    channel = m.group(1)
                    items.append(make_item(
                        slug=kebab(f"ipc {channel}"), name=f"IPC {channel}",
                        path=rel, evidence=f"{rel}:{line_of(content, m.start())}",
                        confidence="high",
                        vars_={"kind": "ipc", "channel": channel,
                               "framework": "electron"}))

        elif ext == ".py":
            content = read_text(ab)
            if not content:
                continue
            mods = imported_modules(content, ".py")
            if has_framework(mods, "fastapi"):
                for m in RE_FASTAPI.finditer(content):
                    method_u, route = m.group(2).upper(), m.group(3)
                    items.append(make_item(
                        slug=kebab(f"{method_u} {route}"), name=f"{method_u} {route}",
                        path=rel, evidence=f"{rel}:{line_of(content, m.start())}",
                        confidence="high",
                        vars_={"method": method_u, "route": route,
                               "framework": "fastapi"}))
            if has_framework(mods, "flask"):
                for m in RE_FLASK.finditer(content):
                    route, extra = m.group(2), m.group(3)
                    methods = [x.upper() for x in RE_FLASK_METHODS.findall(extra)] or ["GET"]
                    for method_u in methods:
                        items.append(make_item(
                            slug=kebab(f"{method_u} {route}"),
                            name=f"{method_u} {route}", path=rel,
                            evidence=f"{rel}:{line_of(content, m.start())}",
                            confidence="high",
                            vars_={"method": method_u, "route": route,
                                   "framework": "flask"}))

    for name in sorted(supabase_fns):
        rels = supabase_fns[name]
        evidence_rel = next(
            (r for r in rels if r.rsplit("/", 1)[-1].startswith("index.")), rels[0])
        items.append(make_item(
            slug=kebab(name), name=f"Edge Function {name}",
            path=supabase_dirs[name], evidence=f"{evidence_rel}:1",
            confidence="high",
            vars_={"kind": "supabase-edge-function", "framework": "supabase"}))
    return items


def extract_data_entities(files: List[Tuple[str, str]]) -> List[Dict[str, object]]:
    """Data entities: SQL CREATE TABLE, prisma models, TypeORM entities, Mongoose models."""
    items: List[Dict[str, object]] = []
    seen_sql_tables: Set[str] = set()
    for rel, ab in files:
        ext = ext_of(rel)
        if ext == ".sql":
            content = read_text(ab)
            in_migrations = "migrations" in rel.split("/")
            for m in RE_CREATE_TABLE.finditer(content):
                schema, table = m.group(1), m.group(2)
                key = f"{schema or ''}.{table}".lower()
                if key in seen_sql_tables:
                    continue
                seen_sql_tables.add(key)
                vars_: Dict[str, object] = {"source": "sql", "table": table}
                if schema:
                    vars_["schema"] = schema
                items.append(make_item(
                    slug=kebab(table), name=humanize(table), path=rel,
                    evidence=f"{rel}:{line_of(content, m.start())}",
                    confidence="high" if in_migrations else "medium",
                    vars_=vars_))
        elif ext == ".prisma":
            content = read_text(ab)
            for m in RE_PRISMA_MODEL.finditer(content):
                items.append(make_item(
                    slug=kebab(m.group(1)), name=m.group(1), path=rel,
                    evidence=f"{rel}:{line_of(content, m.start())}",
                    confidence="high", vars_={"source": "prisma"}))
        elif ext in {".ts", ".js", ".mjs", ".cjs"} and not is_test_path(rel):
            content = read_text(ab)
            if not content:
                continue
            mods = imported_modules(content, ext)
            if has_framework(mods, "typeorm") and "@Entity" in content:
                for m in RE_TYPEORM_ENTITY.finditer(content):
                    items.append(make_item(
                        slug=kebab(m.group(1)), name=m.group(1), path=rel,
                        evidence=f"{rel}:{line_of(content, m.start())}",
                        confidence="high", vars_={"source": "typeorm"}))
            if has_framework(mods, "mongoose"):
                for m in RE_MONGOOSE_MODEL.finditer(content):
                    items.append(make_item(
                        slug=kebab(m.group(1)), name=m.group(1), path=rel,
                        evidence=f"{rel}:{line_of(content, m.start())}",
                        confidence="high", vars_={"source": "mongoose"}))
    return items


def extract_media_assets(files: List[Tuple[str, str]]) -> List[Dict[str, object]]:
    """Media assets: grouped per asset-dir subdirectory and extension class."""
    groups: Dict[Tuple[str, str], Dict[str, object]] = {}
    for rel, _ab in files:
        parts = rel.split("/")
        dirs = parts[:-1]
        root_idx = next(
            (i for i, d in enumerate(dirs) if d.lower() in ASSET_DIR_NAMES), None)
        if root_idx is None:
            continue
        cls = EXT_TO_CLASS.get(ext_of(rel))
        if cls is None:
            continue
        subdir = dirs[root_idx + 1] if len(dirs) > root_idx + 1 else ""
        group_dir = "/".join(dirs[:root_idx + 1] + ([subdir] if subdir else []))
        group = groups.setdefault((group_dir, cls), {
            "count": 0, "extensions": set(), "first": rel})
        group["count"] += 1  # type: ignore[operator]
        group["extensions"].add(ext_of(rel))  # type: ignore[union-attr]

    items: List[Dict[str, object]] = []
    for (group_dir, cls), group in sorted(groups.items()):
        base = kebab(group_dir)
        slug = base if cls in base else f"{base}-{cls}"
        items.append(make_item(
            slug=slug,
            name=f"{cls.title()} assets in {group_dir}",
            path=group_dir,
            evidence=f"{group['first']}:1",
            confidence="high",
            vars_={"asset_class": cls,
                   "count": group["count"],
                   "extensions": sorted(group["extensions"]),  # type: ignore[arg-type]
                   "dir": group_dir}))
    return items


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #


def finalize_items(items: List[Dict[str, object]],
                   matcher: Optional[ModuleMatcher]) -> None:
    """Deduplicate slugs (suffix -2, -3, ...) and auto-assign modules in place."""
    seen: Dict[str, int] = {}
    for item in items:
        base = str(item["slug"])
        n = seen.get(base, 0) + 1
        seen[base] = n
        if n > 1:
            item["slug"] = f"{base}-{n}"
        if matcher is not None:
            item["module"] = matcher.assign(str(item["path"]))


def run_extraction(files: List[Tuple[str, str]], types: Sequence[str],
                   matcher: Optional[ModuleMatcher]) -> Dict[str, List[Dict[str, object]]]:
    screens, screen_paths = extract_screens(files)
    dispatch = {
        "ui-component": lambda: extract_ui_components(files, screen_paths),
        "screen": lambda: screens,
        "api-endpoint": lambda: extract_api_endpoints(files),
        "data-entity": lambda: extract_data_entities(files),
        "media-asset": lambda: extract_media_assets(files),
    }
    results: Dict[str, List[Dict[str, object]]] = {}
    for t in types:
        items = dispatch[t]()
        finalize_items(items, matcher)
        results[t] = items
    return results


def write_proposals(results: Dict[str, List[Dict[str, object]]],
                    out_dir: str) -> Dict[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    written: Dict[str, str] = {}
    for t, items in results.items():
        payload = {
            "type": t,
            "proposed": True,
            "generated_by": GENERATOR,
            "items": items,
        }
        path = os.path.join(out_dir, f"{t}.proposed.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2)
            fh.write("\n")
        written[t] = path
    return written


def print_summary(results: Dict[str, List[Dict[str, object]]],
                  written: Optional[Dict[str, str]], repo: str,
                  n_files: int, truncated: bool,
                  module_assignment: bool) -> None:
    total = sum(len(v) for v in results.values())
    print(f"[extract_inventory] scanned {n_files} files under {repo}"
          + (" (TRUNCATED at file cap)" if truncated else ""))
    if not module_assignment:
        print("[extract_inventory] modules.json not found — "
              "module auto-assignment skipped (module=null)")
    width = max(len(t) for t in results) if results else 12
    print(f"  {'type'.ljust(width)}  items  " +
          ("output" if written is not None else "examples"))
    for t, items in results.items():
        if written is not None:
            tail = written[t]
        else:
            tail = ", ".join(str(i["slug"]) for i in items[:3])
            if len(items) > 3:
                tail += ", ..."
        print(f"  {t.ljust(width)}  {len(items):5d}  {tail}")
    print(f"  {'total'.ljust(width)}  {total:5d}  "
          + ("" if total else "(0 items)"))
    if written is None:
        print("[extract_inventory] --list mode: nothing written.")
    else:
        print("Proposals require curation: assign module/milestone/vision/gaps, "
              "then move into inventories/.")


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="extract_inventory.py",
        description="Mechanical inventory extraction for F5-UltraVisionPlan. "
                    "Proposes inventory items into <root>/inventories/proposed/ "
                    "for a planning agent to curate.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Types: " + ", ".join(ALL_TYPES))
    parser.add_argument("repo", help="repository path to scan")
    parser.add_argument("--root", default=None,
                        help="UltraVision root (default: <repo>/.UltraVision)")
    parser.add_argument("--types", default=None,
                        help="comma-separated subset of types (default: all)")
    parser.add_argument("--out", default=None,
                        help="output dir (default: <root>/inventories/proposed/)")
    parser.add_argument("--list", action="store_true", dest="list_only",
                        help="print a summary table only; write nothing")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)

    repo = os.path.abspath(args.repo)
    if not os.path.isdir(repo):
        print(f"[extract_inventory] error: not a directory: {repo}", file=sys.stderr)
        return 2

    root = os.path.abspath(args.root) if args.root else os.path.join(repo, ".UltraVision")
    out_dir = os.path.abspath(args.out) if args.out else os.path.join(
        root, "inventories", "proposed")

    # Safety: never write into the curated inventories/ directory itself.
    curated = os.path.realpath(os.path.join(root, "inventories"))
    if os.path.realpath(out_dir) == curated:
        print("[extract_inventory] error: refusing to write into the curated "
              f"inventories directory ({curated}). Use its proposed/ subdirectory.",
              file=sys.stderr)
        return 2

    if args.types:
        types = [t.strip() for t in args.types.split(",") if t.strip()]
        unknown = [t for t in types if t not in ALL_TYPES]
        if unknown:
            print(f"[extract_inventory] error: unknown type(s): {', '.join(unknown)}. "
                  f"Valid: {', '.join(ALL_TYPES)}", file=sys.stderr)
            return 2
    else:
        types = list(ALL_TYPES)

    matcher = ModuleMatcher.load(os.path.join(root, "modules.json"))
    files, truncated = walk_repo(repo)
    results = run_extraction(files, types, matcher)

    written: Optional[Dict[str, str]] = None
    if not args.list_only:
        written = write_proposals(results, out_dir)

    print_summary(results, written, repo, len(files), truncated,
                  module_assignment=matcher is not None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
