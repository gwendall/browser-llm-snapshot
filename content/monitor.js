/*
  Injected at document_start in MAIN world.
  - Hooks Three.js WebGLRenderer instantiation to expose renderer and version.
  - Observes Long Tasks via PerformanceObserver.
  - Samples performance.memory and renderer.info periodically.
*/
(function initLLMMonitor() {
  if (window.__LLM_MONITOR__) return; // idempotent

  const state = {
    running: false,
    longTasks: [],
    memory: [],
    three: [],
    webgl: { perSecond: [], totalDrawCalls: 0 },
    fps: { frames: 0, startT: 0, samples: [] },
    paint: { fcp: null },
    lcp: null,
    cls: 0,
    inp: null,
    glCaps: null,
    timers: [],
    obs: null,
    threePatched: false,
  };

  function safeNow() {
    try { return performance.now(); } catch { return Date.now(); }
  }

  // Hook THREE to capture renderer and version
  function patchThreeIfAvailable() {
    if (state.threePatched) return;
    const T = window.THREE;
    if (!T || !T.WebGLRenderer) return;
    try {
      const Original = T.WebGLRenderer;
      T.WebGLRenderer = function(...args) {
        const inst = new Original(...args);
        try {
          if (!window.__THREE_RENDERER__) window.__THREE_RENDERER__ = inst;
          if (!window.__THREE_VERSION__) window.__THREE_VERSION__ = T.REVISION || T.VERSION || null;
        } catch {}
        return inst;
      };
      // Copy prototype and static props
      T.WebGLRenderer.prototype = Original.prototype;
      Object.setPrototypeOf(T.WebGLRenderer, Original);
      state.threePatched = true;
    } catch {}
  }

  // If THREE loads later, observe for it
  const threeCheckInterval = setInterval(() => {
    if (window.THREE && window.THREE.WebGLRenderer) {
      patchThreeIfAvailable();
      clearInterval(threeCheckInterval);
    }
  }, 200);

  // Provide a Three.js devtools bridge compatible with Three's built-in hooks
  (function ensureThreeDevtoolsBridge(){
    try {
      if (window.__THREE_DEVTOOLS__) return;
      class DevToolsEventTarget extends EventTarget {
        constructor(){ super(); this._ready=false; this._backlog=[]; this.objects=new Map(); }
        addEventListener(type, listener, options){
          super.addEventListener(type, listener, options);
          if (type !== 'devtools-ready' && this._backlog.length > 0) {
            this.dispatchEvent(new CustomEvent('devtools-ready'));
          }
        }
        dispatchEvent(event){
          if (this._ready || event.type === 'devtools-ready'){
            if (event.type === 'devtools-ready'){
              this._ready = true;
              const backlog = this._backlog; this._backlog = [];
              backlog.forEach(e => super.dispatchEvent(e));
            }
            return super.dispatchEvent(event);
          } else {
            this._backlog.push(event);
            return false;
          }
        }
      }
      const devTools = new DevToolsEventTarget();
      Object.defineProperty(window, '__THREE_DEVTOOLS__', { value: devTools, configurable: false });

      const observedRenderers = [];

      function getRendererProperties(renderer){
        try {
          const parameters = renderer.getContextAttributes ? renderer.getContextAttributes() : {};
          return {
            width: renderer.domElement ? renderer.domElement.clientWidth : 0,
            height: renderer.domElement ? renderer.domElement.clientHeight : 0,
            alpha: !!parameters.alpha,
            antialias: !!parameters.antialias,
            outputColorSpace: renderer.outputColorSpace,
            toneMapping: renderer.toneMapping,
            toneMappingExposure: renderer.toneMappingExposure !== undefined ? renderer.toneMappingExposure : 1,
            shadows: renderer.shadowMap ? renderer.shadowMap.enabled : false,
            autoClear: renderer.autoClear,
            info: {
              render: { frame: renderer.info.render.frame, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, points: renderer.info.render.points, lines: renderer.info.render.lines },
              memory: { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs ? renderer.info.programs.length : 0 }
            }
          };
        } catch(e){ return null; }
      }

      function handleObserve(obj){
        if (!obj) return;
        try {
          if (!obj.uuid) obj.uuid = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random());
        } catch {}
        if (obj.isWebGLRenderer || obj.isWebGPURenderer){
          if (observedRenderers.indexOf(obj) === -1) observedRenderers.push(obj);
          // expose first renderer for sampling
          try { if (!window.__THREE_RENDERER__) window.__THREE_RENDERER__ = obj; } catch {}
          const data = { uuid: obj.uuid, type: obj.isWebGLRenderer ? 'WebGLRenderer' : 'WebGPURenderer', properties: getRendererProperties(obj) };
          devTools.dispatchEvent(new CustomEvent('renderer', { detail: data }));
        }
        if (obj.isScene){
          const data = { sceneUuid: obj.uuid };
          devTools.dispatchEvent(new CustomEvent('scene', { detail: data }));
        }
      }

      // Listen for hooks from Three.js (newer builds dispatch CustomEvents on __THREE_DEVTOOLS__)
      devTools.addEventListener('observe', (ev) => { handleObserve(ev.detail); });
      // Trigger ready when DOM is interactive/complete
      function checkReady(){
        if (document.readyState === 'interactive' || document.readyState === 'complete'){
          devTools.dispatchEvent(new CustomEvent('devtools-ready'));
        }
      }
      document.addEventListener('readystatechange', checkReady);
      checkReady();
      // Legacy: register revision if THREE global available after load
      window.addEventListener('load', () => {
        if (window.THREE && window.THREE.REVISION){
          devTools.dispatchEvent(new CustomEvent('register', { detail: { revision: window.THREE.REVISION } }));
        }
      });
    } catch (e) { /* ignore */ }
  })();

  // Long Task observer
  function startLongTaskObserver() {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
      state.obs = obs;
    } catch {}
  }

  function sampleMemory() {
    try {
      if (performance && performance.memory) {
        const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = performance.memory;
        state.memory.push({ t: safeNow(), usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit });
      }
    } catch {}
  }

  function sampleThree() {
    const r = window.__THREE_RENDERER__;
    if (r && r.info) {
      const { memory, render } = r.info;
      state.three.push({ t: safeNow(), memory: { ...memory }, render: { ...render } });
    }
  }

  // FPS and WebGL draw call sampling
  let rafOrig = window.requestAnimationFrame;
  let rafHandle;
  let lastFrameT = null;
  let frameCountThisSecond = 0;
  let drawCallsThisSecond = 0;

  function wrapRAF() {
    if (!rafOrig) rafOrig = window.requestAnimationFrame;
    const wrapped = function(cb) {
      return rafOrig(function(t) {
        try {
          if (lastFrameT != null) {
            const dt = t - lastFrameT;
            state.fps.samples.push(dt);
          } else {
            state.fps.startT = t;
          }
          lastFrameT = t;
          frameCountThisSecond++;
        } catch {}
        cb(t);
      });
    };
    window.requestAnimationFrame = wrapped;
  }

  function unwrapRAF() {
    if (rafOrig) window.requestAnimationFrame = rafOrig;
    lastFrameT = null;
  }

  function avg(array) {
    if (!array.length) return 0;
    return array.reduce((a,b)=>a+b,0) / array.length;
  }

  // WebGL draw call counting by wrapping drawArrays/drawElements on any created context
  function wrapWebGL(ctx) {
    try {
      const origDA = ctx.drawArrays;
      const origDE = ctx.drawElements;
      ctx.drawArrays = function(...args) {
        try { state.webgl.totalDrawCalls++; drawCallsThisSecond++; } catch {}
        return origDA.apply(this, args);
      };
      ctx.drawElements = function(...args) {
        try { state.webgl.totalDrawCalls++; drawCallsThisSecond++; } catch {}
        return origDE.apply(this, args);
      };
      if (!state.glCaps) {
        // Capture caps once
        const isWebGL2 = (typeof WebGL2RenderingContext !== 'undefined') && (ctx instanceof WebGL2RenderingContext);
        const gl = ctx;
        const extDebug = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
        function gp(p) { try { return gl.getParameter(p); } catch { return null; } }
        state.glCaps = {
          webgl2: !!isWebGL2,
          vendor: gp(gl.VENDOR),
          renderer: gp(gl.RENDERER),
          version: gp(gl.VERSION),
          shadingLanguageVersion: gp(gl.SHADING_LANGUAGE_VERSION),
          unmaskedVendor: extDebug ? gp(extDebug.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: extDebug ? gp(extDebug.UNMASKED_RENDERER_WEBGL) : null,
          maxTextureSize: gp(gl.MAX_TEXTURE_SIZE),
          maxCubeMapSize: gp(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
          maxRenderbufferSize: gp(gl.MAX_RENDERBUFFER_SIZE),
          maxVertexAttribs: gp(gl.MAX_VERTEX_ATTRIBS),
          extensions: gl.getSupportedExtensions ? gl.getSupportedExtensions() : null,
        };
      }
    } catch {}
  }

  const origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
    const ctx = origGetContext.call(this, type, attrs);
    if (ctx && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl')) {
      wrapWebGL(ctx);
    }
    return ctx;
  };

  // Perf Observers: longtask, paint (FCP), LCP, CLS, INP approx
  function startPerfObservers() {
    try {
      const ltObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        }
      });
      ltObs.observe({ entryTypes: ['longtask'] });
      state.obs = ltObs;
    } catch {}

    try {
      const paintObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name === 'first-contentful-paint' && !state.paint.fcp) state.paint.fcp = e.startTime;
        }
      });
      paintObs.observe({ type: 'paint', buffered: true });
    } catch {}

    try {
      const lcpObs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) state.lcp = last.startTime;
      });
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}

    try {
      const clsObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) state.cls += e.value || 0;
        }
      });
      clsObs.observe({ type: 'layout-shift', buffered: true });
    } catch {}

    try {
      const inpObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const duration = e.processingEnd ? (e.processingEnd - e.startTime) : (e.duration || 0);
          if (!state.inp || duration > state.inp) state.inp = duration;
        }
      });
      // Event Timing entries
      inpObs.observe({ type: 'event', buffered: true, durationThreshold: 0 });
    } catch {}
  }

  function startOneSecondAggregator() {
    function tick() {
      const fps = frameCountThisSecond;
      const draws = drawCallsThisSecond;
      state.webgl.perSecond.push({ t: safeNow(), fps, drawCalls: draws });
      frameCountThisSecond = 0;
      drawCallsThisSecond = 0;
    }
    state.timers.push(setInterval(tick, 1000));
  }

  function startSampling() {
    state.timers.push(setInterval(sampleMemory, 1000));
    state.timers.push(setInterval(sampleThree, 1000));
    startOneSecondAggregator();
    wrapRAF();
    startPerfObservers();
  }

  function stopSampling() {
    state.timers.forEach((id) => clearInterval(id));
    state.timers = [];
    unwrapRAF();
  }

  window.__LLM_MONITOR__ = {
    start() {
      if (state.running) return;
      state.running = true;
      startLongTaskObserver();
      startSampling();
    },
    stop() {
      if (!state.running) return;
      state.running = false;
      stopSampling();
      try { state.obs && state.obs.disconnect(); } catch {}
    },
    getSummary() {
      // Compute FPS stats from frame intervals (dt ms); fps = 1000/dt
      const dts = state.fps.samples.slice(-120);
      const fpsVals = dts.map(dt => dt > 0 ? 1000 / dt : 0);
      const fpsAvg = fpsVals.length ? (fpsVals.reduce((a,b)=>a+b,0)/fpsVals.length) : null;
      const sorted = [...dts].sort((a,b)=>a-b);
      const p95Dt = sorted.length ? sorted[Math.floor(sorted.length*0.95) - 1] || sorted[sorted.length-1] : null;

      return {
        longTasks: state.longTasks,
        memory: state.memory,
        three: state.three,
        webgl: state.webgl,
        fps: { avg: fpsAvg, p95FrameMs: p95Dt },
        fcp: state.paint.fcp,
        lcp: state.lcp,
        cls: state.cls,
        inp: state.inp,
        glCaps: state.glCaps,
        deviceMemory: navigator.deviceMemory || null,
        hardwareConcurrency: navigator.hardwareConcurrency || null,
      };
    },
  };

  // Note: MAIN world cannot use extension APIs. Background will invoke
  // __LLM_MONITOR__.start/stop via chrome.scripting.executeScript.
})();
