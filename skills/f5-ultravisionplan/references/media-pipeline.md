# Generative Media Pipeline

Rules for when and how the plan uses generative media tooling: **Higgsfield** (MCP/CLI) for video, image, and 3D; **Fal.ai** for sfx/music generation; **ElevenLabs** for voice, sfx, and ui-sfx. These are paid services — the SMA cost policy applies: the plan *specifies* every asset with a ready-to-run prompt, but execution is opt-in and requires explicit user approval.

## Step 1 — Classify the product (detection rule, not a name list)

Ask: **is audiovisual experience part of the product's core value delivery?** Detect from the repo itself: game loops/engines/canvas-WebGL scenes, cutscene or soundtrack references, "feel"/"immersion" language in the vision sources → visual. CRUD/dashboard/tooling surfaces where visuals should be excellent *design*, not generated *content* → utility. (Portfolio calibration examples: Acme Factory → visual; MODVIBE, Acme Suite → utility.)

| Class | Media plan |
| --- | --- |
| **visual** | Full generative-asset plan + media-asset inventory/tasks |
| **utility** | `05-MEDIA-PLAN.md` holds the verdict + one-paragraph rationale. No generative media tasks — UI polish belongs to `design`/`frontend` domains. |

Record the verdict mechanically as `modules.json → product.media_class` with a one-sentence rationale; `uvp validate` then **rejects** media/paid tasks in utility-class products (SMA-C7). Borderline cases (e.g. a utility app with one animated onboarding): classify utility and waive the specific module in `meta/waivers.json` (`{"module": "onboarding", "category": "media", "reason": "..."}`) — a written exception, never a full pipeline.

## Step 2 — Route asset classes to tools

| Asset class | Tool | Notes |
| --- | --- | --- |
| Images (characters, environments, UI illustrations, marketing) | Higgsfield `generate_image` | Use `models_explore(action:'recommend')` when unsure of model; the user's `banana-pro-director-2.0` skill writes locked-identity photoreal prompts |
| Video (cutscenes, trailers, ambient loops, hero videos) | Higgsfield `generate_video` | `cinema-worldbuilder-pro-2.0` skill for Seedance-grade prompts; `product-motion-director` for product/ad videos |
| 3D assets | Higgsfield `generate_3d` (image → GLB) | Plan the source image task as a dep |
| Upscale / outpaint / reframe / bg-removal | Higgsfield dedicated tools | Prefer over regeneration |
| Music, ambient beds, stingers | Fal.ai (or Higgsfield `generate_audio`) | Specify duration, BPM/mood, loopability |
| SFX and **ui-sfx** (clicks, whooshes, success/error cues, ambient UI) | ElevenLabs (primary), Fal.ai (alternative) | ui-sfx get a coherent family spec: shared timbre, loudness-normalized (state LUFS target) |
| Voice / narration / character lines | ElevenLabs | Voice design task precedes line-generation tasks |

## Step 3 — Write media tasks

Every generative asset is one task in a `[media]` shard, following the standard task grammar plus:

```markdown
- [ ] UV-GAME-00311 (C2) [media] Generate boss-arena ambient loop, phase 2
  - lane: single-module | milestone: M3
  - deps: UV-GAME-00308
  - vision: V-04 "every room has a soul"
  - paid: fal
  - prompt: "Dark cavern ambience, sub-bass rumble, distant metallic groans, slow 4-bar swell, seamless loop, 96s, -23 LUFS integrated"
  - do: Generate via Fal.ai audio; export 48kHz stereo OGG + fallback MP3; place in assets/audio/ambience/boss-arena-p2.ogg; register in audio manifest.
  - done-when: loop point is seamless (verified by crossfade check), loudness within ±1 LU of target, manifest entry present, plays in the arena scene.
  - gates: asset-lint script, audio manifest validation, game boots with asset
```

Rules:
- **The creative judgment is spent at plan time.** Prompts are written ready-to-run, with style anchors (reference image IDs, seeds, voice IDs, LUFS targets) so a C2 executor produces consistent results.
- **Consistency anchors are their own tasks.** Character face-locks, style reference boards, voice designs, and the ui-sfx family spec are generated first and become deps of everything that must match them.
- **Every asset lands in the repo pipeline**: file path, format, compression, manifest/registry entry, and the surface that consumes it are all part of `do`/`done-when` — an asset that isn't wired in is not done.
- **Performance discipline applies to media**: specify target sizes/codecs per the performance plan (e.g. ui-sfx ≤50KB OGG; hero video with poster + lazy-load; texture budgets per quality tier).
- **Batch approval**: group media tasks per milestone in `05-MEDIA-PLAN.md` with a rough credit/cost note per batch, so the user approves spend in one decision per batch, not per asset.
