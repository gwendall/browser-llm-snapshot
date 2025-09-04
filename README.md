# LLM Perf Reporter — Frontend Runtime Profiler (Chrome MV3)

## Introduction
LLM Perf Reporter is a Chrome (MV3) extension that profiles a live web page and turns the findings into a concise Markdown report you can paste into an LLM. It attaches to the DevTools Protocol to sample CPU and memory, collect Web Vitals, and read WebGL/Three.js stats, then remaps minified frames via source maps for readable stack traces.

Why it exists:
- Share performance context with AI assistants and teammates without screenshots or manual DevTools steps.
- Speed up triage of hotspots, jank, and memory leaks in frameworks like Next.js and graphics apps using Three.js/WebGL.
- Produce repeatable, copy‑pasteable artifacts for issues and PRs, all while keeping data local to your browser.

## What It Does
- Captures CPU, memory, Web Vitals, and WebGL/Three.js stats while you naturally use a page.
- Builds an LLM‑ready Markdown report (Claude/Copilot/ChatGPT) with:
  - CPU hotspots (top by self and total time), remapped to original source via source maps when available.
  - Memory: JS heap latest + growth rate, Three.js `renderer.info` deltas, top allocators and allocation stacks (heap sampling).
  - Deep heap snapshot (constructor/type breakdown) with fallback to Memory sampling if HeapProfiler is unavailable.
  - GPU/Hardware: WebGL vendor/renderer/limits, device memory, logical cores, and GPU driver when exposed by CDP.

## Key Features
- Side Panel UI: persistent report view (no popup flicker).
- Quick 10s: one‑click 10‑second profile and report.
- Deep Snapshot: full heap snapshot aggregation; falls back to Memory sampling if needed.
- Source‑map remapping: maps minified frames to original function/file:line (requires served source maps).

## Requirements
- Chrome 114+ (Manifest V3, `chrome.sidePanel`).

## Installation (Load Unpacked)
1) In Chrome, open `chrome://extensions` and enable “Developer mode”.
2) Click “Load unpacked” and select this repository folder (the directory containing `manifest.json`).

## Usage
- Open your target page (e.g., Next.js/Three.js or any JS/WebGL site).
- Click the extension toolbar icon to open the side panel.
- Click “Quick 10s”, interact with the page, then copy the Markdown report to your LLM.
- Click “Deep Snapshot” to append a constructor/type breakdown (can take a while).

## Source Maps
- For best function names and file paths, ensure your app serves source maps:
  - Next.js dev: default OK. Next.js prod: set `productionBrowserSourceMaps: true`.
  - Maps must be accessible to the page origin (CORS). Inline and `//# sourceMappingURL=` are supported.

## Permissions
- `debugger`, `scripting`, `tabs`, `activeTab`, `storage`, `sidePanel`, plus `host_permissions: <all_urls>` to collect runtime metrics via the DevTools Protocol and inject the page‑side monitor.

## File Layout
- `manifest.json` — MV3 config.
- `background.js` — DevTools Protocol orchestration, CPU/heap sampling, source‑map remap, Markdown report builder.
- `content/monitor.js` — injected at `document_start` in MAIN world (all frames) to collect WebGL, Web Vitals, JS heap samples, Three.js `renderer.info`.
- `sidepanel.html`, `sidepanel.js` — side panel UI: Start, Stop, Quick 10s, Deep Snapshot, Refresh, Copy.
- `popup.html`, `popup.js` — lightweight popup controls (optional; side panel is primary).
- `options.html` — placeholder for future settings.
- `styles.css` — side panel styles.

## Troubleshooting
- Side panel doesn’t open: reload the extension; ensure Chrome 114+; check service worker logs via `chrome://extensions` → “Service worker”.
- HeapProfiler not found: “Deep Snapshot” falls back to Memory sampling and includes the JSON profile in the report.
- Three.js not detected: reload the page. If the app renders in a cross‑origin iframe, data may be limited.

## Privacy
- All analysis runs locally in your browser. No external network calls are made by default (source maps are fetched from the page origin when remapping).

## Packaging (Optional)
- To publish to the Chrome Web Store, zip the folder contents (with `manifest.json` at root) and follow the CWS upload flow.
