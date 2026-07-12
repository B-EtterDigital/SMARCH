/** Platform seam for Sweetspot Process Lease (SPL).
 *
 * Process identity is always PID plus an opaque start token. Linux uses
 * /proc/<pid>/stat field 22. Additive Darwin and Windows adapters may use
 * `ps -o lstart=` and PowerShell StartTime respectively without changing SPL.
 */
export interface SplBudgetSnapshot {
  cores: number;
  load: number;
  mem_available_gb: number;
  swap_used_pct: number;
  pressure: 'ok' | 'warn' | 'critical';
  recommended_agents: number;
}

export interface SplCommandRunner {
  run(command: string, args: string[]): string;
}

interface SplTerminateOptions { graceMs: number }
export interface SplTerminateResult { outcome: 'terminated' | 'killed' | 'already-dead' | 'identity-mismatch' | 'signal-refused'; signals?: ('SIGTERM' | 'SIGKILL')[] }

export interface SplPlatform {
  startToken(pid: number): string | null;
  sessionId(pid: number): number | null;
  isAlive(pid: number, token: string): boolean;
  terminate(pid: number, token: string, options: SplTerminateOptions): Promise<SplTerminateResult>;
  budgetSnapshot(): SplBudgetSnapshot;
}

class SplPlatformUnsupportedError extends Error {
  readonly code = 'SPL_PLATFORM_UNSUPPORTED';
  constructor(platform: string) {
    super(`SPL_PLATFORM_UNSUPPORTED: ${platform}; see docs/SPL_SWEETSPOT_PROCESS_LEASE.md#platform-support`);
    this.name = 'SplPlatformUnsupportedError';
  }
}

export async function resolveSplPlatform(procRoot?: string, platform: NodeJS.Platform = process.platform, runner?: SplCommandRunner): Promise<SplPlatform> {
  if (platform === 'linux') {
    const { linuxSplPlatform } = await import('./linux.ts');
    return linuxSplPlatform(procRoot);
  }
  if (platform === 'darwin') {
    const { darwinSplPlatform } = await import('./darwin.ts');
    return darwinSplPlatform(runner);
  }
  if (platform === 'win32') {
    const { win32SplPlatform } = await import('./win32.ts');
    return win32SplPlatform(runner);
  }
  throw new SplPlatformUnsupportedError(platform);
}
