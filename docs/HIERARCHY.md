<!-- docs-i18n: key=docs.hierarchy; source=en; media=media/{locale}/hierarchy/ -->
# SMA Hierarchy

This reference explains how Sweetspot projects organize products, builds, bricks, components, and files. Architects and registry maintainers need it when choosing the correct boundary for new work. Read it before creating a manifest or moving an artifact between hierarchy levels. Remember that each level owns a distinct contract and should not masquerade as a smaller reusable unit.

SMA needs a clean hierarchy so the registry does not become a pile of random folders or half-defined artifacts.

## Structure Hierarchy

```text
Workspace
  Project
    Build
      Brick Group
        Brick
          Module
            Submodule
              Component / Service / Adapter / Hook / Utility
                File
```

## Delivery Hierarchy

```text
Registry
  Build / Brick
    Release
Target Project
  Import
    Placement
```

## Definitions

| Level | Meaning | Registered? |
|-------|---------|-------------|
| Workspace | Collection of projects | no |
| Project | A private repo, app suite, product, or monorepo | yes, in project index |
| Build | A reusable capability composed from multiple bricks | yes, when authored or detected |
| Brick Group | A related suite of bricks | optional |
| Brick | Copyable reusable package with manifest and gates | yes |
| Module | Cohesive unit inside a brick | only if separately reusable |
| Submodule | Smaller internal unit inside a module | rarely |
| Component | UI/building block inside a module | not by default |
| Release | Immutable versioned snapshot of a build or brick | yes |
| Import | Installed instance of a released build or brick in a target project | local state |
| Placement | Exact source-to-target mapping for an import | local state |
| File | Implementation detail | no |

## Important Rule

The hierarchy has two different jobs:

- `Build` is the capability boundary.
- `Brick` is the copy boundary.
- `Release` is the publish and update boundary.
- `Import` is the installed instance.
- `Placement` is the exact target mapping.

A build contains bricks. A brick contains modules. Modules can contain components.

But a component is not automatically a brick.

A component becomes a brick only when it has:

- a `module.sweetspot.json`
- a public API
- clone steps
- tests or verification
- security/data classification
- provenance

This prevents registry bloat.

## Practical Reading

Think of the model like this:

```text
Project = private composition of builds and proprietary logic.
Build = capability made from several bricks.
Brick = thing you can copy, score, secure, teach, and track.
Release = versioned snapshot you can publish or update to.
Import = installed instance inside a target project.
Placement = exact mapping from source artifact parts to target paths and symbols.
Module = cohesive implementation area inside a brick.
Component = UI/runtime part inside a module.
File = implementation detail.
```

So yes: builds include bricks. Bricks include modules. Modules can include components, services, hooks, adapters, utilities, and files. A module can be promoted into its own brick only when it becomes independently reusable and gets its own manifest.

## Scanner Roles

The scanner discovers brick-level structure and also emits capability-level
build candidates under `scanner_report.build_report`. Detected candidates are
discovery evidence, not installable builds; install and promotion still require
an authored build manifest.

For structural discovery, the scanner assigns unmanifested candidates a hierarchy role:

| Role | Meaning |
|------|---------|
| `brick_group_candidate` | A folder that likely groups several bricks, such as `apps/web` |
| `brick_candidate` | A likely copyable unit, such as a package, feature, worker, skill, or function |
| `module_candidate` | A lower-level module inside an app or brick; useful inventory, not automatically canonical |

Candidate groups keep noisy families together. For example, hundreds of Supabase functions should show as function groups first, then individual candidates underneath.

Build detection groups recurring brick constellations into capability-level
candidates rather than flattening everything into more bricks.

## Examples

### Build

```text
builds/ai-image-generation.build.sweetspot.json
  brick refs:
    image provider brick
    queue brick
    storage brick
    moderation brick
    admin ui brick
```

This is a build: one capability composed from several bricks.

### App Brick

```text
apps/web
  module.sweetspot.json
  src/features/transcript-presets
  src/components
```

`apps/web` can be a brick group or app brick.

### Feature Brick

```text
apps/web/src/features/transcript-presets
  module.sweetspot.json
  hooks/
  services/
  components/
  utils/
```

`transcript-presets` is a brick. Its hooks, services, and components are modules/components inside the brick.

### Component Brick

```text
apps/web/src/components/audio-waveform
  module.sweetspot.json
  AudioWaveform.tsx
  useWaveform.ts
```

This component is a brick only because it declares a manifest and can be copied independently.

### Release And Import

```text
Registry
  build.ai-image-generation
    release 1.3.0

Target project
  .smarch/imports.json
  .smarch/placements.json
```

The release is the versioned source artifact. The import is the installed instance. Placements record exactly where it landed in the target project.

## Scanner Policy

The scanner should detect likely bricks at these levels:

- apps
- packages
- frontend features/modules
- Supabase functions
- Netlify functions
- workers
- agent skills
- shared modules
- test suites

The scanner should not register every component automatically. Components are too noisy unless they opt in with a manifest.

The scanner should also stay honest about hierarchy:

- not every folder is a brick
- not every cluster is a build
- not every release is safe to import
- not every import is safe to update without placements
