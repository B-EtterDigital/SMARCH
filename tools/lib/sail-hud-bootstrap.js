// @ts-nocheck — browser-context source injected verbatim over CDP; never executed in Node.
/**
 * sail-hud-bootstrap.js — the SAIL test HUD, injected into an app's main window
 * via CDP (Runtime.evaluate + Page.addScriptToEvaluateOnNewDocument). No app source
 * changes. Shows the human WHICH agent is testing WHAT, top-right, collapsible.
 *
 * Anti-interference contract:
 *  - closed shadow root: app CSS cannot restyle it, it cannot leak styles out
 *  - aria-hidden host: invisible to accessibility snapshots (Playwright
 *    snapshot / CDP a11y tree), so agents never "see" their own HUD
 *  - pointer-events: none everywhere EXCEPT the collapse/expand hit target,
 *    so agent clicks pass through; default top offset clears frameless
 *    window controls
 *  - window.__SMA_SAIL_HUD__.hide()/show() lets drivers exclude it from
 *    screenshots; update() is idempotent and never throws into the app
 */
(() => {
  'use strict';
  try {
    const HOST_ID = 'sma-sail-hud-host';
    const LS_KEY = 'sma.sail.hud.collapsed';
    const SS_KEY = 'sma.sail.hud.last';
    if (window.__SMA_SAIL_HUD__ && document.getElementById(HOST_ID)) return;

    const state = {
      agent: '—', intent: 'waiting for agent…', phase: 'idle',
      queue: 0, since: Date.now(), offsetTop: 44, collapsed: false, hidden: false,
    };

    // Per-agent accent: identifies WHO (name, pill edge, collapsed-dot ring);
    // the beacon alone keeps meaning WHAT PHASE. Deterministic hash → an agent
    // keeps its color across instances, handoffs, and reloads.
    const ACCENTS = ['#ffb86b', '#c9a2ff', '#ff9db5', '#7de3d8', '#d8e07a', '#9fb8ff'];
    function accentFor(agent) {
      let hash = 5381;
      const name = String(agent || '');
      for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
      return ACCENTS[Math.abs(hash) % ACCENTS.length];
    }
    try { state.collapsed = localStorage.getItem(LS_KEY) === '1'; } catch {}
    try { Object.assign(state, JSON.parse(sessionStorage.getItem(SS_KEY) || '{}'), { hidden: false }); } catch {}

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('data-sma-sail-hud', '1');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed; z-index: 2147483646;
          top: ${state.offsetTop}px; right: 12px;
          pointer-events: none;
          font: 500 12px/1.45 system-ui, -apple-system, sans-serif;
          display: flex; flex-direction: column; align-items: flex-end;
        }
        .pill {
          display: flex; align-items: flex-start; gap: 8px;
          max-width: 320px; padding: 8px 10px 8px 12px;
          background: rgba(16, 18, 24, 0.88); color: #e8eaf0;
          border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
          backdrop-filter: blur(6px);
          box-shadow: 0 4px 18px rgba(0,0,0,0.35);
        }
        .dotwrap { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .beacon { width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; flex: none; }
        .beacon.steering { background: #7dd97b; animation: pulse 1.2s ease-in-out infinite; }
        .beacon.observing { background: #6fb7ff; animation: pulse 1.8s ease-in-out infinite; }
        .beacon.idle { background: #8a8f9c; }
        @keyframes pulse { 50% { opacity: 0.35; } }
        .txt { min-width: 0; }
        .agent { font-weight: 700; letter-spacing: 0.01em; white-space: nowrap;
                 overflow: hidden; text-overflow: ellipsis; }
        .intent { opacity: 0.85; font-weight: 400; overflow-wrap: anywhere; }
        .meta { opacity: 0.55; font-size: 10px; margin-top: 2px; }
        .x {
          pointer-events: auto; cursor: pointer; flex: none;
          width: 16px; height: 16px; border-radius: 5px;
          display: grid; place-items: center;
          color: #aab0bd; font: 700 12px/1 system-ui;
          user-select: none;
        }
        .x:hover { background: rgba(255,255,255,0.12); color: #fff; }
        .mini {
          pointer-events: auto; cursor: pointer;
          width: 14px; height: 14px; border-radius: 50%;
          background: rgba(16,18,24,0.88); border: 1px solid rgba(255,255,255,0.2);
          display: none; place-items: center;
        }
        .mini .beacon { margin: 0; width: 6px; height: 6px; }
        .collapsed .pill { display: none; }
        .collapsed .mini { display: grid; }
        .hidden-all { visibility: hidden; }
      </style>
      <div class="wrap" part="wrap">
        <div class="pill">
          <div class="dotwrap">
            <div class="beacon idle"></div>
            <div class="txt">
              <div class="agent"></div>
              <div class="intent"></div>
              <div class="meta"></div>
            </div>
          </div>
          <div class="x" title="collapse">×</div>
        </div>
        <div class="mini" title="agent test HUD — click to expand"><div class="beacon idle"></div></div>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    const wrap = $('.wrap');

    function render() {
      wrap.classList.toggle('collapsed', state.collapsed);
      wrap.classList.toggle('hidden-all', state.hidden);
      wrap.style.top = `${state.offsetTop}px`;
      for (const b of root.querySelectorAll('.beacon')) b.className = `beacon ${state.phase}`;
      const accent = accentFor(state.agent);
      const agentEl = $('.agent');
      agentEl.textContent = state.agent;
      agentEl.style.color = state.agent && state.agent !== '—' ? accent : '';
      $('.pill').style.borderLeft = state.agent && state.agent !== '—'
        ? `2px solid ${accent}`
        : '2px solid rgba(255,255,255,0.14)';
      $('.mini').style.boxShadow = state.agent && state.agent !== '—'
        ? `0 0 0 1px ${accent}`
        : 'none';
      $('.intent').textContent = state.intent;
      const mins = Math.floor((Date.now() - state.since) / 60000);
      const held = mins < 1 ? 'just started' : `${mins} min`;
      $('.meta').textContent = state.queue > 0
        ? `${held} · ${state.queue} agent${state.queue > 1 ? 's' : ''} waiting`
        : held;
    }

    function setCollapsed(collapsed) {
      state.collapsed = collapsed;
      try { localStorage.setItem(LS_KEY, collapsed ? '1' : '0'); } catch {}
      render();
    }
    $('.x').addEventListener('click', (ev) => { ev.stopPropagation(); setCollapsed(true); });
    $('.mini').addEventListener('click', (ev) => { ev.stopPropagation(); setCollapsed(false); });

    let timer = null;
    function ensureTimer() {
      if (timer) return;
      timer = setInterval(() => { if (!document.hidden && !state.collapsed) render(); }, 30_000);
    }

    window.__SMA_SAIL_HUD__ = {
      update(patch) {
        try {
          if (patch && typeof patch === 'object') {
            if (patch.since === 'now') patch.since = Date.now();
            Object.assign(state, patch);
            try { sessionStorage.setItem(SS_KEY, JSON.stringify({
              agent: state.agent, intent: state.intent, phase: state.phase,
              queue: state.queue, since: state.since, offsetTop: state.offsetTop,
            })); } catch {}
          }
          render(); ensureTimer();
        } catch {}
      },
      hide() { try { state.hidden = true; render(); } catch {} },
      show() { try { state.hidden = false; render(); } catch {} },
      collapse() { try { setCollapsed(true); } catch {} },
      expand() { try { setCollapsed(false); } catch {} },
      remove() { try { clearInterval(timer); host.remove(); delete window.__SMA_SAIL_HUD__; } catch {} },
    };

    const mount = () => (document.body || document.documentElement).appendChild(host);
    if (document.body || document.documentElement) mount();
    else document.addEventListener('DOMContentLoaded', mount, { once: true });
    render(); ensureTimer();
  } catch { /* never break the app under test */ }
})();
