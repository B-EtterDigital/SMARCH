/**
 * WHAT: Talks CDP to a running app instance to install, update, hide, or watch the SAIL test HUD.
 * WHY: The human at the screen must see which agent is testing what without the HUD disturbing the agents.
 * HOW: A minimal WebSocket CDP client injects tools/lib/sail-hud-bootstrap.js into a closed shadow root and
 * pushes state updates; watch mode holds the session open and re-injects on every page load because
 * Page.addScriptToEvaluateOnNewDocument registrations die with their CDP session (verified Chrome 146).
 * Callers are tools/sma-sail.ts (keeper + one-shot actions) and steer drivers that hide the HUD around captures.
 * Format and command terms are defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { bootstrapSource } from './tools/lib/sail-hud.ts'; console.log(bootstrapSource().length)"
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

export interface SailHudState {
  agent?: string;
  intent?: string;
  phase?: string;
  queue?: number;
  offsetTop?: number;
  since?: number | 'now';
}

interface CdpTarget { type: string; url: string; title?: string; webSocketDebuggerUrl?: string }

interface CdpMessage { id?: number; method?: string; params?: unknown; result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string }; data?: string }; error?: { message?: string } }

export interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<CdpMessage['result']>;
  on(eventName: string, handler: () => void): void;
  close(): void;
}

export function bootstrapSource(): string {
  return readFileSync(join(LIB_DIR, 'sail-hud-bootstrap.js'), 'utf8');
}

export async function pickPageTarget(port: number, targetPattern?: string): Promise<CdpTarget | null> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
  const targets = (await response.json()) as CdpTarget[];
  const pages = targets.filter((target) => target.type === 'page' && Boolean(target.webSocketDebuggerUrl));
  if (!targetPattern) return pages[0] ?? null;
  const expression = new RegExp(targetPattern);
  return pages.find((target) => expression.test(target.url) || expression.test(target.title ?? '')) ?? null;
}

export function connectCdp(webSocketUrl: string): Promise<CdpClient> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(webSocketUrl);
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: CdpMessage['result']) => void; reject: (error: Error) => void; method: string }>();
    const listeners = new Map<string, () => void>();
    socket.onopen = () => {
      resolvePromise({
        send(method, params = {}) {
          return new Promise((resolveSend, rejectSend) => {
            sequence += 1;
            pending.set(sequence, { resolve: resolveSend, reject: rejectSend, method });
            socket.send(JSON.stringify({ id: sequence, method, params }));
          });
        },
        on(eventName, handler) { listeners.set(eventName, handler); },
        close() { socket.close(); },
      });
    };
    socket.onerror = () => { rejectPromise(new Error(`SAIL_CDP_CONNECT_FAILED: ${webSocketUrl}`)); };
    socket.onmessage = (message: MessageEvent) => {
      const data = JSON.parse(String(message.data)) as CdpMessage;
      if (data.method) { listeners.get(data.method)?.(); return; }
      if (data.id === undefined) return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) entry.reject(new Error(`SAIL_CDP_${entry.method}: ${data.error.message ?? 'error'}`));
      else entry.resolve(data.result);
    };
  });
}

async function evaluate(client: CdpClient, expression: string): Promise<void> {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  if (result?.exceptionDetails) throw new Error(`SAIL_HUD_EVALUATE_FAILED: ${result.exceptionDetails.text ?? 'exception'}`);
}

export async function openHudSession(port: number, targetPattern?: string): Promise<CdpClient> {
  const target = await pickPageTarget(port, targetPattern);
  if (!target?.webSocketDebuggerUrl) throw new Error(`SAIL_HUD_NO_TARGET: no page target on 127.0.0.1:${String(port)}`);
  return connectCdp(target.webSocketDebuggerUrl);
}

/** Inject the bootstrap into the live document and apply an initial state. */
export async function installHud(client: CdpClient, state: SailHudState): Promise<void> {
  await client.send('Page.enable');
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrapSource() });
  await evaluate(client, bootstrapSource());
  await updateHud(client, { since: 'now', ...state });
}

export async function updateHud(client: CdpClient, state: SailHudState): Promise<void> {
  await evaluate(client, `window.__SMA_SAIL_HUD__ && window.__SMA_SAIL_HUD__.update(${JSON.stringify(state)})`);
}

export async function hudAction(client: CdpClient, action: 'hide' | 'show' | 'remove'): Promise<void> {
  await evaluate(client, `window.__SMA_SAIL_HUD__ && window.__SMA_SAIL_HUD__.${action}()`);
}

/** Capture a screenshot; by default the HUD hides around the capture so agent evidence stays clean. */
export async function hudScreenshot(client: CdpClient, withHud: boolean): Promise<Buffer> {
  if (!withHud) await hudAction(client, 'hide');
  const result = await client.send('Page.captureScreenshot', { format: 'png' });
  if (!withHud) await hudAction(client, 'show');
  if (!result?.data) throw new Error('SAIL_HUD_SCREENSHOT_FAILED');
  return Buffer.from(result.data, 'base64');
}

export interface HudKeeperOptions {
  port: number;
  targetPattern?: string;
  readState: () => SailHudState | null;
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Hold a CDP session open, re-inject the HUD on every page load, and push the
 * registry-derived state whenever it changes. Runs until aborted or the
 * instance disappears.
 */
export async function runHudKeeper(options: HudKeeperOptions): Promise<void> {
  const client = await openHudSession(options.port, options.targetPattern);
  const initial = options.readState();
  if (!initial) { client.close(); return; }
  await installHud(client, initial);
  let lastSerialized = JSON.stringify(initial);
  client.on('Page.loadEventFired', () => {
    const state = options.readState();
    installHud(client, state ?? {}).catch(() => { /* app mid-navigation; next load retries */ });
  });
  const pollMs = options.pollMs ?? 1500;
  try {
    for (;;) {
      if (options.signal?.aborted) return;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
      const state = options.readState();
      if (state === null) return;
      const serialized = JSON.stringify(state);
      if (serialized === lastSerialized) continue;
      lastSerialized = serialized;
      try { await updateHud(client, state); } catch { /* transient CDP hiccup; next poll retries */ }
    }
  } finally {
    client.close();
  }
}
