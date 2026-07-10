import { spawnSync } from "node:child_process";

/**
 * OpenCode backend placeholder.
 *
 * Detection is implemented so controllers can report installation state, but
 * dispatch intentionally remains disabled until SMARCH defines and verifies
 * the OpenCode non-interactive protocol and token-usage response contract.
 */
export function isAvailable() {
  const probe = spawnSync("opencode", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

export async function execute() {
  const available = isAvailable();
  return {
    ok: false,
    output: "",
    tokensIn: 0,
    tokensOut: 0,
    retryable: false,
    raw: {
      backend: "opencode",
      configured: false,
      available,
      error: "opencode backend is not configured",
    },
  };
}
