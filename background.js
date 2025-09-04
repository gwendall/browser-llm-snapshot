// Background service worker (MV3)
// - Attaches DevTools Protocol via chrome.debugger to collect metrics
// - Coordinates Start/Stop/Quick Profile

const STATE = {
  monitoring: false,
  tabId: null,
  startedAt: null,
  perfStart: null,
  perfEnd: null,
  domCountersStart: null,
  domCountersEnd: null,
  perfMetricsStart: null,
  perfMetricsEnd: null,
  samplingProfile: null,
  memAnalysis: null,
  cpuProfile: null,
  cpuAnalysis: null,
  systemInfo: null,
};

// Script/source map registry for remapping minified frames
const SCRIPT_REG = {
  byUrl: new Map(), // url -> { scriptId, url, sourceMapURL, map }
  byId: new Map(),  // scriptId -> same
  onEventBound: false,
};

function bindDebuggerEvents() {
  if (SCRIPT_REG.onEventBound) return;
  chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (method === 'Debugger.scriptParsed') {
      try { await handleScriptParsed(source, params); } catch {}
    }
  });
  SCRIPT_REG.onEventBound = true;
}

async function handleScriptParsed(_source, params) {
  const rec = { scriptId: params.scriptId, url: params.url || `script:${params.scriptId}`, sourceMapURL: params.sourceMapURL || null, map: null };
  SCRIPT_REG.byUrl.set(rec.url, rec);
  SCRIPT_REG.byId.set(rec.scriptId, rec);
  if (rec.sourceMapURL) {
    rec.map = await loadAndParseSourceMap(rec.url, rec.sourceMapURL, rec.scriptId);
  } else {
    // Try to detect inline source map via script source
    try {
      const src = await chrome.debugger.sendCommand({ tabId: STATE.tabId }, 'Debugger.getScriptSource', { scriptId: rec.scriptId });
      const code = src?.scriptSource || '';
      const m = code.match(/[#@]\s*sourceMappingURL=([^\n]+)/);
      if (m && m[1]) {
        rec.sourceMapURL = m[1].trim();
        rec.map = await loadAndParseSourceMap(rec.url, rec.sourceMapURL, rec.scriptId);
      }
    } catch {}
  }
}

async function loadAndParseSourceMap(scriptUrl, mapRef, scriptId) {
  try {
    let json;
    if (mapRef.startsWith('data:')) {
      const base64 = mapRef.split('base64,')[1];
      const text = atob(base64);
      json = JSON.parse(text);
    } else {
      const abs = new URL(mapRef, scriptUrl).toString();
      const res = await fetch(abs);
      json = await res.json();
    }
    return buildSourceMapConsumer(json);
  } catch (e) {
    return null;
  }
}

// Minimal SourceMap consumer supporting originalPositionFor(line, column)
function buildSourceMapConsumer(mapJson) {
  const sources = mapJson.sources || [];
  const names = mapJson.names || [];
  const mappings = mapJson.mappings || '';
  const sourceRoot = mapJson.sourceRoot || '';

  function decodeVLQ(str) {
    const res = [];
    let i = 0; let shift = 0; let value = 0; let continuation, digit;
    const charToInt = (c)=>{
      const code = c.charCodeAt(0);
      if (code >= 65 && code <= 90) return code - 65; // A-Z 0-25
      if (code >= 97 && code <= 122) return code - 97 + 26; // a-z 26-51
      if (code >= 48 && code <= 57) return code - 48 + 52; // 0-9 52-61
      if (c === '+') return 62; if (c === '/') return 63; return 0;
    };
    function fromVLQSigned(x){ const sign = x & 1; x >>= 1; return sign ? -x : x; }
    while (i < str.length) {
      value = 0; shift = 0;
      do {
        digit = charToInt(str[i++]);
        continuation = !!(digit & 32);
        digit &= 31;
        value += digit << shift;
        shift += 5;
      } while (continuation && i < str.length);
      res.push(fromVLQSigned(value));
      if (i < str.length && (str[i] === ',' || str[i] === ';')) break;
    }
    return { values: res, length: i };
  }

  const lines = [];
  let genLine = 0; let i = 0;
  let prevGenCol = 0, prevSrc = 0, prevSrcLine = 0, prevSrcCol = 0, prevName = 0;
  while (i < mappings.length) {
    const ch = mappings[i];
    if (ch === ';') { genLine++; i++; prevGenCol = 0; continue; }
    if (ch === ',') { i++; continue; }
    // decode a segment
    const seg1 = decodeVLQ(mappings.slice(i)); i += seg1.length; prevGenCol += seg1.values[0] || 0;
    const segment = { genLine, genCol: prevGenCol };
    if (seg1.values.length > 1) {
      prevSrc += seg1.values[1] || 0;
      prevSrcLine += seg1.values[2] || 0;
      prevSrcCol += seg1.values[3] || 0;
      segment.src = prevSrc; segment.srcLine = prevSrcLine; segment.srcCol = prevSrcCol;
      if (seg1.values.length > 4) { prevName += seg1.values[4] || 0; segment.name = prevName; }
    }
    lines[genLine] = lines[genLine] || [];
    lines[genLine].push(segment);
  }

  function originalPositionFor(line, column) { // 0-based inputs
    const segs = lines[line];
    if (!segs) return null;
    // binary search last segment with genCol <= column
    let lo = 0, hi = segs.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].genCol <= column) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx === -1) return null;
    const s = segs[idx];
    if (s.src == null) return null;
    const srcUrl = sourceRoot ? new URL(sources[s.src], sourceRoot).toString() : sources[s.src];
    const name = (s.name != null) ? names[s.name] : null;
    return { source: srcUrl, line: s.srcLine, column: s.srcCol, name };
  }

  return { originalPositionFor };
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function toMetricsMap(list) {
  const map = {};
  if (Array.isArray(list)) {
    list.forEach((m) => {
      if (m && m.name) map[m.name] = m.value;
    });
  }
  return map;
}

async function attachDebugger(tabId) {
  await chrome.debugger.attach({ tabId }, "1.3");
  // Enable relevant domains
  await chrome.debugger.sendCommand({ tabId }, "Performance.enable");
  try { await chrome.debugger.sendCommand({ tabId }, "HeapProfiler.enable"); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Memory.enable"); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Profiler.enable"); } catch {}
  try { STATE.systemInfo = await chrome.debugger.sendCommand({ tabId }, "SystemInfo.getInfo"); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Debugger.enable"); bindDebuggerEvents(); } catch {}
}

async function detachDebugger() {
  if (!STATE.tabId) return;
  try { await chrome.debugger.detach({ tabId: STATE.tabId }); } catch {}
}

function parseHeapSnapshot(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    const meta = data.snapshot?.meta;
    if (!meta) return null;
    const nodes = data.nodes || [];
    const strings = data.strings || [];
    const nodeFields = meta.node_fields || [];
    const nodeTypes = meta.node_types || [];
    const typeNames = Array.isArray(nodeTypes[0]) ? nodeTypes[0] : [];
    const idxType = nodeFields.indexOf('type');
    const idxName = nodeFields.indexOf('name');
    const idxSelf = nodeFields.indexOf('self_size');
    const fieldCount = nodeFields.length;
    const aggByCtor = new Map();
    const typeBreakdown = new Map();

    for (let i = 0; i < nodes.length; i += fieldCount) {
      const typeId = nodes[i + idxType];
      const type = typeNames[typeId] || String(typeId);
      const nameIdx = nodes[i + idxName];
      const name = strings[nameIdx] || '(unknown)';
      const self = nodes[i + idxSelf] || 0;
      const ctorKey = `${name}::${type}`;
      const prev = aggByCtor.get(ctorKey) || { name, type, count: 0, totalSelfSize: 0 };
      prev.count += 1;
      prev.totalSelfSize += self;
      aggByCtor.set(ctorKey, prev);

      const prevType = typeBreakdown.get(type) || { type, count: 0, totalSelfSize: 0 };
      prevType.count += 1;
      prevType.totalSelfSize += self;
      typeBreakdown.set(type, prevType);
    }

    const topConstructorsBySelfSize = Array.from(aggByCtor.values())
      .sort((a, b) => b.totalSelfSize - a.totalSelfSize)
      .slice(0, 25);
    const nodeTypeBreakdown = Array.from(typeBreakdown.values())
      .sort((a, b) => b.totalSelfSize - a.totalSelfSize);

    const totalNodes = nodes.length / fieldCount;
    const totalSelfSize = nodeTypeBreakdown.reduce((a, b) => a + b.totalSelfSize, 0);

    return { totalNodes, totalSelfSize, nodeTypeBreakdown, topConstructorsBySelfSize };
  } catch (e) {
    return { error: String(e) };
  }
}

async function deepSnapshot(tabId) {
  // Ensure debugger is attached and HeapProfiler enabled
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, 'HeapProfiler.enable'); } catch {}
  const chunks = [];
  let finished = false;

  function onEvent(_source, method, params) {
    if (method === 'HeapProfiler.addHeapSnapshotChunk') {
      chunks.push(params.chunk || '');
    } else if (method === 'HeapProfiler.reportHeapSnapshotProgress') {
      if (params && params.finished) finished = true;
    }
  }

  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'HeapProfiler.collectGarbage');
  } catch {}
  try {
    await chrome.debugger.sendCommand({ tabId }, 'HeapProfiler.takeHeapSnapshot', { reportProgress: true });
  } catch (e) {
    // Fallback to Memory domain sampling if HeapProfiler is unavailable
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Memory.enable');
    } catch {}
    try {
      // Start sampling allocations with max depth
      await chrome.debugger.sendCommand({ tabId }, 'Memory.startSampling', { samplingInterval: 4096, suppressRandomness: false });
      // Sample for a few seconds
      await new Promise(r => setTimeout(r, 5000));
      const prof = await chrome.debugger.sendCommand({ tabId }, 'Memory.getSamplingProfile');
      await chrome.debugger.sendCommand({ tabId }, 'Memory.stopSampling');
      return { memorySamplingProfile: prof?.profile || prof || null };
    } catch (e2) {
      return { error: `Heap snapshot not available; Memory sampling fallback failed: ${String(e2)}` };
    }
  }

  // Poll for finish
  const start = Date.now();
  while (!finished && Date.now() - start < 120000) {
    await new Promise(r => setTimeout(r, 200));
  }
  chrome.debugger.onEvent.removeListener(onEvent);

  const text = chunks.join('');
  const analysis = parseHeapSnapshot(text);
  return analysis;
}

async function snapshotStart(tabId) {
  // Performance metrics (start)
  const perf = await chrome.debugger.sendCommand({ tabId }, "Performance.getMetrics");
  STATE.perfMetricsStart = toMetricsMap(perf?.metrics);
  // DOM counters (start)
  try {
    const domCounters = await chrome.debugger.sendCommand({ tabId }, "Memory.getDOMCounters");
    STATE.domCountersStart = domCounters;
  } catch {
    STATE.domCountersStart = null;
  }
  // GC before sampling to stabilize (best-effort)
  try { await chrome.debugger.sendCommand({ tabId }, "HeapProfiler.collectGarbage"); } catch {}
  // Start heap sampling (lower interval = more detail, more overhead)
  try {
    await chrome.debugger.sendCommand({ tabId }, "HeapProfiler.startSampling", { samplingInterval: 8192 });
  } catch {}
  // Start CPU profiling (include samples)
  try { await chrome.debugger.sendCommand({ tabId }, "Profiler.setSamplingInterval", { interval: 1000 }); } catch {}
  try { await chrome.debugger.sendCommand({ tabId }, "Profiler.start", { includeSamples: true }); } catch {}
  STATE.startedAt = Date.now();
}

async function snapshotEnd(tabId) {
  // Performance metrics (end)
  const perf = await chrome.debugger.sendCommand({ tabId }, "Performance.getMetrics");
  STATE.perfMetricsEnd = toMetricsMap(perf?.metrics);
  // DOM counters (end)
  try {
    const domCounters = await chrome.debugger.sendCommand({ tabId }, "Memory.getDOMCounters");
    STATE.domCountersEnd = domCounters;
  } catch {
    STATE.domCountersEnd = null;
  }
  // Stop heap sampling and analyze
  try {
    const prof = await chrome.debugger.sendCommand({ tabId }, "HeapProfiler.stopSampling");
    STATE.samplingProfile = prof?.profile || null;
    STATE.memAnalysis = analyzeSamplingProfile(STATE.samplingProfile);
  } catch {
    STATE.samplingProfile = null;
    STATE.memAnalysis = null;
  }
  // Stop CPU profiler and analyze
  try {
    const cpu = await chrome.debugger.sendCommand({ tabId }, "Profiler.stop");
    STATE.cpuProfile = cpu?.profile || null;
    STATE.cpuAnalysis = analyzeCpuProfile(STATE.cpuProfile);
  } catch {
    STATE.cpuProfile = null;
    STATE.cpuAnalysis = null;
  }
}

async function startMonitoring() {
  if (STATE.monitoring) return { ok: true, already: true };
  const tabId = await getActiveTabId();
  if (!tabId) return { ok: false, error: "No active tab" };
  STATE.tabId = tabId;
  await attachDebugger(tabId);
  await snapshotStart(tabId);
  STATE.monitoring = true;
  // Start page-side monitoring via eval
  await evalInPage(`(window.__LLM_MONITOR__ && window.__LLM_MONITOR__.start && window.__LLM_MONITOR__.start(), true)`);
  // Open side panel for current tab if available
  try {
    const tabId = STATE.tabId;
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    await chrome.sidePanel.open({ tabId });
  } catch {}
  return { ok: true };
}

async function stopMonitoring() {
  if (!STATE.monitoring || !STATE.tabId) return { ok: true, already: true };
  const tabId = STATE.tabId;
  // Stop page-side monitoring via eval
  await evalInPage(`(window.__LLM_MONITOR__ && window.__LLM_MONITOR__.stop && window.__LLM_MONITOR__.stop(), true)`);
  await snapshotEnd(tabId);
  await detachDebugger();
  STATE.monitoring = false;
  return { ok: true };
}

async function evalInPage(expr) {
  const tabId = STATE.tabId ?? (await getActiveTabId());
  if (!tabId) return null;
  // Use scripting to run in MAIN world to access page globals safely
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (expression) => {
      try {
        // eslint-disable-next-line no-eval
        return { ok: true, value: eval(expression) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    args: [expr],
  });
  return result?.result ?? null;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  const units = ['B','KB','MB','GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length-1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function analyzeSamplingProfile(profile) {
  if (!profile || !profile.head) return null;

  const byFunc = new Map();
  const topStacks = [];

  function walk(node, path) {
    const cf = node.callFrame || {};
    const k = `${cf.functionName || '(anonymous)'} @ ${cf.url || 'unknown'}:${Number.isFinite(cf.lineNumber) ? cf.lineNumber : -1}`;
    const newPath = cf ? [...path, cf] : path;
    let subtotal = node.selfSize || 0;
    if (node.children && node.children.length) {
      for (const c of node.children) subtotal += walk(c, newPath);
    }
    if (node.selfSize && node.selfSize > 0) {
      const prev = byFunc.get(k) || { bytes: 0, samples: 0, cf };
      byFunc.set(k, { bytes: prev.bytes + node.selfSize, samples: prev.samples + 1, cf });
      topStacks.push({ bytes: subtotal, stack: newPath });
    }
    return subtotal;
  }

  walk(profile.head, []);

  const topAllocators = Array.from(byFunc.values())
    .map((v) => ({
      functionName: v.cf?.functionName || '(anonymous)',
      url: v.cf?.url || 'unknown',
      lineNumber: Number.isFinite(v.cf?.lineNumber) ? v.cf.lineNumber : -1,
      columnNumber: Number.isFinite(v.cf?.columnNumber) ? v.cf.columnNumber : -1,
      bytes: v.bytes,
      samples: v.samples,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);

  topStacks.sort((a, b) => b.bytes - a.bytes);
  const topStacksTrimmed = topStacks.slice(0, 5).map((s) => ({
    bytes: s.bytes,
    stack: s.stack.map((cf) => ({
      functionName: cf?.functionName || '(anonymous)',
      url: cf?.url || 'unknown',
      lineNumber: Number.isFinite(cf?.lineNumber) ? cf.lineNumber : -1,
      columnNumber: Number.isFinite(cf?.columnNumber) ? cf.columnNumber : -1,
    })),
  }));

  return { topAllocators, topStacks: topStacksTrimmed };
}

function analyzeCpuProfile(profile) {
  if (!profile) return null;
  const nodesById = new Map();
  (profile.nodes || []).forEach(n => nodesById.set(n.id, n));

  // Build tree children mapping if missing
  (profile.nodes || []).forEach(n => { if (!n.children) n.children = []; });

  const samples = profile.samples || [];
  const timeDeltas = profile.timeDeltas || [];
  // If timeDeltas not present, assume sampleInterval 1ms
  const defaultDelta = 1; // ms
  const selfTimeMs = new Map();

  let totalMs = 0;
  for (let i = 0; i < samples.length; i++) {
    const nodeId = samples[i];
    const dt = (timeDeltas && timeDeltas[i]) ? timeDeltas[i] / 1000 : defaultDelta;
    totalMs += dt;
    selfTimeMs.set(nodeId, (selfTimeMs.get(nodeId) || 0) + dt);
  }

  // Compute total time by summing self + children recursively
  const totalTimeMs = new Map();
  function computeTotal(nodeId) {
    if (totalTimeMs.has(nodeId)) return totalTimeMs.get(nodeId);
    const node = nodesById.get(nodeId);
    if (!node) return 0;
    let total = selfTimeMs.get(nodeId) || 0;
    const children = node.children || [];
    for (const childId of children) total += computeTotal(childId);
    totalTimeMs.set(nodeId, total);
    return total;
  }
  nodesById.forEach((_, id) => computeTotal(id));

  function entryFor(nodeId) {
    const n = nodesById.get(nodeId);
    if (!n) return null;
    const cf = n.callFrame || {};
    return {
      functionName: cf.functionName || '(anonymous)',
      url: cf.url || 'unknown',
      lineNumber: Number.isFinite(cf.lineNumber) ? cf.lineNumber : -1,
      columnNumber: Number.isFinite(cf.columnNumber) ? cf.columnNumber : -1,
      selfTimeMs: +(selfTimeMs.get(nodeId) || 0).toFixed(3),
      totalTimeMs: +(totalTimeMs.get(nodeId) || 0).toFixed(3),
      selfPct: totalMs ? +(((selfTimeMs.get(nodeId) || 0) / totalMs) * 100).toFixed(2) : null,
      totalPct: totalMs ? +(((totalTimeMs.get(nodeId) || 0) / totalMs) * 100).toFixed(2) : null,
    };
  }

  const allEntries = Array.from(nodesById.keys()).map(entryFor).filter(Boolean).map(remapEntry).filter(e => {
    const fn = e.functionName || '';
    if (fn === '(idle)' || fn === '(root)' || fn === '(program)' || fn === '(garbage collector)') return false;
    const u = e.url || '';
    if (u.startsWith('chrome-extension://')) return false;
    if (u.includes('/content/monitor.js')) return false;
    return true;
  }).map(e => ({ ...e, module: moduleFromUrl(e.url) }));
  const topSelf = [...allEntries].sort((a,b)=>b.selfTimeMs - a.selfTimeMs).slice(0, 15);
  const topTotal = [...allEntries].sort((a,b)=>b.totalTimeMs - a.totalTimeMs).slice(0, 15);
  return { topSelf, topTotal };
}

function moduleFromUrl(url) {
  if (!url) return null;
  if (url.startsWith('webpack-internal:///')) {
    const m = url.match(/node_modules\/(.*)/);
    if (m && m[1]) return `node_modules/${m[1]}`;
    const app = url.match(/\(app[^)]*\)/);
    if (app && app[0]) return app[0].slice(1, -1);
  }
  try {
    const u = new URL(url);
    return u.pathname;
  } catch { return url; }
}

function remapEntry(e) {
  const rec = SCRIPT_REG.byUrl.get(e.url);
  if (rec && rec.map && Number.isFinite(e.lineNumber) && Number.isFinite(e.columnNumber)) {
    const pos = rec.map.originalPositionFor(Math.max(0, e.lineNumber - 1), Math.max(0, e.columnNumber));
    if (pos) {
      return {
        ...e,
        url: pos.source || e.url,
        lineNumber: (pos.line != null) ? pos.line + 1 : e.lineNumber,
        columnNumber: (pos.column != null) ? pos.column : e.columnNumber,
        functionName: pos.name || e.functionName,
      };
    }
  }
  return e;
}

async function buildReport(opts = {}) {
  const tab = STATE.tabId ? await chrome.tabs.get(STATE.tabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const url = tab?.url ?? 'unknown';
  const title = tab?.title ?? 'unknown';

  // Gather page-side monitor summary
  const summaryRes = await evalInPage("(window.__LLM_MONITOR__ && window.__LLM_MONITOR__.getSummary && window.__LLM_MONITOR__.getSummary()) || null");
  const summary = summaryRes?.value ?? null;

  // Detect app context (Next.js, Three.js)
  const ctxRes = await evalInPage(`(function(){
    const ctx = {};
    ctx.hasNextData = !!window.__NEXT_DATA__;
    ctx.nextBuildId = window.__NEXT_DATA__?.buildId || null;
    ctx.nextProps = window.__NEXT_DATA__?.props ? true : false;
    ctx.threeVersion = (window.THREE && (THREE.REVISION || THREE.VERSION)) || (window.__THREE_VERSION__ || null);
    ctx.userAgent = navigator.userAgent;
    return ctx;
  })()`);
  const appCtx = ctxRes?.value ?? {};

  // Perf deltas
  const mStart = STATE.perfMetricsStart || {};
  const mEnd = STATE.perfMetricsEnd || {};
  const totalDurationMs = STATE.startedAt ? (Date.now() - STATE.startedAt) : null;

  function metric(name) {
    const startV = mStart[name];
    const endV = mEnd[name];
    return { start: startV, end: endV, delta: (Number(endV) - Number(startV)) };
  }

  const jsTask = metric('TaskDuration');
  const scriptDur = metric('ScriptDuration');
  const layoutDur = metric('LayoutDuration');
  const recalcDur = metric('RecalcStyleDuration');

  const domStart = STATE.domCountersStart || {};
  const domEnd = STATE.domCountersEnd || {};

  // Page memory sample via content (if available)
  const memLatest = summary?.memory?.slice(-1)[0] || null;

  // Build structured JSON focusing on memory usage
  let heapLatest = null;
  if (memLatest) {
    heapLatest = {
      usedBytes: memLatest.usedJSHeapSize,
      totalBytes: memLatest.totalJSHeapSize,
      jsHeapSizeLimit: memLatest.jsHeapSizeLimit,
      t: memLatest.t,
    };
  }

  let heapGrowthMBPerMin = null;
  if (summary?.memory?.length > 1) {
    const firstM = summary.memory[0];
    const lastM = summary.memory[summary.memory.length - 1];
    const deltaB = (lastM.usedJSHeapSize || 0) - (firstM.usedJSHeapSize || 0);
    const deltaT = (lastM.t || 0) - (firstM.t || 0);
    heapGrowthMBPerMin = deltaT > 0 ? ((deltaB / 1048576) / (deltaT / 60000)) : 0;
  }

  let threeLatest = null;
  let threeDelta = null;
  if (summary?.three?.length) {
    const first = summary.three[0];
    const last = summary.three[summary.three.length - 1];
    threeLatest = {
      geometries: last.memory?.geometries ?? null,
      textures: last.memory?.textures ?? null,
      drawCalls: last.render?.calls ?? null,
      triangles: last.render?.triangles ?? null,
    };
    threeDelta = {
      geometries: (last.memory?.geometries ?? 0) - (first.memory?.geometries ?? 0),
      textures: (last.memory?.textures ?? 0) - (first.memory?.textures ?? 0),
    };
  }

  const lines = [];
  lines.push(`# Frontend Runtime Performance & Memory Report`);
  lines.push('');
  lines.push(`## Hardware`);
  if (summary?.glCaps) {
    const c = summary.glCaps;
    lines.push(`- WebGL: vendor "${c.unmaskedVendor || c.vendor}", renderer "${c.unmaskedRenderer || c.renderer}", version "${c.version}"`);
    lines.push(`- GL caps: maxTextureSize ${c.maxTextureSize}, maxCubeMapSize ${c.maxCubeMapSize}, maxRenderbufferSize ${c.maxRenderbufferSize}, maxVertexAttribs ${c.maxVertexAttribs}`);
    lines.push(`- Extensions: ${Array.isArray(c.extensions) ? c.extensions.length : 'n/a'}`);
  }
  if (STATE.systemInfo?.gpu?.devices?.length) {
    const d = STATE.systemInfo.gpu.devices[0];
    lines.push(`- GPU: ${d.deviceString || 'unknown'} (${d.vendorString || ''})`);
    if (STATE.systemInfo.gpu.driverVersion) lines.push(`- GPU Driver: ${STATE.systemInfo.gpu.driverVersion}`);
  }
  if (summary?.deviceMemory != null) lines.push(`- Device memory (GB): ${summary.deviceMemory}`);
  if (summary?.hardwareConcurrency != null) lines.push(`- Logical CPU cores: ${summary.hardwareConcurrency}`);
  lines.push('');
  lines.push(`- URL: ${url}`);
  lines.push(`- Title: ${title}`);
  lines.push(`- Duration: ${totalDurationMs ? (totalDurationMs/1000).toFixed(1) : 'n/a'} s`);
  lines.push(`- User Agent: ${appCtx.userAgent}`);
  lines.push(`- Next.js: ${appCtx.hasNextData ? 'yes' : 'unknown'} (buildId: ${appCtx.nextBuildId || 'n/a'})`);
  lines.push(`- Three.js: ${appCtx.threeVersion ? 'yes' : 'no'} (version: ${appCtx.threeVersion || 'n/a'})`);
  lines.push('');

  lines.push(`## CPU Hotspots`);
  if (STATE.cpuAnalysis?.topSelf?.length) {
    lines.push('Top functions by self time:');
    STATE.cpuAnalysis.topSelf.slice(0, 10).forEach((e, i) => {
      const mod = e.module ? ` [${e.module}]` : '';
      const pct = (e.selfPct != null || e.totalPct != null) ? ` (${e.selfPct ?? 0}% self, ${e.totalPct ?? 0}% total)` : '';
      lines.push(`- ${i+1}. ${e.functionName}${mod} (${e.url}:${e.lineNumber}) — self: ${e.selfTimeMs} ms, total: ${e.totalTimeMs} ms${pct}`);
    });
    lines.push('');
    if (STATE.cpuAnalysis.topTotal?.length) {
      lines.push('Top functions by total time:');
      STATE.cpuAnalysis.topTotal.slice(0, 10).forEach((e, i) => {
        const mod = e.module ? ` [${e.module}]` : '';
        const pct = (e.selfPct != null || e.totalPct != null) ? ` (${e.selfPct ?? 0}% self, ${e.totalPct ?? 0}% total)` : '';
        lines.push(`- ${i+1}. ${e.functionName}${mod} (${e.url}:${e.lineNumber}) — total: ${e.totalTimeMs} ms, self: ${e.selfTimeMs} ms${pct}`);
      });
    }
  } else {
    lines.push('- n/a');
  }
  lines.push('');

  lines.push(`## Web Vitals / Frame`);
  if (summary?.fps) {
    const fpsAvg = summary.fps.avg ? summary.fps.avg.toFixed(1) : 'n/a';
    const p95 = summary.fps.p95FrameMs ? summary.fps.p95FrameMs.toFixed(1) : 'n/a';
    lines.push(`- FPS Avg: ${fpsAvg}, p95 frame time: ${p95} ms`);
  }
  if (summary?.fcp != null) lines.push(`- FCP: ${summary.fcp.toFixed(1)} ms`);
  if (summary?.lcp != null) lines.push(`- LCP: ${summary.lcp.toFixed(1)} ms`);
  if (summary?.cls != null) lines.push(`- CLS: ${summary.cls.toFixed(3)}`);
  if (summary?.inp != null) lines.push(`- INP (approx): ${summary.inp.toFixed(1)} ms`);
  if (summary?.webgl?.perSecond?.length) {
    const avgDraws = (summary.webgl.perSecond.reduce((a,b)=>a + (b.drawCalls||0), 0) / summary.webgl.perSecond.length) || 0;
    const avgFps = (summary.webgl.perSecond.reduce((a,b)=>a + (b.fps||0), 0) / summary.webgl.perSecond.length) || 0;
    lines.push(`- WebGL: avg draw calls/sec ${avgDraws.toFixed(0)}, avg FPS ${avgFps.toFixed(1)}`);
  }
  lines.push('');

  lines.push(`## Memory`);
  if (heapLatest) {
    lines.push(`- JS Heap: ${fmtBytes(heapLatest.usedBytes)} used / ${fmtBytes(heapLatest.totalBytes)} total`);
  }
  if (typeof heapGrowthMBPerMin === 'number') {
    lines.push(`- Heap growth rate: ${heapGrowthMBPerMin.toFixed(2)} MB/min`);
  }
  if (threeLatest) {
    lines.push(`- Three.js renderer.info: geometries ${threeLatest.geometries}, textures ${threeLatest.textures}, draw calls ${threeLatest.drawCalls}, triangles ${threeLatest.triangles}`);
    lines.push(`- Three.js delta: geometries ${threeDelta.geometries}, textures ${threeDelta.textures}`);
  }
  lines.push('');

  lines.push(`### Top Allocators (sampling)`);
  if (STATE.memAnalysis?.topAllocators?.length) {
    STATE.memAnalysis.topAllocators.map(remapEntry).forEach((item, i) => {
      lines.push(`- ${i+1}. ${item.functionName} (${item.url}:${item.lineNumber}) — ${fmtBytes(item.bytes)} (${item.samples} samples)`);
    });
  } else {
    lines.push('- n/a');
  }
  lines.push('');

  lines.push(`### Top Allocation Stacks (sampling)`);
  if (STATE.memAnalysis?.topStacks?.length) {
    STATE.memAnalysis.topStacks.forEach((s, idx) => {
      lines.push(`- Stack #${idx+1} — ${fmtBytes(s.bytes)}`);
      s.stack.map(remapEntry).forEach(fr => lines.push(`  - ${fr.functionName} (${fr.url}:${fr.lineNumber})`));
    });
  } else {
    lines.push('- n/a');
  }

  if (opts.deep && opts.deep.nodeTypeBreakdown) {
    lines.push('');
    lines.push('### Deep Heap Snapshot (aggregated)');
    lines.push(`- Total nodes: ${opts.deep.totalNodes}`);
    lines.push(`- Total self size: ${fmtBytes(opts.deep.totalSelfSize)}`);
    lines.push('- Top constructors by self size:');
    opts.deep.topConstructorsBySelfSize.slice(0, 15).forEach((c, i) => {
      lines.push(`  - ${i+1}. ${c.name} [${c.type}] — ${fmtBytes(c.totalSelfSize)} (${c.count} objects)`);
    });
  } else if (opts.deep && opts.deep.memorySamplingProfile) {
    lines.push('');
    lines.push('### Deep Snapshot Fallback: Memory.getSamplingProfile attached');
    lines.push('```json');
    lines.push(JSON.stringify(opts.deep.memorySamplingProfile, null, 2));
    lines.push('```');
  }

  return lines.join('\n');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'POPUP_START') {
      const res = await startMonitoring();
      sendResponse(res);
    } else if (msg?.type === 'POPUP_STOP') {
      const res = await stopMonitoring();
      sendResponse(res);
    } else if (msg?.type === 'POPUP_QUICK_PROFILE') {
      const res = await startMonitoring();
      if (!res.ok) return sendResponse(res);
      const durationMs = Number(msg?.durationMs) || 10000;
      setTimeout(async () => {
        await stopMonitoring();
        const report = await buildReport();
        sendResponse({ ok: true, report });
      }, durationMs);
      // Return true to keep sendResponse async alive
      return true;
    } else if (msg?.type === 'POPUP_BUILD_REPORT') {
      const report = await buildReport();
      sendResponse({ ok: true, report });
    } else if (msg?.type === 'POPUP_DEEP_SNAPSHOT') {
      try {
        const tabId = STATE.tabId ?? (await getActiveTabId());
        if (!tabId) return sendResponse({ ok: false, error: 'No active tab' });
        const analysis = await deepSnapshot(tabId);
        const report = await buildReport({ deep: analysis || {} });
        sendResponse({ ok: true, report });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    }
  })();
  return true; // asynchronous response
});

// Clicking the toolbar button opens the side panel for the active tab
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab?.id) return;
    // With default_path set, enabling per-tab is optional; ensure open on click
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    // ignore
  }
});

// Ensure behavior and default options are set when installed/started
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setOptions({ path: 'sidepanel.html' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await chrome.sidePanel.setOptions({ path: 'sidepanel.html' });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
});
