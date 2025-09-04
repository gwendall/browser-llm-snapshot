browser-llm-snapshot — Frontend Runtime Profiler (Chrome MV3)

What it does
- Captures CPU, memory, Web Vitals, WebGL/Three.js stats while you naturally use a page.
- Builds a Markdown report designed for LLMs (Claude/Copilot/ChatGPT) with:
  - CPU hotspots (top by self and total time), demapped to original source via source maps when available.
  - Memory: JS heap latest + growth rate, Three.js renderer.info deltas, top allocators and allocation stacks (heap sampling).
  - Deep heap snapshot (constructors/type breakdown) or Memory sampling fallback.
  - GPU/Hardware: WebGL caps (vendor/renderer/limits), device memory, logical cores, and GPU driver when exposed by CDP.

Key features
- Side Panel UI: persistent report view (no popup flicker).
- Quick 10s: one‑click profile window and report.
- Deep Snapshot: full heap snapshot aggregation (falls back to Memory sampling when HeapProfiler is unavailable).
- Source‑map remapping: maps minified frames to original function/file:line (requires source maps to be served).

Permissions
- `debugger`, `scripting`, `tabs`, `activeTab`, `storage`, `sidePanel`, `host_permissions: <all_urls>` to collect runtime metrics via DevTools Protocol and to inject the page‑side monitor.

File layout
- `manifest.json` — MV3 config.
- `background.js` — DevTools Protocol orchestration, CPU/heap sampling, source‑map remap, Markdown report.
- `content/monitor.js` — injected at `document_start` in MAIN world (all frames):
  - WebGL draw‑call/FPS sampling, Web Vitals, JS heap samples, Three.js bridge (`__THREE_DEVTOOLS__`) and `renderer.info` capture.
- `sidepanel.html/js` — UI buttons: Start, Stop, Quick 10s, Deep Snapshot, Refresh, Copy.
- `options.html` — placeholder for future local code server.
- `styles.css` — side panel styling.

Install (Load Unpacked)
1) Chrome → `chrome://extensions` → enable “Developer mode”.
2) Click “Load unpacked” and select `tools/llm-perf-extension`.

Use
- Open your target page (Next.js/Three.js or any site with WebGL/JS).
- Click the extension icon to open the side panel.
- Click “Quick 10s” and interact with the page; copy Markdown to your LLM.
- Click “Deep Snapshot” to append a heap constructor breakdown (can take seconds).

Source map remapping
- For best function names and file paths, ensure your build serves source maps:
  - Next.js dev: default OK. Next.js prod: set `productionBrowserSourceMaps: true`.
  - Ensure maps are accessible (CORS) to the page origin; inline or `//# sourceMappingURL=` are supported.

Troubleshooting
- Side panel doesn’t open: reload extension; ensure Chrome 114+; check service worker console via `chrome://extensions` → “Service worker”.
- HeapProfiler not found: “Deep Snapshot” falls back to Memory sampling and includes the JSON profile in the report.
- Three.js not detected: reload the page; we inject at `document_start` in MAIN world and all frames. If the app renders in a cross‑origin iframe, data may be limited.

Privacy
- All analysis runs locally in your browser. No network calls are made by default (source maps are fetched from the page origin when remapping).

Export to a new public repo
Option A — with GitHub CLI (fast):
```
gh repo create browser-llm-snapshot --public --source tools/llm-perf-extension --remote=origin --push
```

Option B — with plain git:
```
mkdir /tmp/browser-llm-snapshot
rsync -a tools/llm-perf-extension/ /tmp/browser-llm-snapshot/
cd /tmp/browser-llm-snapshot
git init -b main
git add .
git commit -m "chore: init browser-llm-snapshot"
git remote add origin git@github.com:<YOUR_GH_USERNAME>/browser-llm-snapshot.git
git push -u origin main
```

Packaging (optional)
- To publish to the Chrome Web Store, zip the folder contents (manifest at root) and follow the CWS upload flow.

