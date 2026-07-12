/* eslint-disable @typescript-eslint/no-unnecessary-condition -- CLI argv indexing can be absent at runtime even though the standard library type models indexed access as a string. */
/** Small, testable CLI parsing and help seams for sma-parallel-preflight.ts. */

import type { PreflightArgs } from './parallel-preflight-types.d.ts';

export function usage(): void {
  console.log(`Usage:
	  sma-parallel-preflight.ts [--limit 3|auto] [--auto-limit] [--max-agents 12]
		                             [--project <id>]
		                             [--task "..."]
                             [--write-dispatch [path]]
		                             [--launch-plan] [--full-prompts] [--json] [--strict]
                             [--no-auto-refresh] [--allow-stale]
                             [--processes] [--stale-process-seconds <n>]
                             [--selftest|selftest]

Runs the low-token Gen3 controller preflight for parallel agent launches.
By default stale cleanup/graph packets are auto-refreshed once by the packet
tools. Use --auto-limit for the largest currently safe local cleanup wave,
capped by --max-agents. Use --no-auto-refresh for read-only dashboard checks.
Use --launch-plan to print compact cleanup slots and current module-dispatch
claim slots in text mode. Use --full-prompts only when you need the legacy
long prompt text; module agents should read their packet first.
`);
}

export function parseArgs(list: string[]): PreflightArgs {
  const out: PreflightArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('-');
    if (isBool) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}
