/**
 * WHAT: Assigns scanned bricks to stable user-facing feature clusters from their metadata and paths.
 * WHY: Registry and wiki views need product-level groupings instead of exposing only low-level module records.
 * HOW: Callers pass a brick and optional manifest; keyword rules return cluster facts or attach them to the record.
 * The scanner and wiki use the same ordered rules so their labels and descriptions remain consistent.
 * Unmatched bricks fall back to a general cluster without mutating the source manifest.
 * @example node --input-type=module -e "import { featureClusterForBrick } from './tools/lib/feature-clusters.ts'; console.log(featureClusterForBrick({ name: 'video render worker' }))"
 */
const featureClusterRules = [
  {
    id: "youtube-youtail",
    name: "YouTube / YouTail",
    description: "YouTube channels, YouTail ads, sponsors, analytics, OAuth, and publishing workflows.",
    keywords: ["youtube", "youtail", "yt"]
  },
  {
    id: "workshop",
    name: "Workshop Builder",
    description: "Workshop creation, course content, workbook exports, reviews, and teaching flows.",
    keywords: ["workshop", "course", "lesson", "instructor", "learner"]
  },
  {
    id: "contentmation",
    name: "Contentmation",
    description: "Content planning, production, channels, analytics, and composite content pipelines.",
    keywords: ["contentmation", "content", "planner", "production"]
  },
  {
    id: "acme-skills",
    name: "Acme Skills",
    description: "Skill generation, benchmarks, agent skills, learning trees, and prompt composition.",
    keywords: ["acme-skills", "skill", "benchmark", "prompt", "openclaw"]
  },
  {
    id: "acme-story",
    name: "Acme Story / Storiez",
    description: "Stories, narrative generation, story studios, scenes, and publishing flows.",
    keywords: ["acme-story", "storiez", "story", "novel"]
  },
  {
    id: "music-audio",
    name: "Music / Audio / Voice",
    description: "Music generation, audio processing, text-to-speech, singing, vocals, and provider proxies.",
    keywords: ["audio", "music", "suno", "sonauto", "mureka", "tts", "voice", "vocal", "singing", "qwen", "elevenlabs", "demucs", "audiosr", "soulx", "chatterbox", "openaudio", "spotify"]
  },
  {
    id: "video",
    name: "Video Studio",
    description: "Video generation, rendering, job status, workbench state, scenes, and video pipeline workers.",
    keywords: ["video", "render", "scene", "workbench", "pipeline"]
  },
  {
    id: "artwork-visual",
    name: "Artwork / Visual Studio",
    description: "Artwork generation, image processing, visual references, canvas tools, comics, and palettes.",
    keywords: ["artwork", "image", "visual", "canvas", "comic", "palette", "portrait", "fal", "imagen", "character"]
  },
  {
    id: "ai-generation",
    name: "AI Generation",
    description: "General AI generation, model proxies, OpenAI/OpenRouter/Gemini, ranking, and orchestration.",
    keywords: ["generate", "generation", "ai", "openai", "openrouter", "gemini", "model", "sota", "parallel"]
  },
  {
    id: "billing-commerce",
    name: "Billing / Commerce",
    description: "Payments, subscriptions, checkout, billing history, sponsor settlement, and payouts.",
    keywords: ["billing", "checkout", "stripe", "paypal", "polar", "subscription", "payment", "payout", "sponsorship", "financial", "gumroad"]
  },
  {
    id: "security-auth",
    name: "Security / Auth / Compliance",
    description: "Authentication, authorization, secrets, GDPR, security monitoring, keys, and compliance.",
    keywords: ["auth", "oauth", "jwt", "security", "secure", "gdpr", "pii", "credential", "secret", "token", "dpop", "key", "vulnerability", "rls"]
  },
  {
    id: "analytics-quality",
    name: "Analytics / QA / Quality",
    description: "Analytics, QA review, quality gates, scorecards, evaluations, dashboards, and reporting.",
    keywords: ["analytics", "qa", "quality", "score", "review", "eval", "report", "dashboard"]
  },
  {
    id: "publishing-distribution",
    name: "Publishing / Distribution",
    description: "Publishing, exports, uploads, distribution, preservation, RSS, and release workflows.",
    keywords: ["publish", "publishing", "distribution", "export", "upload", "preserve", "preservation", "rss", "release", "album"]
  },
  {
    id: "admin-ops",
    name: "Admin / Operations",
    description: "Admin screens, settings, cron jobs, migrations, health checks, alerts, and operational tools.",
    keywords: ["admin", "settings", "cron", "scheduler", "migration", "health", "canary", "alerting", "logs", "cleanup"]
  },
  {
    id: "testing",
    name: "Testing Suites",
    description: "E2E, integration, quality, security, performance, accessibility, and UAT test suites.",
    keywords: ["testing", "test", "suite", "e2e", "uat", "devops", "accessibility", "performance"]
  },
  {
    id: "workers-infra",
    name: "Workers / Infrastructure",
    description: "Runpod workers, queues, background processors, callbacks, file processing, and infrastructure.",
    keywords: ["runpod", "worker", "queue", "processor", "callback", "infrastructure", "cloudflare", "gpu"]
  },
  {
    id: "web-ui",
    name: "Web App UI",
    description: "Pages, reusable UI components, layout, stores, contexts, navigation, and app screens.",
    keywords: ["page_module", "component_module", "state_module", "context_module", "layout", "components", "pages", "stores", "contexts", "ui"]
  }
];

type FeatureCluster = { id: string; name: string; description: string };
type FeatureBrick = {
  id?: string; name?: string; kind?: string; status?: string; risk?: string;
  brick_group?: string; manifest_path?: string; source_paths?: string[];
  domain?: string[]; feature_cluster?: FeatureCluster;
};
type FeatureManifest = { brick?: { domain?: string[] } };

function textTokens(value: unknown): Set<string> {
  return new Set(String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function hasClusterKeyword(tokens: Set<string>, keyword: string): boolean {
  const keywordTokens = String(keyword || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  if (keywordTokens.length === 0) {
    return false;
  }

  return keywordTokens.every((token) => tokens.has(token));
}

function shortPath(brick: FeatureBrick): string {
  const [first] = brick.source_paths || [];
  return first || brick.manifest_path || "";
}

export function featureClusterForBrick(brick: FeatureBrick): FeatureCluster {
  const pathLabel = shortPath(brick);
  const searchText = [
    brick.id,
    brick.name,
    brick.kind,
    brick.status,
    brick.risk,
    brick.brick_group,
    pathLabel,
    ...(brick.domain || [])
  ].filter(Boolean).join(" ").toLowerCase();
  const tokens = textTokens(searchText);

  for (const rule of featureClusterRules) {
    if (rule.keywords.some((keyword) => hasClusterKeyword(tokens, keyword))) {
      return { id: rule.id, name: rule.name, description: rule.description };
    }
  }

  if (pathLabel.startsWith("supabase/functions")) {
    return {
      id: "backend-functions",
      name: "Backend Functions",
      description: "Supabase and serverless backend endpoints that need env, auth, RLS, and security review."
    };
  }

  return {
    id: "general",
    name: "General / Shared",
    description: "Shared modules, packages, and bricks that do not map cleanly to one product area yet."
  };
}

export function attachFeatureCluster<T extends FeatureBrick>(brick: T, manifest?: FeatureManifest | null): T {
  brick.domain = manifest?.brick?.domain || brick.domain || [];
  brick.feature_cluster = featureClusterForBrick(brick);
  return brick;
}
