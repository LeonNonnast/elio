// ───────────────────────────── @elio/studio — Dashboard (self-contained vanilla JS + HTML) ─────────────────────────────
// Eine EINZIGE self-contained HTML-Seite (kein Build-Step, kein Frontend-Framework, keine externen
// Assets — CSP-safe für lokale Auslieferung): inline CSS + inline vanilla JS, die die @elio/studio-API
// pollt + den SSE-Stream abonniert. Die Seite ist ein reiner CLIENT (Inv. 2): sie LIEST über
//  - GET /api/runs            -> store.liveStatus()        (Run-Status, Approvals, Stat-Cards)
//  - GET /api/runs/:id/tape   -> store.tape(run)           (Loop-Timeline + Tape-Scrubber pro Run)
//  - GET /api/features        -> Feature-Katalog           (Detail-Panel: "was steckt drin")
//  - GET /api/stream (SSE)    -> store.subscribe()         (Live-Updates: neue Events animieren rein)
// und SCHREIBT ausschließlich über
//  - POST /api/resume         -> runtime.resume(correlation, answer)   (Elicitation-Antwort, EINZIGER
//                                                                       Schreibpfad — Inv. 2/§2).
//
// Die UI projiziert NUR gelesene Daten (Inv. 2): die Loop-Timeline ist eine Anzeige der Tape-Frames +
// Live-Events (Artefakt-Version, Gate-Verdikt, Budget-Burndown, Suspend/Resume-Marker) — sie berechnet
// KEINE Engine-Logik, sie spiegelt nur, was Store/Status bereits sagen.
//
// Als String exportiert, damit der node:http-Server sie ohne Datei-IO ausliefert. DASHBOARD_MARKER ist
// ein stabiler String im HTML, gegen den der AC-Test (GET / -> enthält Marker) prüft.

/** Stabiler Marker im Dashboard-HTML (AC-Test: GET / liefert HTML, das diesen Marker enthält). */
export const DASHBOARD_MARKER = "elio-studio-dashboard";

/**
 * Liefert die vollständige Dashboard-HTML-Seite. `title` erscheint im <title> + Header. Die Seite ist
 * komplett self-contained (inline CSS/JS, keine externen Requests) — bereit für eine restriktive CSP.
 *
 * Hinweis: Der node:http-Server wrappt den Body NICHT in ein zusätzliches HTML-Skelett (anders als der
 * Artifact-Pfad) — diese Seite IST das vollständige Dokument inkl. <!doctype html>.
 */
export function dashboardHtml(title = "ELIO Studio"): string {
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>
${DASHBOARD_CSS}
</style>
</head>
<body data-app="${DASHBOARD_MARKER}">
${DASHBOARD_BODY}
<script>
var ELIO_SAMPLE = null;
${DASHBOARD_JS}
</script>
</body>
</html>`;
}

// ───────────────────────────── Design system + markup + behaviour (shared with the static preview) ─────────────────────────────
// CSS, body-markup and client-JS are exported as strings so the static preview snapshot
// (packages/studio/preview/dashboard-preview.html) reuses the EXACT same dashboard — only the data
// source differs (live API vs. inlined ELIO_SAMPLE). One design, two data sources.

/**
 * Das Design-System (CSS custom properties: 1 Accent + Neutral-Scale, Radien, Schatten, Spacing,
 * Motion-Tokens) + alle Sektionen-Styles. Light/Dark über prefers-color-scheme + Toggle-Override
 * (data-theme auf <html>). Verspielt, wenige Farben, weicher Schatten sparsam, system-ui + ui-monospace.
 */
export const DASHBOARD_CSS = `
:root {
  /* ── Accent: a single iris/indigo — the one bold colour. Everything else is neutral or semantic. ── */
  --accent: #5b6cff;
  --accent-weak: rgba(91, 108, 255, 0.14);
  --accent-line: rgba(91, 108, 255, 0.42);
  --on-accent: #ffffff;

  /* ── Semantic state (kept separate from the accent; desaturated, used only as pills/stripes). ── */
  --ok: #2fb170;        --ok-weak: rgba(47, 177, 112, 0.15);
  --warn: #d6952b;      --warn-weak: rgba(214, 149, 43, 0.16);
  --bad: #d65a52;       --bad-weak: rgba(214, 90, 82, 0.16);

  /* ── Neutral scale, biased a touch toward the accent so it reads chosen (light theme). ── */
  --bg: #f4f5fa;
  --surface: #ffffff;
  --surface-2: #f7f8fc;
  --border: #e4e6f0;
  --border-strong: #d3d6e6;
  --fg: #1b1e2a;
  --muted: #5c6276;
  --faint: #8a90a4;

  /* ── Radii / shadow (soft, sparing) / spacing / motion tokens. ── */
  --r-sm: 8px; --r-md: 12px; --r-lg: 18px; --r-pill: 999px;
  --shadow-1: 0 1px 2px rgba(20, 22, 40, 0.05);
  --shadow-2: 0 8px 30px rgba(20, 22, 40, 0.10);
  --sp-1: 6px; --sp-2: 10px; --sp-3: 16px; --sp-4: 22px; --sp-5: 32px;
  --ease: cubic-bezier(0.22, 0.8, 0.36, 1);
  --t-fast: 140ms; --t-mid: 260ms; --t-slow: 460ms;

  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0f15;
    --surface: #16181f;
    --surface-2: #1b1e27;
    --border: #262a36;
    --border-strong: #333848;
    --fg: #e9eaf2;
    --muted: #9aa0b4;
    --faint: #6c7286;
    --accent-weak: rgba(91, 108, 255, 0.20);
    --accent-line: rgba(91, 108, 255, 0.55);
    --ok-weak: rgba(47, 177, 112, 0.18);
    --warn-weak: rgba(214, 149, 43, 0.18);
    --bad-weak: rgba(214, 90, 82, 0.20);
    --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-2: 0 10px 34px rgba(0, 0, 0, 0.5);
  }
}
/* Explicit theme override via the toggle (wins over the media query). */
:root[data-theme="light"] {
  --bg: #f4f5fa; --surface: #ffffff; --surface-2: #f7f8fc; --border: #e4e6f0;
  --border-strong: #d3d6e6; --fg: #1b1e2a; --muted: #5c6276; --faint: #8a90a4;
  --accent-weak: rgba(91, 108, 255, 0.14); --accent-line: rgba(91, 108, 255, 0.42);
  --ok-weak: rgba(47, 177, 112, 0.15); --warn-weak: rgba(214, 149, 43, 0.16);
  --bad-weak: rgba(214, 90, 82, 0.16);
  --shadow-1: 0 1px 2px rgba(20, 22, 40, 0.05); --shadow-2: 0 8px 30px rgba(20, 22, 40, 0.10);
}
:root[data-theme="dark"] {
  --bg: #0e0f15; --surface: #16181f; --surface-2: #1b1e27; --border: #262a36;
  --border-strong: #333848; --fg: #e9eaf2; --muted: #9aa0b4; --faint: #6c7286;
  --accent-weak: rgba(91, 108, 255, 0.20); --accent-line: rgba(91, 108, 255, 0.55);
  --ok-weak: rgba(47, 177, 112, 0.18); --warn-weak: rgba(214, 149, 43, 0.18);
  --bad-weak: rgba(214, 90, 82, 0.20);
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4); --shadow-2: 0 10px 34px rgba(0, 0, 0, 0.5);
}

* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg); color: var(--fg); font-family: var(--sans);
  line-height: 1.5; font-size: 14px; -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
.eyebrow { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.09em;
  font-weight: 700; color: var(--faint); }
button { font-family: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

/* ── App shell ─────────────────────────────────────────────────────────────── */
.shell { max-width: 1320px; margin: 0 auto; padding: 0 var(--sp-4) var(--sp-5); }
header.topbar {
  position: sticky; top: 0; z-index: 30;
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: saturate(1.4) blur(10px);
  border-bottom: 1px solid var(--border);
}
.topbar-in { max-width: 1320px; margin: 0 auto; padding: 14px var(--sp-4);
  display: flex; align-items: center; gap: var(--sp-3); }
.brand { display: flex; align-items: center; gap: 10px; }
.brand .glyph {
  width: 28px; height: 28px; border-radius: 9px; flex: none;
  background:
    radial-gradient(circle at 30% 30%, color-mix(in srgb, var(--accent) 92%, white) 0%, var(--accent) 60%, color-mix(in srgb, var(--accent) 70%, black) 100%);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.18), 0 2px 8px var(--accent-weak);
  position: relative;
}
/* a little orbiting loop — the engine's signature motif, drawn in pure CSS (CSP-safe). */
.brand .glyph::after {
  content: ""; position: absolute; inset: 6px; border-radius: 50%;
  border: 1.6px solid rgba(255,255,255,0.85); border-right-color: transparent;
  animation: orbit 3.2s linear infinite;
}
@keyframes orbit { to { transform: rotate(360deg); } }
.brand h1 { font-size: 15px; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
.brand .sub { font-size: 11.5px; color: var(--faint); margin-top: -1px; }
.topbar .spacer { margin-left: auto; }
.live {
  display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted);
  padding: 5px 11px; border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--surface);
}
.live .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint);
  transition: background var(--t-mid) var(--ease), box-shadow var(--t-mid) var(--ease); }
.live.on .dot { background: var(--ok); box-shadow: 0 0 0 0 var(--ok-weak); animation: beat 2.4s var(--ease) infinite; }
@keyframes beat { 0% { box-shadow: 0 0 0 0 var(--ok-weak); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }

.iconbtn {
  width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--fg); cursor: pointer; font-size: 15px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background var(--t-fast) var(--ease), transform var(--t-fast) var(--ease), border-color var(--t-fast);
}
.iconbtn:hover { background: var(--surface-2); border-color: var(--border-strong); }
.iconbtn:active { transform: scale(0.94); }

/* ── Hero explainer (the "what is this / why do I care", first thing you read) ── */
.hero {
  margin-top: var(--sp-4);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-1); padding: var(--sp-4) var(--sp-4);
  display: grid; grid-template-columns: 1.25fr 1fr; gap: var(--sp-4) var(--sp-5);
  align-items: center; position: relative; overflow: hidden;
}
.hero::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(130% 150% at 100% 0%, var(--accent-weak), transparent 58%);
}
@media (max-width: 900px) { .hero { grid-template-columns: 1fr; } }
.hero-copy { position: relative; }
.hero-copy h2 { margin: 6px 0 8px; font-size: 22px; line-height: 1.18; letter-spacing: -0.02em; }
.hero-copy h2 .pop { color: var(--accent); }
.hero-copy p { margin: 0; color: var(--muted); font-size: 13.5px; max-width: 56ch; }
.hero-copy p b { color: var(--fg); font-weight: 600; }
/* the loop motif: produce → judge → loop until it passes → done, drawn as chips (pure CSS, CSP-safe) */
.flow { position: relative; display: flex; align-items: stretch; gap: 7px; flex-wrap: wrap; justify-content: center; }
.flow .b {
  display: flex; flex-direction: column; gap: 2px; justify-content: center;
  border: 1px solid var(--border); border-radius: var(--r-md); padding: 9px 11px;
  background: var(--surface-2); min-width: 78px; text-align: center;
}
.flow .b .t { font-weight: 700; font-size: 12.5px; }
.flow .b .s { font-size: 10px; color: var(--faint); letter-spacing: 0.01em; }
.flow .b.gate { border-color: var(--accent-line); background: var(--accent-weak); }
.flow .b.done { border-color: color-mix(in srgb, var(--ok) 45%, transparent); background: var(--ok-weak); }
.flow .b.done .t { color: var(--ok); }
.flow .arr { align-self: center; color: var(--faint); font-size: 13px; font-weight: 700; }
.flow .arr.loop { color: var(--accent); }

/* ── Stat cards (the at-a-glance row) ──────────────────────────────────────── */
.stat-row { display: grid; gap: var(--sp-3); grid-template-columns: repeat(3, 1fr);
  margin-top: var(--sp-4); }
@media (max-width: 760px) { .stat-row { grid-template-columns: 1fr; } }
.stat {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  padding: var(--sp-4); box-shadow: var(--shadow-1); position: relative; overflow: hidden;
  transition: transform var(--t-mid) var(--ease), box-shadow var(--t-mid) var(--ease), border-color var(--t-mid);
}
.stat::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--accent); opacity: 0; transition: opacity var(--t-mid) var(--ease);
}
.stat.clickable { cursor: pointer; }
.stat.clickable:hover { transform: translateY(-3px); box-shadow: var(--shadow-2); border-color: var(--border-strong); }
.stat.clickable:hover::before { opacity: 1; }
.stat .label { display: flex; align-items: center; gap: 8px; }
.stat .num {
  font-size: 40px; font-weight: 700; letter-spacing: -0.03em; margin-top: 6px;
  font-variant-numeric: tabular-nums; line-height: 1; transition: color var(--t-mid) var(--ease);
}
.stat .num.bump { animation: bump var(--t-slow) var(--ease); }
@keyframes bump { 0% { transform: scale(1); } 35% { transform: scale(1.16); color: var(--accent); } 100% { transform: scale(1); } }
.stat .hint { font-size: 12px; color: var(--muted); margin-top: 8px; }
.stat .badge {
  position: absolute; top: var(--sp-4); right: var(--sp-4);
  font-size: 18px; opacity: 0.9;
}
.stat.attn .num { color: var(--warn); }
.stat.attn::before { background: var(--warn); }

/* ── Section card frame ────────────────────────────────────────────────────── */
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
  box-shadow: var(--shadow-1); overflow: hidden;
}
.card > .head {
  padding: 15px var(--sp-4); display: flex; align-items: center; gap: 10px;
  border-bottom: 1px solid var(--border);
}
.card > .head h2 { font-size: 14px; margin: 0; font-weight: 700; letter-spacing: -0.01em; }
.card > .head .count {
  font-size: 11px; font-weight: 700; color: var(--accent); background: var(--accent-weak);
  border-radius: var(--r-pill); padding: 1px 9px; font-variant-numeric: tabular-nums;
}
.card > .head .right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.card > .body { padding: var(--sp-3) var(--sp-4) var(--sp-4); }
.card > .body.flush { padding: 0; }
.grid-2 { display: grid; gap: var(--sp-3); grid-template-columns: 1fr 1fr; margin-top: var(--sp-3); }
@media (max-width: 980px) { .grid-2 { grid-template-columns: 1fr; } }

.empty { padding: var(--sp-4); color: var(--faint); font-size: 13px; text-align: center; }
.empty .big { font-size: 26px; display: block; margin-bottom: 6px; opacity: 0.6; }

/* ── Pills / chips ─────────────────────────────────────────────────────────── */
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: var(--r-pill);
  font-size: 11px; font-weight: 700; line-height: 1.6; }
.pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.running { color: var(--accent); background: var(--accent-weak); }
.pill.suspended { color: var(--warn); background: var(--warn-weak); }
.pill.done { color: var(--ok); background: var(--ok-weak); }
.pill.failed { color: var(--bad); background: var(--bad-weak); }
.pill.resolved { color: var(--ok); background: var(--ok-weak); }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: var(--r-sm);
  font-size: 11px; font-weight: 600; border: 1px solid var(--border); background: var(--surface-2);
  color: var(--muted); font-family: var(--mono); }
.chip.accent { color: var(--accent); border-color: var(--accent-line); background: var(--accent-weak); }
.chip.gate { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); background: var(--ok-weak); }
.chip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: var(--warn-weak); }

/* ── Runs list ─────────────────────────────────────────────────────────────── */
.runs { display: flex; flex-direction: column; }
.run-row {
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px;
  padding: 12px var(--sp-4); border-bottom: 1px solid var(--border); cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.run-row:last-child { border-bottom: 0; }
.run-row:hover { background: var(--surface-2); }
.run-row.selected { background: var(--accent-weak); }
.run-row.selected .rmark { background: var(--accent); }
.run-row .rmark { width: 3px; align-self: stretch; border-radius: 2px; background: transparent;
  transition: background var(--t-fast) var(--ease); }
.run-row .rmid { min-width: 0; }
.run-row .rfeat { font-weight: 600; font-size: 13px; }
.run-row .rmeta { font-size: 11.5px; color: var(--muted); margin-top: 1px; }
.run-row .rright { text-align: right; display: flex; flex-direction: column; gap: 4px; align-items: flex-end; }
.run-row .rcost { font-size: 11px; color: var(--faint); }

/* ── Loop timeline (the headline) ──────────────────────────────────────────── */
#timeline-card .head .ctx { font-size: 12px; color: var(--muted); }
.tl-summary { display: flex; flex-wrap: wrap; gap: var(--sp-3); margin-bottom: var(--sp-3); }
.tl-stat { flex: 1 1 130px; min-width: 120px; border: 1px solid var(--border); border-radius: var(--r-md);
  padding: 10px var(--sp-3); background: var(--surface-2); }
.tl-stat .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--faint); font-weight: 700; }
.tl-stat .v { font-size: 19px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.tl-stat .v small { font-size: 12px; font-weight: 600; color: var(--muted); }

/* budget burndown bar */
.burn { height: 7px; border-radius: var(--r-pill); background: var(--border); overflow: hidden; margin-top: 8px; }
.burn > i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 60%, var(--ok)));
  width: 0; transition: width var(--t-slow) var(--ease); }
.burn.hot > i { background: linear-gradient(90deg, var(--warn), var(--bad)); }

.timeline { position: relative; padding-left: 26px; }
.timeline::before { content: ""; position: absolute; left: 9px; top: 6px; bottom: 6px; width: 2px;
  background: linear-gradient(var(--accent-line), var(--border)); border-radius: 2px; }
.tl-node { position: relative; padding: 0 0 var(--sp-3) 0; }
.tl-node:last-child { padding-bottom: 2px; }
.tl-node .knot {
  position: absolute; left: -26px; top: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: var(--surface); border: 2px solid var(--border-strong); display: flex;
  align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: var(--muted);
}
.tl-node.ok .knot { border-color: var(--ok); color: var(--ok); }
.tl-node.bad .knot { border-color: var(--bad); color: var(--bad); }
.tl-node.wait .knot { border-color: var(--warn); color: var(--warn); }
.tl-node.active .knot { border-color: var(--accent); color: var(--accent); animation: pulse 1.8s var(--ease) infinite; }
@keyframes pulse {
  0% { box-shadow: 0 0 0 0 var(--accent-weak); }
  70% { box-shadow: 0 0 0 9px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.tl-node .box {
  border: 1px solid var(--border); border-radius: var(--r-md); padding: 11px 14px; background: var(--surface);
  transition: border-color var(--t-mid) var(--ease), box-shadow var(--t-mid) var(--ease), background var(--t-mid);
}
.tl-node.active .box { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-weak); }
.tl-node .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tl-node .step { font-weight: 700; font-size: 13px; }
.tl-node .nt { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.tl-node .vbump {
  font-family: var(--mono); font-size: 11px; font-weight: 700; color: var(--accent);
  background: var(--accent-weak); border-radius: var(--r-sm); padding: 1px 8px; margin-left: auto;
}
.tl-node .row2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 9px; }
.gatebar { flex: 1 1 140px; min-width: 120px; }
.gatebar .lab { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--faint);
  font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.gatebar .track { height: 6px; border-radius: var(--r-pill); background: var(--border); overflow: hidden; }
.gatebar .track > i { display: block; height: 100%; border-radius: inherit; width: 0;
  transition: width var(--t-slow) var(--ease); }
.gatebar.pass .track > i { background: var(--ok); }
.gatebar.fail .track > i { background: var(--bad); }
.tl-node .marker { font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; gap: 5px; }
.tl-node .marker.suspend { color: var(--warn); }
.tl-node .marker.resume { color: var(--ok); }
.tl-node .fails { margin-top: 8px; font-size: 11.5px; color: var(--bad); }
.tl-node .fails ul { margin: 4px 0 0; padding-left: 16px; }
/* entrance animation when an event adds a node */
.tl-node.enter { animation: slidein var(--t-slow) var(--ease) both; }
@keyframes slidein { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* ── Approval inbox ────────────────────────────────────────────────────────── */
.approval { border: 1px solid var(--border); border-radius: var(--r-md); padding: 14px; background: var(--surface-2);
  margin-bottom: var(--sp-3); transition: border-color var(--t-mid) var(--ease); }
.approval:last-child { margin-bottom: 0; }
.approval:hover { border-color: var(--warn); }
.approval .what { font-weight: 700; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
.approval .ctx { font-size: 12px; color: var(--muted); margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px 12px; }
.approval .ctx b { color: var(--fg); font-weight: 600; }
.approval .schema { margin-top: 8px; }
.approval .schema pre { margin: 4px 0 0; padding: 9px 11px; background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--r-sm); font-family: var(--mono); font-size: 11px; overflow-x: auto; max-height: 130px; }
.approval form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 11px; }
.approval input[type=text] {
  flex: 1 1 180px; min-width: 130px; background: var(--surface); color: var(--fg);
  border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 8px 10px;
  font-family: var(--mono); font-size: 12px; transition: border-color var(--t-fast) var(--ease);
}
.approval input[type=text]:focus { border-color: var(--accent); }
.btn { background: var(--accent); color: var(--on-accent); border: 0; border-radius: var(--r-sm);
  padding: 8px 14px; font-weight: 700; font-size: 12.5px; cursor: pointer;
  transition: filter var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
.btn:hover { filter: brightness(1.07); }
.btn:active { transform: translateY(1px); }
.btn.ghost { background: var(--surface); color: var(--fg); border: 1px solid var(--border-strong); }
.btn.ghost:hover { background: var(--surface-2); filter: none; }
.btn:disabled { opacity: 0.5; cursor: default; transform: none; filter: none; }

/* ── Notifications feed (what needs you + recent activity) ───────────────────── */
.notes { display: flex; flex-direction: column; gap: 8px; }
.note-item { display: flex; align-items: flex-start; gap: 10px; padding: 9px 11px; border: 1px solid var(--border);
  border-radius: var(--r-md); background: var(--surface-2); font-size: 12.5px;
  animation: slidein var(--t-mid) var(--ease) both; }
.note-item .ico { flex: none; width: 22px; height: 22px; border-radius: 7px; display: inline-flex; align-items: center;
  justify-content: center; font-size: 12px; background: var(--surface); border: 1px solid var(--border); }
.note-item.action { border-color: var(--warn); background: var(--warn-weak); }
.note-item.action .ico { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); }
.note-item.ok .ico { color: var(--ok); }
.note-item.bad { border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.note-item.bad .ico { color: var(--bad); }
.note-item .body2 { min-width: 0; flex: 1; }
.note-item .msg { font-weight: 600; }
.note-item .msg b { color: var(--accent); font-weight: 700; }
.note-item .sub { color: var(--muted); font-size: 11.5px; margin-top: 2px; }
.note-item .when { margin-left: auto; color: var(--faint); font-size: 11px; white-space: nowrap; }

/* ── CLI bridge (copy-paste resume command — the documented write path) ───────── */
.cli { margin-top: 10px; }
.cli .lab { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--faint); font-weight: 700; margin-bottom: 4px; }
.cli .cmd { display: flex; align-items: center; gap: 8px; }
.cli code { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--r-sm); padding: 7px 10px; font-family: var(--mono); font-size: 11.5px; color: var(--fg); }
.cli .copy { flex: none; }
.cli .copy.copied { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }

/* ── Feature source path (where the file lives) ──────────────────────────────── */
.feat .fsrc { margin-top: 6px; font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
.feat .fsrc code { font-family: var(--mono); font-size: 11px; color: var(--fg); word-break: break-all; }
.feat .fsrc.builtin { color: var(--faint); }

/* ── Tape scrubber (collapsed by default — the raw, power-user inspector) ─────── */
#tape-details > summary.head { cursor: pointer; list-style: none; }
#tape-details > summary.head::-webkit-details-marker { display: none; }
#tape-details:not([open]) > summary.head { border-bottom: 0; }
#tape-details > summary.head .caret { color: var(--faint); transition: transform var(--t-fast) var(--ease); display: inline-block; }
#tape-details[open] > summary.head .caret { transform: rotate(90deg); }

.scrub-head { display: flex; align-items: center; gap: 10px; padding-bottom: var(--sp-3); flex-wrap: wrap; }
.scrub-head input[type=range] { flex: 1 1 160px; accent-color: var(--accent); }
.scrub-head .pos { font-family: var(--mono); font-size: 12px; color: var(--muted); white-space: nowrap; }
.frame { border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; }
.frame .fhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 11px 14px;
  background: var(--surface-2); border-bottom: 1px solid var(--border); }
.frame .fhead .nt { font-weight: 700; }
.frame .fhead .ts { margin-left: auto; font-size: 11px; color: var(--faint); font-family: var(--mono); }
.frame .fbody { padding: 12px 14px; display: grid; gap: 11px; }
.kv { display: grid; grid-template-columns: 92px 1fr; gap: 8px; align-items: start; }
.kv > .k { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--faint); padding-top: 3px; }
.kv pre { margin: 0; padding: 9px 11px; background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--r-sm); font-family: var(--mono); font-size: 11px; overflow-x: auto; max-height: 200px; }
.injected { display: flex; flex-wrap: wrap; gap: 6px; }
.redaction { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--warn);
  background: var(--warn-weak); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
  border-radius: var(--r-sm); padding: 7px 11px; }

/* ── Feature catalog (drawer overlay) ──────────────────────────────────────── */
.scrim { position: fixed; inset: 0; background: rgba(8, 9, 14, 0.5); opacity: 0; pointer-events: none;
  transition: opacity var(--t-mid) var(--ease); z-index: 40; }
.scrim.open { opacity: 1; pointer-events: auto; }
.drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 92vw);
  background: var(--bg); border-left: 1px solid var(--border); box-shadow: var(--shadow-2);
  transform: translateX(100%); transition: transform var(--t-mid) var(--ease); z-index: 41;
  display: flex; flex-direction: column;
}
.drawer.open { transform: none; }
.drawer .dhead { display: flex; align-items: center; gap: 10px; padding: 16px var(--sp-4);
  border-bottom: 1px solid var(--border); }
.drawer .dhead h2 { font-size: 15px; margin: 0; font-weight: 700; }
.drawer .dscroll { overflow-y: auto; padding: var(--sp-4); display: grid; gap: var(--sp-3); }
.feat { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface);
  padding: var(--sp-3); transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease); }
.feat:hover { border-color: var(--border-strong); box-shadow: var(--shadow-1); }
.feat .ftop { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.feat .fid { font-weight: 700; font-size: 14px; letter-spacing: -0.01em; }
.feat .fver { color: var(--faint); font-size: 11px; font-family: var(--mono); }
.feat .frow { margin-top: 9px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: var(--r-pill);
  font-size: 11px; font-weight: 700; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); }
.tag.accent { border-color: var(--accent-line); color: var(--accent); background: var(--accent-weak); }
.tag.gate { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); background: var(--ok-weak); }
.tag.policy { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: var(--warn-weak); }
.glabel { color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  font-weight: 700; margin: 13px 0 7px; }
.nodes { display: flex; flex-direction: column; gap: 6px; }
.node { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: var(--r-sm);
  background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; }
.node .dotk { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; }
.node.intelligence .dotk { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-weak); }
.node.orchestration .dotk { background: var(--faint); }
.node .nid { font-weight: 700; }
.node .nty { color: var(--muted); font-family: var(--mono); font-size: 11px; }
.node .ntail { margin-left: auto; display: flex; gap: 5px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.ncap { font-family: var(--mono); font-size: 10px; padding: 1px 6px; border-radius: 5px;
  background: var(--surface); border: 1px solid var(--border); color: var(--muted); }
.ncap.cap { color: var(--accent); border-color: var(--accent-line); }
.ncap.suspend { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
.edges { font-family: var(--mono); font-size: 11px; color: var(--muted); display: flex; flex-direction: column; gap: 3px; }
.edges .e .when { color: var(--warn); }
.io pre { margin: 0; padding: 9px 11px; background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--r-sm); font-family: var(--mono); font-size: 11px; overflow-x: auto; max-height: 150px; }

/* ── Toasts ────────────────────────────────────────────────────────────────── */
#toast-host { position: fixed; bottom: 18px; right: 18px; z-index: 60; display: flex;
  flex-direction: column; gap: 8px; align-items: flex-end; }
.toast { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
  padding: 11px 15px; font-size: 13px; max-width: 360px; box-shadow: var(--shadow-2);
  animation: toastin var(--t-mid) var(--ease) both; border-left: 3px solid var(--accent); }
.toast.bad { border-left-color: var(--bad); }
.toast.ok { border-left-color: var(--ok); }
@keyframes toastin { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important; }
}
`;

/** Das Body-Markup (Sektionen-Skelett). Wird von Server UND Preview identisch verwendet. */
export const DASHBOARD_BODY = `
<header class="topbar">
  <div class="topbar-in">
    <div class="brand">
      <div class="glyph" aria-hidden="true"></div>
      <div>
        <h1 id="brand-title">ELIO Studio</h1>
        <div class="sub">Outer-Loop control room · read-mostly over @elio/sdk</div>
      </div>
    </div>
    <div class="spacer"></div>
    <span id="live" class="live"><span class="dot"></span><span id="live-label">connecting…</span></span>
    <button id="theme-toggle" class="iconbtn" title="Toggle light / dark" aria-label="Toggle light or dark theme">◐</button>
  </div>
</header>

<main class="shell" data-marker="${DASHBOARD_MARKER}">
  <section class="hero" aria-label="What ELIO does">
    <div class="hero-copy">
      <span class="eyebrow">The idea in one line</span>
      <h2>Keep looping until the work is <span class="pop">good enough</span>.</h2>
      <p>You declare an <b>artifact</b> (the thing being made) and an <b>eval-gate</b> that judges it.
        ELIO re-runs the loop — draft, refine, ask a human when it must — until the artifact passes the gate.
        The run stops on <b>“output is good enough”</b>, not on “all steps ran”. This dashboard just watches it happen.</p>
    </div>
    <div class="flow" aria-hidden="true">
      <div class="b"><span class="t">Artifact</span><span class="s">the work</span></div>
      <span class="arr">→</span>
      <div class="b gate"><span class="t">Eval-gate</span><span class="s">good yet?</span></div>
      <span class="arr loop">↺</span>
      <div class="b"><span class="t">Loop</span><span class="s">if not, refine</span></div>
      <span class="arr">→</span>
      <div class="b done"><span class="t">Pass ✓</span><span class="s">gate passed</span></div>
    </div>
  </section>

  <section class="stat-row" aria-label="Overview">
    <div class="stat clickable" id="stat-active" role="button" tabindex="0">
      <span class="badge" aria-hidden="true">↻</span>
      <div class="label"><span class="eyebrow">Active runs</span></div>
      <div class="num" id="stat-active-num">0</div>
      <div class="hint" id="stat-active-hint">No loops in flight.</div>
    </div>
    <div class="stat clickable" id="stat-approvals" role="button" tabindex="0">
      <span class="badge" aria-hidden="true">✋</span>
      <div class="label"><span class="eyebrow">Approvals waiting</span></div>
      <div class="num" id="stat-approvals-num">0</div>
      <div class="hint" id="stat-approvals-hint">Nothing needs a decision.</div>
    </div>
    <div class="stat clickable" id="stat-features" role="button" tabindex="0">
      <span class="badge" aria-hidden="true">▦</span>
      <div class="label"><span class="eyebrow">Features</span></div>
      <div class="num" id="stat-features-num">0</div>
      <div class="hint">Open the catalog →</div>
    </div>
  </section>

  <section class="card" id="notifications-card" style="margin-top: var(--sp-3);" aria-label="Notifications">
    <div class="head">
      <span class="eyebrow">What needs you</span>
      <h2>Notifications</h2>
      <span class="count" id="notes-count">0</span>
    </div>
    <div class="body" id="notes-body"><div class="empty">No notifications yet.</div></div>
  </section>

  <section class="card" id="timeline-card" style="margin-top: var(--sp-3);" aria-label="Loop timeline">
    <div class="head">
      <span class="eyebrow">The loop</span>
      <h2>Loop timeline</h2>
      <div class="right"><span class="ctx" id="tl-ctx">Select a run</span></div>
    </div>
    <div class="body" id="timeline-body">
      <div class="empty"><span class="big" aria-hidden="true">↻</span>Pick a run below to watch its Outer-Loop iterations converge on the gate.</div>
    </div>
  </section>

  <div class="grid-2">
    <section class="card" id="runs-card" aria-label="Runs">
      <div class="head"><h2>Runs</h2><span class="count" id="runs-count">0</span></div>
      <div class="body flush" id="runs-body"><div class="empty">No runs yet.</div></div>
    </section>

    <section class="card" id="inbox-card" aria-label="Approval inbox">
      <div class="head"><h2>Approval inbox</h2><span class="count" id="inbox-count">0</span></div>
      <div class="body" id="inbox-body"><div class="empty"><span class="big" aria-hidden="true">✓</span>No pending approvals.</div></div>
    </section>
  </div>

  <section class="card" id="tape-card" style="margin-top: var(--sp-3);" aria-label="Tape scrubber">
    <details id="tape-details">
      <summary class="head">
        <span class="eyebrow">Advanced</span>
        <h2>Tape scrubber</h2>
        <div class="right"><span class="ctx muted mono" id="tape-run"></span><span class="caret" aria-hidden="true">▸</span></div>
      </summary>
      <div class="body" id="tape-body"><div class="empty">Select a run to scrub its loop tape frame by frame.</div></div>
    </details>
  </section>
</main>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="catalog-drawer" aria-label="Feature catalog" aria-hidden="true">
  <div class="dhead">
    <div>
      <div class="eyebrow">What is inside</div>
      <h2>Feature catalog</h2>
    </div>
    <div style="margin-left:auto"><button class="iconbtn" id="catalog-close" aria-label="Close catalog">✕</button></div>
  </div>
  <div class="dscroll" id="catalog-list"><div class="empty">Loading…</div></div>
</aside>

<div id="toast-host" aria-live="polite"></div>
`;

/**
 * Das Client-Verhalten (vanilla JS, kein Framework). Liest die API + abonniert SSE; schreibt NUR über
 * POST /api/resume. Wenn `ELIO_SAMPLE` (global) gesetzt ist (Preview-Snapshot), rendert es daraus statt
 * zu fetchen — selbe Render-Funktionen, andere Datenquelle. Inv. 2: reine Projektion, keine Engine-Logik.
 */
export const DASHBOARD_JS = `
(function () {
  "use strict";
  var SAMPLE = (typeof ELIO_SAMPLE !== "undefined") ? ELIO_SAMPLE : null;
  var STATIC = !!SAMPLE; // preview snapshot mode -> no network

  var state = {
    runs: [],
    selectedRun: null,
    tape: [],
    catalog: [],
    scrubAt: 0,
    artifactVersions: {}, // run -> latest artifact version seen via events
    activity: [], // recent live events (SSE) as human-readable notification lines (bounded)
    prevCounts: { active: null, approvals: null, features: null },
  };
  var ACTIVITY_CAP = 8;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function short(id) { return String(id == null ? "" : id).slice(0, 8); }
  function corrKey(c) { return c.run + "/" + c.branch + "/" + c.step + "#" + c.checkpoint; }

  // ── Theme toggle (persists via prefers-color-scheme override on <html>) ──────
  function applyTheme(mode) {
    var root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");
  }
  function currentTheme() { return document.documentElement.getAttribute("data-theme"); }
  el("theme-toggle").addEventListener("click", function () {
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var cur = currentTheme() || (prefersDark ? "dark" : "light");
    applyTheme(cur === "dark" ? "light" : "dark");
  });

  // ── Toasts ───────────────────────────────────────────────────────────────────
  function toast(msg, kind) {
    var host = el("toast-host");
    var t = document.createElement("div");
    t.className = "toast " + (kind || "");
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () { t.style.opacity = "0"; setTimeout(function () { t.remove(); }, 220); }, 3600);
  }

  function setLive(on, label) {
    var node = el("live");
    node.className = "live" + (on ? " on" : "");
    el("live-label").textContent = label;
  }

  // ── Stat cards ────────────────────────────────────────────────────────────────
  function setStat(numId, value, prevKey) {
    var node = el(numId);
    node.textContent = String(value);
    var prev = state.prevCounts[prevKey];
    if (prev !== null && prev !== value) {
      node.classList.remove("bump"); void node.offsetWidth; node.classList.add("bump");
    }
    state.prevCounts[prevKey] = value;
  }
  function renderStats() {
    var active = state.runs.filter(function (r) { return r.phase === "running"; }).length;
    var approvals = pendingApprovals().length;
    var features = state.catalog.length;
    setStat("stat-active-num", active, "active");
    setStat("stat-approvals-num", approvals, "approvals");
    setStat("stat-features-num", features, "features");
    el("stat-active-hint").textContent = active === 0 ? "No loops in flight."
      : active + (active === 1 ? " loop iterating." : " loops iterating.");
    el("stat-approvals-hint").textContent = approvals === 0 ? "Nothing needs a decision."
      : approvals + (approvals === 1 ? " decision waiting." : " decisions waiting.");
    var approvalsCard = el("stat-approvals");
    if (approvals > 0) approvalsCard.classList.add("attn"); else approvalsCard.classList.remove("attn");
  }

  function pendingApprovals() {
    return state.runs.filter(function (r) { return r.phase === "suspended" && r.waitingOn; });
  }

  // ── Runs list ──────────────────────────────────────────────────────────────────
  function costStr(cost) {
    if (!cost) return "—";
    var parts = [];
    if (typeof cost.usd === "number") parts.push("$" + cost.usd.toFixed(4));
    if (typeof cost.tokensIn === "number") parts.push(cost.tokensIn + "→" + (cost.tokensOut || 0) + " tok");
    return parts.length ? parts.join(" · ") : "—";
  }
  function renderRuns() {
    el("runs-count").textContent = state.runs.length;
    var host = el("runs-body");
    if (!state.runs.length) { host.innerHTML = '<div class="empty">No runs yet. Drive a feature to populate the loop.</div>'; return; }
    host.innerHTML = '<div class="runs">' + state.runs.map(function (s) {
      var run = s.correlation.run;
      var sel = run === state.selectedRun ? " selected" : "";
      var ver = s.artifact && typeof s.artifact.version === "number" ? "v" + s.artifact.version : "";
      return '<div class="run-row' + sel + '" data-run="' + esc(run) + '" role="button" tabindex="0">' +
        '<span class="rmark" aria-hidden="true"></span>' +
        '<div class="rmid">' +
          '<div class="rfeat">' + esc(s.feature) + (ver ? ' <span class="chip accent">' + esc(ver) + '</span>' : '') + '</div>' +
          '<div class="rmeta mono">' + esc(short(run)) + (s.step ? ' · ' + esc(s.step) : '') + '</div>' +
        '</div>' +
        '<div class="rright">' + phasePill(s.phase) + '<span class="rcost mono">' + esc(costStr(s.cost)) + '</span></div>' +
      '</div>';
    }).join("") + '</div>';
    bindRows(host);
  }
  function bindRows(host) {
    Array.prototype.forEach.call(host.querySelectorAll(".run-row"), function (row) {
      var run = row.getAttribute("data-run");
      row.addEventListener("click", function () { selectRun(run); });
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectRun(run); }
      });
    });
  }
  function phasePill(phase) {
    var label = phase === "done" ? "completed" : phase;
    return '<span class="pill ' + esc(phase) + '">' + esc(label) + "</span>";
  }

  // ── Loop timeline (the headline): build from the tape + live artifact versions ──
  // Pure projection (Inv. 2): each tape frame is one Outer-Loop step. We surface the artifact version,
  // the gate verdict/score (when a frame's result.output looks like a GateVerdict), the budget burndown,
  // and suspend/resume markers — exactly what the read endpoints already say. No engine logic.
  function isGateVerdict(o) {
    return o && typeof o === "object" && typeof o.passed === "boolean" &&
      (typeof o.score === "number" || Array.isArray(o.failures) || "score" in o);
  }
  function gateVerdictOf(frame) {
    var r = frame.result;
    if (!r) return null;
    if (isGateVerdict(r.output)) return r.output;
    if (r.output && isGateVerdict(r.output.verdict)) return r.output.verdict;
    return null;
  }
  function renderTimeline() {
    var body = el("timeline-body");
    var run = state.selectedRun;
    var status = run ? state.runs.find(function (r) { return r.correlation.run === run; }) : null;
    if (!run || !state.tape.length) {
      el("tl-ctx").textContent = run ? short(run) : "Select a run";
      body.innerHTML = '<div class="empty"><span class="big" aria-hidden="true">↻</span>' +
        (run ? "No iterations recorded for this run yet." :
          "Pick a run below to watch its Outer-Loop iterations converge on the gate.") + '</div>';
      return;
    }
    el("tl-ctx").innerHTML = '<span class="mono">' + esc(short(run)) + '</span>' +
      (status ? ' · ' + esc(status.feature) : '');

    var frames = state.tape;
    // Budget burndown: sum cost.usd across resolved frames; the run status carries the live total.
    var spent = (status && status.cost && typeof status.cost.usd === "number") ? status.cost.usd : sumCost(frames);
    var lastVerdict = null;
    for (var i = frames.length - 1; i >= 0; i--) { var v = gateVerdictOf(frames[i]); if (v) { lastVerdict = v; break; } }
    var version = (status && status.artifact && typeof status.artifact.version === "number")
      ? status.artifact.version : (state.artifactVersions[run] || maxVersionInFrames(frames));

    var burnPct = budgetPct(spent, status);
    var summary =
      '<div class="tl-summary">' +
        tlStat("Iterations", String(frames.length), "") +
        tlStat("Artifact", version ? "v" + version : "—", "version reached") +
        tlStat("Gate", lastVerdict ? (lastVerdict.passed ? "passed" : "open") : "—",
          lastVerdict && typeof lastVerdict.score === "number" ? "score " + lastVerdict.score.toFixed(2) : "") +
        '<div class="tl-stat"><div class="k">Budget burned</div><div class="v mono">$' + spent.toFixed(4) + '</div>' +
          '<div class="burn' + (burnPct > 75 ? ' hot' : '') + '"><i style="width:' + Math.min(100, burnPct) + '%"></i></div></div>' +
      '</div>';

    // Track artifact version as it climbs across frames so each node can show its v-bump.
    var verAt = computeVersionTrail(frames, run);
    var activeIdx = (status && status.phase !== "done") ? frames.length - 1 : -1;

    var nodes = frames.map(function (f, idx) {
      var r = f.result || {};
      var st = r.status || "?";
      var verdict = gateVerdictOf(f);
      var kls = "";
      if (st === "suspended") kls = "wait";
      else if (st === "failed") kls = "bad";
      else if (verdict) kls = verdict.passed ? "ok" : "bad";
      else if (st === "resolved") kls = "ok";
      var active = idx === activeIdx ? " active" : "";
      var knot = st === "suspended" ? "❚❚" : st === "failed" ? "!" : (idx + 1);

      var vbump = "";
      var thisVer = verAt[idx];
      if (thisVer) {
        var prevVer = idx > 0 ? verAt[idx - 1] : 0;
        vbump = '<span class="vbump">' + (prevVer && prevVer !== thisVer ? "v" + prevVer + "→" : "") + "v" + thisVer + "</span>";
      }

      var row2 = "";
      if (verdict) {
        var pct = typeof verdict.score === "number" ? Math.round(verdict.score * 100) : (verdict.passed ? 100 : 0);
        row2 += '<div class="gatebar ' + (verdict.passed ? "pass" : "fail") + '">' +
          '<div class="lab"><span>Gate</span><span class="mono">' +
            (typeof verdict.score === "number" ? verdict.score.toFixed(2) : (verdict.passed ? "pass" : "fail")) +
          '</span></div><div class="track"><i style="width:' + pct + '%"></i></div></div>';
      }
      if (st === "suspended") {
        var what = r.elicitation ? r.elicitation.what : "approval";
        row2 += '<span class="marker suspend">❚❚ suspended · ' + esc(what) + '</span>';
      }
      if (typeof r.confidence === "number") {
        row2 += '<span class="chip">conf ' + r.confidence.toFixed(2) + '</span>';
      }
      if (r.cost && typeof r.cost.usd === "number" && r.cost.usd > 0) {
        row2 += '<span class="chip mono">$' + r.cost.usd.toFixed(4) + '</span>';
      }

      var fails = (verdict && verdict.failures && verdict.failures.length)
        ? '<div class="fails">' + verdict.failures.length + ' gate issue' + (verdict.failures.length === 1 ? "" : "s") +
            '<ul>' + verdict.failures.slice(0, 4).map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul></div>'
        : "";

      return '<div class="tl-node ' + kls + active + '">' +
        '<span class="knot" aria-hidden="true">' + esc(knot) + '</span>' +
        '<div class="box">' +
          '<div class="top"><span class="step">' + esc(f.correlation.step) + '</span>' +
            '<span class="nt">' + esc(f.nodeType) + '</span>' + vbump + '</div>' +
          (row2 ? '<div class="row2">' + row2 + '</div>' : '') + fails +
        '</div></div>';
    }).join("");

    // Resume marker: if the run was suspended and is now past it (a later resolved frame), surface it.
    if (status && status.phase === "done" && frames.some(function (f) { return f.result && f.result.status === "suspended"; })) {
      nodes += '<div class="tl-node ok"><span class="knot" aria-hidden="true">✓</span>' +
        '<div class="box"><div class="top"><span class="step">resumed → completed</span>' +
        '<span class="marker resume">▶ resumed via approval</span></div></div></div>';
    }

    body.innerHTML = summary + '<div class="timeline">' + nodes + '</div>';
  }
  function tlStat(k, v, sub) {
    return '<div class="tl-stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      (sub ? ' <small>' + esc(sub) + '</small>' : '') + '</div></div>';
  }
  function sumCost(frames) {
    return frames.reduce(function (a, f) {
      return a + (f.result && f.result.cost && typeof f.result.cost.usd === "number" ? f.result.cost.usd : 0);
    }, 0);
  }
  function budgetPct(spent, status) {
    // We don't get the raw budget over the read API; show burn relative to a soft reference so the bar
    // still communicates "burning". If status carries no budget, scale against the spend itself (caps low).
    var ref = (status && status.budgetTotal) || 0.02; // soft visual reference, not engine truth
    return ref > 0 ? (spent / ref) * 100 : 0;
  }
  function maxVersionInFrames(frames) {
    var m = 0;
    frames.forEach(function (f) {
      var v = f.result && f.result.output && typeof f.result.output.version === "number" ? f.result.output.version : 0;
      if (f.result && f.result.output && f.result.output.ref && typeof f.result.output.ref.version === "number") v = f.result.output.ref.version;
      if (v > m) m = v;
    });
    return m;
  }
  function computeVersionTrail(frames, run) {
    // The version climbs whenever an artifact-mutating frame resolves. We can't always read it from the
    // frame, so we approximate: every resolved transform/append-ish frame that produced output bumps v.
    var trail = [];
    var v = 0;
    frames.forEach(function (f) {
      var r = f.result || {};
      var produced = r.status === "resolved" && r.output != null && !gateVerdictOf(f);
      if (produced) v += 1;
      trail.push(v);
    });
    // Reconcile the tail with the authoritative latest version, if known.
    var latest = state.artifactVersions[run];
    if (typeof latest === "number" && latest > 0 && trail.length) {
      var top = trail[trail.length - 1];
      if (top !== latest) {
        var d = latest - top;
        for (var i = 0; i < trail.length; i++) trail[i] = Math.max(0, trail[i] + d);
      }
    }
    return trail;
  }

  // ── Approval inbox ─────────────────────────────────────────────────────────────
  function renderInbox() {
    var pending = pendingApprovals();
    el("inbox-count").textContent = pending.length;
    var host = el("inbox-body");
    if (!pending.length) { host.innerHTML = '<div class="empty"><span class="big" aria-hidden="true">✓</span>No pending approvals.</div>'; return; }
    host.innerHTML = pending.map(function (s) {
      var e = s.waitingOn;
      var who = e.whoCanAnswer || {};
      var whoStr = who.machine ? "machine" : ((who.roles || []).concat(who.users || []).join(", ") || "human");
      var schema = e.schema ? '<div class="schema"><div class="eyebrow">Expected answer</div>' +
        '<pre>' + esc(JSON.stringify(e.schema, null, 2)) + '</pre></div>' : '';
      return '<div class="approval" data-key="' + esc(corrKey(s.correlation)) + '">' +
        '<div class="what"><span class="pill suspended">' + esc(e.mode) + '</span>' + esc(e.what) + '</div>' +
        '<div class="ctx">' +
          '<span>run <b class="mono">' + esc(short(s.correlation.run)) + '</b></span>' +
          '<span>step <b class="mono">' + esc(s.correlation.step) + '</b></span>' +
          '<span>who <b>' + esc(whoStr) + '</b></span>' +
        '</div>' + schema +
        '<form data-corr="' + esc(JSON.stringify(s.correlation)) + '">' +
          '<input type="text" name="answer" placeholder="answer (yes / no / JSON)" value="yes" aria-label="Answer" />' +
          '<button type="submit" class="btn">Approve</button>' +
          '<button type="button" class="btn ghost deny">Deny</button>' +
        '</form>' +
        '<div class="cli"><div class="lab">…or resume from the CLI</div><div class="cmd">' +
          '<code data-cmd="' + esc(resumeCmd(s.correlation)) + '">' + esc(resumeCmd(s.correlation)) + '</code>' +
          '<button type="button" class="btn ghost copy" aria-label="Copy resume command">copy</button>' +
        '</div></div>' +
      '</div>';
    }).join("");
    bindInbox(host);
  }
  function bindInbox(host) {
    Array.prototype.forEach.call(host.querySelectorAll("form"), function (form) {
      form.addEventListener("submit", function (ev) { ev.preventDefault(); submitAnswer(form, form.answer.value); });
      var deny = form.querySelector(".deny");
      if (deny) deny.addEventListener("click", function () { submitAnswer(form, "no"); });
    });
    Array.prototype.forEach.call(host.querySelectorAll(".cli .copy"), function (btn) {
      btn.addEventListener("click", function () {
        var code = btn.parentNode.querySelector("code");
        copyText(code ? code.getAttribute("data-cmd") : "", btn);
      });
    });
  }

  // ── POST /api/resume -> the ONLY write path (Inv. 2/§2) ─────────────────────────
  function submitAnswer(form, raw) {
    var correlation = JSON.parse(form.getAttribute("data-corr"));
    var answer = parseAnswer(raw);
    Array.prototype.forEach.call(form.querySelectorAll("button"), function (b) { b.disabled = true; });
    if (STATIC) { toast("Preview snapshot — resume is disabled (no server).", "bad");
      Array.prototype.forEach.call(form.querySelectorAll("button"), function (b) { b.disabled = false; }); return; }
    fetch("api/resume", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ correlation: correlation, answer: answer }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) toast("Resume failed: " + (res.j.error || "unknown"), "bad");
        else toast("Resumed " + corrKey(correlation), "ok");
        return refreshRuns();
      }).catch(function (e) { toast("Resume error: " + e, "bad"); })
      .then(function () { if (state.selectedRun) loadTape(state.selectedRun); });
  }
  function parseAnswer(raw) {
    var t = String(raw).trim(); var lower = t.toLowerCase();
    if (["y", "yes", "approve", "ok", "true"].indexOf(lower) >= 0) return { approved: true };
    if (["n", "no", "deny", "reject", "false"].indexOf(lower) >= 0) return { approved: false };
    try { return JSON.parse(t); } catch (e) { return t; }
  }

  // ── Notifications (what needs you + recent activity) ─────────────────────────
  function featureOf(run) {
    var s = state.runs.filter(function (r) { return r.correlation.run === run; })[0];
    return s ? s.feature : short(run);
  }
  function iconFor(kind) { return kind === "action" ? "✋" : kind === "ok" ? "✓" : kind === "bad" ? "✗" : "↻"; }
  function pushActivity(kind, msg, sub) {
    state.activity.unshift({ kind: kind, msg: msg, sub: sub || "" });
    if (state.activity.length > ACTIVITY_CAP) state.activity.length = ACTIVITY_CAP;
  }
  function noteForEvent(ev) {
    if (!ev || !ev.correlation) return null;
    var feat = esc(featureOf(ev.correlation.run));
    if (ev.type === "run-started") return { kind: "info", msg: "<b>" + feat + "</b> started", sub: "run " + esc(short(ev.correlation.run)) };
    if (ev.type === "run-completed") return ev.gate === "passed"
      ? { kind: "ok", msg: "<b>" + feat + "</b> passed the gate", sub: "run " + esc(short(ev.correlation.run)) }
      : { kind: "bad", msg: "<b>" + feat + "</b> stopped (gate not met)", sub: "run " + esc(short(ev.correlation.run)) };
    if (ev.type === "node-suspended") return { kind: "action", msg: "<b>" + feat + "</b> waiting for approval",
      sub: "step " + esc(ev.correlation.step) + (ev.elicitation ? " · " + esc(ev.elicitation.what) : "") };
    if (ev.type === "node-dead-lettered" || (ev.type === "node-resolved" && ev.result && ev.result.status === "failed"))
      return { kind: "bad", msg: "<b>" + feat + "</b> hit an error", sub: "step " + esc(ev.correlation.step) };
    return null;
  }
  function renderNotifications() {
    var host = el("notes-body");
    var items = [];
    // Persistent "needs you": every suspended run is an action item (mirrors the inbox, but glanceable).
    pendingApprovals().forEach(function (s) {
      items.push({ kind: "action", msg: "<b>" + esc(s.feature) + "</b> needs approval",
        sub: "step " + esc(s.correlation.step) + ((s.waitingOn && s.waitingOn.what) ? " · " + esc(s.waitingOn.what) : "") });
    });
    // Recent live activity (SSE) below the action items.
    state.activity.forEach(function (a) { items.push(a); });
    el("notes-count").textContent = items.length;
    if (!items.length) {
      host.innerHTML = '<div class="empty"><span class="big" aria-hidden="true">🔔</span>No notifications — nothing needs you right now.</div>';
      return;
    }
    host.innerHTML = '<div class="notes">' + items.slice(0, 14).map(function (n) {
      return '<div class="note-item ' + esc(n.kind) + '">' +
        '<span class="ico" aria-hidden="true">' + iconFor(n.kind) + '</span>' +
        '<div class="body2"><div class="msg">' + n.msg + '</div>' +
        (n.sub ? '<div class="sub">' + n.sub + '</div>' : '') + '</div></div>';
    }).join("") + '</div>';
  }

  // ── CLI bridge: copy-paste resume command (the documented write path; studio stays read-mostly) ──
  function resumeCmd(correlation) {
    var base = "elio resume " + corrKey(correlation) + " yes";
    // When the dashboard is served by/against a remote engine host, point the CLI at the same origin.
    return STATIC ? base : base + " --engine-url " + location.origin;
  }
  function copyText(text, btn) {
    var done = function () { btn.classList.add("copied"); btn.textContent = "copied"; setTimeout(function () { btn.classList.remove("copied"); btn.textContent = "copy"; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast("Copy failed", "bad"); });
    else { try { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); done(); } catch (e) { toast("Copy failed", "bad"); } }
  }

  // ── Tape scrubber ────────────────────────────────────────────────────────────
  function renderTape() {
    var body = el("tape-body");
    el("tape-run").textContent = state.selectedRun ? short(state.selectedRun) : "";
    if (!state.selectedRun) { body.innerHTML = '<div class="empty">Select a run to scrub its loop tape frame by frame.</div>'; return; }
    if (!state.tape.length) { body.innerHTML = '<div class="empty">No tape frames for this run yet.</div>'; return; }
    if (state.scrubAt >= state.tape.length) state.scrubAt = state.tape.length - 1;
    var n = state.tape.length;
    body.innerHTML =
      '<div class="scrub-head">' +
        '<button class="iconbtn" id="scrub-prev" aria-label="Previous frame">‹</button>' +
        '<input type="range" id="scrub-range" min="0" max="' + (n - 1) + '" value="' + state.scrubAt + '" aria-label="Tape frame" />' +
        '<button class="iconbtn" id="scrub-next" aria-label="Next frame">›</button>' +
        '<span class="pos mono">frame ' + (state.scrubAt + 1) + ' / ' + n + '</span>' +
      '</div>' +
      '<div id="frame-host"></div>';
    renderFrame();
    el("scrub-range").addEventListener("input", function (e) { state.scrubAt = Number(e.target.value); renderFrame(); updatePos(); });
    el("scrub-prev").addEventListener("click", function () { if (state.scrubAt > 0) { state.scrubAt--; syncScrub(); } });
    el("scrub-next").addEventListener("click", function () { if (state.scrubAt < n - 1) { state.scrubAt++; syncScrub(); } });
  }
  function syncScrub() { el("scrub-range").value = state.scrubAt; renderFrame(); updatePos(); }
  function updatePos() {
    var pos = document.querySelector("#tape-body .pos");
    if (pos) pos.textContent = "frame " + (state.scrubAt + 1) + " / " + state.tape.length;
  }
  function renderFrame() {
    var f = state.tape[state.scrubAt];
    var host = el("frame-host");
    if (!f) { host.innerHTML = ""; return; }
    var r = f.result || {};
    var injected = (f.injected && f.injected.length)
      ? f.injected.map(function (c) { return '<span class="chip accent">' + esc(c) + '</span>'; }).join("")
      : '<span class="faint">none</span>';
    var redaction = f.redaction
      ? '<div class="redaction" aria-label="Redaction"><span aria-hidden="true">⛨</span>' +
          'Redacted at <b>&nbsp;' + esc(f.redaction.level) + '</b>&nbsp;· fields: ' +
          esc((f.redaction.redactedFields || []).join(", ") || "—") + '</div>'
      : '';
    host.innerHTML =
      '<div class="frame">' +
        '<div class="fhead"><span class="nt">' + esc(f.nodeType) + '</span>' +
          statusPill(r.status) +
          '<span class="chip mono">step ' + esc(f.correlation.step) + '</span>' +
          '<span class="ts">' + esc(f.ts) + '</span></div>' +
        '<div class="fbody">' +
          redaction +
          '<div class="kv"><span class="k">Injected</span><div class="injected">' + injected + '</div></div>' +
          '<div class="kv"><span class="k">Input</span><pre>' + esc(JSON.stringify(f.input, null, 2)) + '</pre></div>' +
          '<div class="kv"><span class="k">Result</span><pre>' + esc(JSON.stringify(r, null, 2)) + '</pre></div>' +
        '</div>' +
      '</div>';
  }
  function statusPill(status) {
    var cls = status === "resolved" ? "resolved" : status === "suspended" ? "suspended" : status === "failed" ? "failed" : "running";
    return '<span class="pill ' + cls + '">' + esc(status || "?") + "</span>";
  }

  // ── Feature catalog (drawer) ─────────────────────────────────────────────────
  function openCatalog() {
    el("scrim").classList.add("open");
    var d = el("catalog-drawer"); d.classList.add("open"); d.setAttribute("aria-hidden", "false");
    renderCatalog();
  }
  function closeCatalog() {
    el("scrim").classList.remove("open");
    var d = el("catalog-drawer"); d.classList.remove("open"); d.setAttribute("aria-hidden", "true");
  }
  function capStr(req) {
    if (!req) return [];
    var out = [];
    if (req.models && req.models.length) out.push("models");
    if (req.db && req.db.length) out.push("db");
    if (req.fs && ((req.fs.read || []).length || (req.fs.write || []).length)) out.push("fs");
    if (req.tools && req.tools.length) out.push("tools");
    return out;
  }
  function renderNode(s) {
    var klass = s.klass || "";
    var tail = "";
    capStr(s.requests).forEach(function (c) { tail += '<span class="ncap cap">' + esc(c) + "</span>"; });
    if (s.suspend) tail += '<span class="ncap suspend">' + esc(s.suspend) + "</span>";
    if (s.when) tail += '<span class="ncap">when</span>';
    return '<div class="node ' + esc(klass) + '">' +
      '<span class="dotk" aria-hidden="true"></span>' +
      '<span class="nid">' + esc(s.id) + '</span>' +
      '<span class="nty">' + esc(s.type) + (klass ? ' · ' + esc(klass) : '') + '</span>' +
      '<span class="ntail">' + tail + '</span></div>';
  }
  function renderCatalog() {
    var host = el("catalog-list");
    if (!state.catalog.length) { host.innerHTML = '<div class="empty">No features registered.</div>'; return; }
    host.innerHTML = state.catalog.map(function (f) {
      var steps = (f.graph && f.graph.steps) || [];
      var policies = (f.policies || []).map(function (p) { return '<span class="tag policy">' + esc(p) + "</span>"; }).join("");
      var nodes = steps.length
        ? '<div class="glabel">Graph · ' + steps.length + ' step' + (steps.length === 1 ? "" : "s") + '</div>' +
          '<div class="nodes">' + steps.map(renderNode).join("") + "</div>"
        : (f.planner ? '<div class="glabel">Planner</div><div class="nodes">' +
            '<div class="node intelligence"><span class="dotk" aria-hidden="true"></span>' +
            '<span class="nid">' + esc(f.planner.node) + '</span><span class="nty">planner</span></div></div>' : "");
      var edges = (f.graph && f.graph.edges && f.graph.edges.length)
        ? '<div class="glabel">Edges</div><div class="edges">' + f.graph.edges.map(function (e) {
            return '<div class="e">' + esc(e.from) + ' → ' + esc(e.to) +
              (e.when ? ' <span class="when">when ' + esc(e.when) + '</span>' : '') + '</div>';
          }).join("") + '</div>'
        : "";
      var io = f.io
        ? '<div class="glabel">IO</div><div class="io"><pre>' + esc(JSON.stringify(f.io, null, 2)) + '</pre></div>'
        : "";
      var src = f.sourcePath
        ? '<div class="fsrc"><span aria-hidden="true">📄</span><code>' + esc(f.sourcePath) + '</code></div>'
        : '<div class="fsrc builtin"><span aria-hidden="true">📦</span>built-in (SDK)</div>';
      return '<div class="feat">' +
        '<div class="ftop"><span class="fid">' + esc(f.id) + '</span><span class="fver">v' + esc(f.version) + '</span>' +
          (f.owner ? '<span class="fver">· ' + esc(f.owner) + '</span>' : '') + '</div>' +
        src +
        '<div class="frow">' +
          '<span class="tag accent">' + esc(f.autonomy) + '</span>' +
          '<span class="tag">' + esc(f.artifact.kind) + '</span>' +
          '<span class="tag gate">gate: ' + esc(f.artifact.evalGate) + '</span>' + policies +
        '</div>' + nodes + edges + io + '</div>';
    }).join("");
  }

  // ── Selection / data loading ─────────────────────────────────────────────────
  function selectRun(run) {
    state.selectedRun = run;
    state.scrubAt = 0;
    renderRuns();
    renderTimeline();
    renderTape();
    if (!STATIC) loadTape(run);
  }

  function refreshRuns() {
    if (STATIC) { state.runs = SAMPLE.runs || []; afterRuns(); return Promise.resolve(); }
    return fetch("api/runs").then(function (r) { return r.json(); }).then(function (runs) {
      state.runs = Array.isArray(runs) ? runs : [];
      afterRuns();
    }).catch(function (e) { toast("Failed to load runs: " + e, "bad"); });
  }
  function afterRuns() {
    state.runs.forEach(function (s) {
      if (s.artifact && typeof s.artifact.version === "number") state.artifactVersions[s.correlation.run] = s.artifact.version;
    });
    renderStats(); renderRuns(); renderInbox(); renderNotifications(); renderTimeline();
  }

  function loadTape(run) {
    if (STATIC) {
      state.tape = (SAMPLE.tapes && SAMPLE.tapes[run]) || [];
      renderTimeline(); renderTape(); return Promise.resolve();
    }
    return fetch("api/runs/" + encodeURIComponent(run) + "/tape")
      .then(function (r) { return r.json(); }).then(function (frames) {
        if (run !== state.selectedRun) return;
        state.tape = Array.isArray(frames) ? frames : [];
        renderTimeline(); renderTape();
      }).catch(function (e) { toast("Failed to load tape: " + e, "bad"); });
  }

  function loadCatalog() {
    if (STATIC) { state.catalog = SAMPLE.catalog || []; renderStats(); return Promise.resolve(); }
    return fetch("api/features").then(function (r) { return r.json(); }).then(function (cat) {
      state.catalog = Array.isArray(cat) ? cat : [];
      renderStats();
    }).catch(function (e) { toast("Failed to load features: " + e, "bad"); });
  }

  // ── Live updates via SSE (new events animate in; track artifact versions) ──────
  function connectStream() {
    if (STATIC || typeof EventSource === "undefined") { setLive(false, STATIC ? "snapshot" : "polling"); return; }
    var es = new EventSource("api/stream");
    es.onopen = function () { setLive(true, "live"); };
    es.onerror = function () { setLive(false, "reconnecting…"); };
    es.onmessage = function (m) {
      try {
        var ev = JSON.parse(m.data);
        if (ev.type === "artifact-updated" && ev.artifact && ev.correlation)
          state.artifactVersions[ev.correlation.run] = ev.artifact.version;
        if (ev.type === "run-completed" && ev.artifact && ev.correlation)
          state.artifactVersions[ev.correlation.run] = ev.artifact.version;
        var note = noteForEvent(ev);
        if (note) { pushActivity(note.kind, note.msg, note.sub); renderNotifications(); }
        refreshRuns();
        if (state.selectedRun && ev.correlation && ev.correlation.run === state.selectedRun) loadTape(state.selectedRun);
        else if (!state.selectedRun && ev.correlation) selectRun(ev.correlation.run);
      } catch (e) { /* ignore malformed frame */ }
    };
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────
  function activate(node, fn) {
    node.addEventListener("click", fn);
    node.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
  }
  activate(el("stat-features"), openCatalog);
  activate(el("stat-active"), function () {
    var first = state.runs.filter(function (r) { return r.phase === "running"; })[0] || state.runs[0];
    if (first) selectRun(first.correlation.run);
  });
  activate(el("stat-approvals"), function () { el("inbox-card").scrollIntoView({ behavior: "smooth", block: "center" }); });
  el("catalog-close").addEventListener("click", closeCatalog);
  el("scrim").addEventListener("click", closeCatalog);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCatalog(); });

  // ── Boot ───────────────────────────────────────────────────────────────────────
  if (STATIC) {
    if (SAMPLE.title) { document.title = SAMPLE.title; el("brand-title").textContent = SAMPLE.title; }
    loadCatalog();
    refreshRuns();
    var initial = SAMPLE.selectedRun || (state.runs[0] && state.runs[0].correlation.run);
    if (initial) selectRun(initial);
    setLive(false, "snapshot");
  } else {
    loadCatalog();
    refreshRuns().then(function () {
      if (!state.selectedRun && state.runs.length) selectRun(state.runs[0].correlation.run);
    });
    connectStream();
    setInterval(refreshRuns, 3500); // safety-net poll (no-SSE / dropped connection)
  }
})();
`;

/** Minimaler HTML-Escape für serverseitig interpolierte Werte (title). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
