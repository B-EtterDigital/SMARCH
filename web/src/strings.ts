export const STRINGS = {
  appName: "SMARCH",
  appDescriptor: "Blueprint Ledger",
  documentTitle: "SMARCH Blueprint Ledger",
  skipToContent: "Skip to ledger content",
  navigation: "Primary navigation",
  nav: {
    ledger: "Ledger",
    bricks: "Bricks",
    leases: "Leases",
    conflicts: "Conflicts",
    graph: "Graph",
    settings: "Settings"
  },
  navMarks: {
    ledger: "L",
    bricks: "B",
    leases: "↗",
    conflicts: "!",
    graph: "◇",
    settings: "="
  },
  routeEyebrow: "CONTROL PLANE / READ ONLY",
  routeTitles: {
    ledger: "Operations ledger",
    bricks: "Brick registry",
    leases: "Active lease yard",
    conflicts: "Conflict ledger",
    graph: "Module graph",
    settings: "Dashboard settings"
  },
  routeDescriptions: {
    ledger: "Live coordination facts, arranged like the engineering record they are.",
    bricks: "Trust, provenance, and module ownership across the indexed portfolio.",
    leases: "Every current claim with intent and time-to-live in one departures board.",
    conflicts: "Open collisions first, with resolution state preserved as an audit trail.",
    graph: "A read-only map of module graph coverage and structural weight.",
    settings: "Local display and connection facts. Mutation controls remain server-owned."
  },
  stats: {
    bricks: "Bricks indexed",
    canonical: "Canonical",
    leases: "Active leases",
    conflicts: "Conflicts / 30d"
  },
  statsStates: {
    label: "Portfolio statistics",
    empty: "No portfolio statistics are available.",
    error: "Portfolio statistics could not be loaded."
  },
  section: {
    activeLeases: "Active leases",
    recentConflicts: "Recent conflicts",
    conflictHeat: "30-day conflict heat",
    moduleActivity: "Module activity",
    registry: "Registry",
    graphCoverage: "Graph coverage"
  },
  leaseColumns: {
    agent: "Agent",
    brick: "Brick",
    intent: "Intent",
    ttl: "TTL",
    state: "State"
  },
  conflictColumns: {
    when: "When",
    module: "Module",
    brick: "Brick",
    agents: "Agents",
    resolution: "Resolution"
  },
  brickColumns: {
    id: "Brick",
    project: "Project",
    trust: "Trust",
    score: "Score"
  },
  verdicts: {
    pass: "PASS",
    fail: "FAIL",
    waived: "WAIVED",
    open: "OPEN",
    resolved: "RESOLVED",
    active: "ACTIVE",
    expired: "EXPIRED"
  },
  verdictIcons: { pass: "✓", fail: "×", waived: "–" },
  loading: "…loading ledger",
  errors: {
    heading: "Ledger connection interrupted",
    body: "The local dashboard API did not answer. Confirm the server is running, then retry.",
    retry: "Retry connection"
  },
  empty: {
    leases: "No active leases — the yard is quiet.",
    leasesCommand: "npm run start:edit -- --project <id> --brick <id> --intent '<work>'",
    conflicts: "No open conflicts — coordination lines are clear.",
    conflictsError: "Conflict history is temporarily out of reach — the recovery command is ready.",
    conflictsCommand: "npm run conflict:summary",
    heatStrip: "No conflict heat yet — the last thirty days are clear.",
    bricks: "No indexed bricks — the ledger is waiting for a scan.",
    bricksCommand: "npm run scan:safe",
    graph: "No module graphs — build the local retrieval layer.",
    graphCommand: "npm run graphify:refresh:modules -- --project <id>"
  },
  search: {
    label: "Search registry",
    placeholder: "Search brick or project…",
    hint: "/ to focus",
    noResults: "No matching ledger entries."
  },
  filter: {
    all: "All modules",
    label: "Filter by module",
    loading: "…loading module filter",
    error: "Module filter unavailable",
    empty: "No modules available."
  },
  leaseBoard: {
    label: "Active lease departures board",
    loading: "…loading lease ledger",
    error: "Lease ledger unavailable",
    retry: "Retry lease ledger"
  },
  provenance: {
    label: "Provenance attestation chain",
    sealLabel: "Provenance seal",
    attestationLabel: "Attestation JSON",
    loading: "…loading provenance chain",
    error: "Provenance chain unavailable",
    empty: "No provenance seals recorded.",
    retry: "Retry provenance chain",
    copy: "Copy attestation JSON",
    copied: "Attestation copied"
  },
  appShell: {
    empty: "No ledger surface is available for this route."
  },
  brickCard: {
    idLabel: "Brick identifier",
    ownerTrail: "Owner trail",
    gates: "Quality gates",
    gate: "Gate",
    verdict: "Verdict",
    health: "Health",
    clone: "Clone command",
    loading: "…loading brick record",
    empty: "No brick selected.",
    error: "Brick record unavailable."
  },
  brickDetail: {
    title: "Brick detail",
    close: "Close brick detail",
    closeMark: "×",
    panelMissing: "Brick detail panel is missing"
  },
  brickWall: {
    label: "Brick trust wall",
    loading: "…loading brick wall",
    empty: "No bricks match this ledger view.",
    error: "Brick wall unavailable.",
    openDetail: (id: string) => `Open details for ${id}`,
    reuseCount: (count: number) => `${String(count)} reuses`
  },
  trust: {
    candidate: "CANDIDATE",
    verified: "VERIFIED",
    canonical: "CANONICAL"
  },
  trustIcons: {
    candidate: "○",
    verified: "✓",
    canonical: "◆"
  },
  theme: {
    dark: "Use dark blueprint theme",
    light: "Use light paper theme"
  },
  themeIcons: { light: "☼", dark: "◐" },
  themeMarks: { light: "L", dark: "D" },
  rail: {
    collapse: "Collapse navigation rail",
    expand: "Expand navigation rail"
  },
  settings: {
    appearance: "Appearance",
    endpoint: "SSE endpoint",
    dataRoot: "Data root",
    mode: "Read-only mode",
    modeDescription: "Data routes only inspect local generated artifacts. Client error reports write one structured line to server stderr.",
    dark: "Dark blueprint",
    light: "Light paper",
    endpointValue: "/api/events",
    dataRootValue: "SMA_ROOT"
  },
  graph: {
    reset: "Reset graph view",
    controls: "Graph view controls",
    zoomIn: "Zoom graph in",
    zoomOut: "Zoom graph out",
    nodes: "Nodes",
    links: "Links",
    updated: "Updated",
    nodeSuffix: "nodes",
    edgeSuffix: "links",
    selectNode: (module: string) => `Open ${module} module details`,
    summary: (module: string, nodes: number, links: number) => `${module}: ${String(nodes)} nodes, ${String(links)} links`
  },
  heatStrip: {
    thirtyDaysAgo: "30 days ago",
    today: "Today",
    summary: (module: string, total: number) => `${module}: ${String(total)} conflicts in the last 30 days`
  },
  conflictLedger: {
    caption: "Conflict history with open conflicts first"
  },
  toast: {
    connected: "Live ledger connected",
    refreshed: "Ledger refreshed",
    disconnected: "Live updates disconnected",
    centerLabel: "Dashboard notifications",
    dismiss: "Dismiss notification"
  },
  copy: "Copy command",
  copied: "Copied",
  unknown: "Unknown",
  agentSeparator: " vs ",
  relativeNow: "<1m",
  minuteSuffix: "m",
  hourSuffix: "h",
  daySuffix: "d",
  appRootMissing: "Dashboard application root is missing",
  railKeyHint: "[ ] rail",
  close: "Close",
  components: {
    registryTable: {
      caption: "Registry ledger",
      columns: { brick: "Brick", project: "Project", status: "Status", score: "Score" },
      loading: "…loading registry ledger",
      empty: "No registry entries match the current ledger view.",
      error: "Registry ledger unavailable.",
      retry: "Retry registry",
      sortAscending: "Sort ascending",
      sortDescending: "Sort descending",
      rowCount: "registry entries"
    },
    sealChip: {
      loading: "…checking seal",
      error: "Seal verification failed",
      broken: "Broken provenance chain",
      labels: { pass: "PASS", fail: "FAIL", waived: "WAIVED", active: "ACTIVE" }
    },
    searchBar: {
      label: "Search ledger",
      placeholder: "Search bricks, modules, or leases…",
      shortcut: "/",
      shortcutHint: "/ to focus",
      loading: "…searching ledger",
      empty: "No ledger results.",
      error: "Ledger search unavailable.",
      retry: "Retry search",
      results: "Search results",
      kinds: { brick: "Bricks", module: "Modules", lease: "Leases" }
    },
    settingsPanel: {
      heading: "Dashboard settings",
      appearance: "Theme",
      dark: "Dark blueprint",
      light: "Light paper",
      endpoint: "SSE endpoint",
      dataRoot: "Data root path",
      readOnly: "READ-ONLY MODE",
      readOnlyDescription: "This dashboard inspects generated local data. Mutations remain available only through the authenticated control plane.",
      loading: "…loading settings ledger",
      error: "Dashboard settings unavailable.",
      retry: "Retry settings"
    }
  }
} as const;
