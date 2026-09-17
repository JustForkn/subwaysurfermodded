// ==UserScript==
// @name         Subway Surfers Mod Menu — JustForkn
// @namespace    modmenu.local
// @version      2.1
// @description  Unity WebGL mod menu for justforkn.github.io/subwaysurfermodded
// @match        https://justforkn.github.io/subwaysurfermodded/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
/*
 * HOW TO USE (pick ONE — no game files are touched either way):
 *
 * A) Tampermonkey/Violentmonkey (recommended, works every time automatically)
 *    1. Install the "Tampermonkey" extension from the Chrome Web Store (works fine
 *       on a Chromebook — it's just a Chrome extension).
 *    2. Click the Tampermonkey icon -> "Create a new script" -> delete the template
 *       -> paste this entire file -> Save (Ctrl+S).
 *    3. Open/reload the game page. The mod menu button will appear automatically.
 *
 * B) DevTools console (zero installs, one-time per page load)
 *    1. Open the game page. While it's still on the loading screen (before it
 *       finishes loading), open DevTools (F12 or Ctrl+Shift+J on Chromebook).
 *    2. Paste this entire file into the Console tab and press Enter.
 *    3. The mod menu button appears. You'll need to repaste after every refresh.
 *    (Pasting AFTER the game has fully loaded still works for the movement/visual
 *    tools, but the memory scanner has a better chance of finding the live game
 *    memory if you paste before/while it's loading.)
 */
(function () {
    "use strict";

    if (window.__mmCleanup) {
        try { window.__mmCleanup(); } catch (e) {}
    }
    window.__mmInstalled = true;

    // ============================================================
    // 1. MEMORY ACQUISITION — Unity WebGL / this site
    //    Your page loads UnityLoader.2019.2.js and exposes the live
    //    Unity instance as window.unityGame. The original script only
    //    searched a few generic shapes, so this version hooks the exact
    //    loader path and also checks Emscripten heap views.
    // ============================================================

    var state = {
        memory: null,
        memorySource: null,
        watchType: "int32",
        results: [],
        frozen: {},
        freezeTimer: null,
        panelOpen: false,
        wizardStep: 0,
        unityReady: false,
        coinAddr: null,
        coinValue: null,
        coinConfidence: 0,
        coinCandidates: new Map(),
        coinScanActive: false,
        coinScanTimer: null,
        coinLastCandidateCount: 0,
        coinAutoStarted: false
    };

    function setMemory(mem, source) {
        try {
            if (!mem || !mem.buffer) return false;
            if (!state.memory || mem.buffer.byteLength >= state.memory.buffer.byteLength) {
                state.memory = mem;
                state.memorySource = source;
                log("Memory linked via " + source + " (" + (mem.buffer.byteLength / 1e6).toFixed(1) + " MB)");
                updateStatusDot();
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function captureModule(mod, source) {
        if (!mod) return false;

        try {
            if (mod.wasmMemory && mod.wasmMemory.buffer) {
                state.unityReady = true;
                return setMemory(mod.wasmMemory, source + " → wasmMemory");
            }

            if (mod.asm && mod.asm.memory && mod.asm.memory.buffer) {
                state.unityReady = true;
                return setMemory(mod.asm.memory, source + " → asm.memory");
            }

            if (mod.HEAP32 && mod.HEAP32.buffer) {
                state.unityReady = true;
                var heapMem = {
                    get buffer() { return mod.HEAP32 && mod.HEAP32.buffer ? mod.HEAP32.buffer : null; }
                };
                return setMemory(heapMem, source + " → HEAP32");
            }

            // Emscripten may expose typed heap views even when the Memory
            // object itself is not directly exposed.
            var heap = mod.HEAP8 || mod.HEAPU8 || mod.HEAP32 || mod.HEAPU32 || mod.HEAPF32;
            if (heap && heap.buffer) {
                state.unityReady = true;

                var heapOwner = mod;
                var memoryView = {
                    get buffer() {
                        var h = heapOwner.HEAP8 || heapOwner.HEAPU8 || heapOwner.HEAP32 ||
                                heapOwner.HEAPU32 || heapOwner.HEAPF32;
                        return h ? h.buffer : null;
                    }
                };

                if (memoryView.buffer) return setMemory(memoryView, source + " → Emscripten heap");
            }
        } catch (e) {}

        return false;
    }

    function captureUnityGame() {
        var ok = false;

        try {
            if (window.unityGame && window.unityGame.Module) {
                ok = captureModule(window.unityGame.Module, "window.unityGame.Module") || ok;
            }
        } catch (e) {}

        try {
            if (window.Module) {
                ok = captureModule(window.Module, "window.Module") || ok;
            }
        } catch (e) {}

        try {
            if (window.my4399UnityModule && typeof window.my4399UnityModule === "object") {
                ok = captureModule(window.my4399UnityModule, "my4399UnityModule") || ok;
            }
        } catch (e) {}

        return ok;
    }

    // Hook the exact UnityLoader.instantiate() call used by this repo.
    // unity.js calls:
    //   window.unityGame = window.UnityLoader.instantiate("game", ..., { Module: ... })
    function hookUnityLoader() {
        try {
            var loader = window.UnityLoader;
            if (!loader || typeof loader.instantiate !== "function" || loader.__mmPatched) return false;

            var originalInstantiate = loader.instantiate;

            loader.instantiate = function (container, url, options) {
                options = options || {};
                options.Module = options.Module || {};

                var module = options.Module;
                var previousRuntimeInit = module.onRuntimeInitialized;

                module.onRuntimeInitialized = function () {
                    captureModule(module, "UnityLoader Module");
                    setTimeout(captureUnityGame, 0);
                    if (typeof previousRuntimeInit === "function") {
                        return previousRuntimeInit.apply(this, arguments);
                    }
                };

                var game = originalInstantiate.apply(this, arguments);

                setTimeout(function () {
                    try {
                        if (game && game.Module) captureModule(game.Module, "UnityLoader result");
                    } catch (e) {}
                    captureUnityGame();
                    updateStatusDot();
                }, 0);

                return game;
            };

            loader.__mmPatched = true;
            log("UnityLoader hook installed");
            return true;
        } catch (e) {
            return false;
        }
    }

    // Keep checking while the asynchronously-loaded Unity files appear.
    var unityPolls = 0;
    var unityScan = setInterval(function () {
        hookUnityLoader();
        captureUnityGame();
        if (state.memory || ++unityPolls > 600) clearInterval(unityScan);
    }, 100);

    hookUnityLoader();
    captureUnityGame();

    // ============================================================
    // 2. MEMORY HELPERS
    // ============================================================

    function getView() {
        captureUnityGame();
        if (!state.memory || !state.memory.buffer) return null;

        try {
            return state.watchType === "float32"
                ? new Float32Array(state.memory.buffer)
                : new Int32Array(state.memory.buffer);
        } catch (e) {
            return null;
        }
    }

    function readAt(addr) {
        var v = getView();
        if (!v || addr < 0 || (addr % 4) !== 0 || addr / 4 >= v.length) return null;
        return v[addr / 4];
    }

    function writeAt(addr, value) {
        var v = getView();
        if (!v || addr < 0 || (addr % 4) !== 0 || addr / 4 >= v.length) return false;

        var n = state.watchType === "float32" ? parseFloat(value) : parseInt(value, 10);
        if (!Number.isFinite(n)) return false;

        v[addr / 4] = state.watchType === "float32" ? n : (n | 0);
        return true;
    }

    // ============================================================
    // AUTOMATIC COIN-ID FINDER
    // No manual value entry is required. We look for a small integer
    // counter in Unity memory, then promote addresses that repeatedly
    // increment by a coin-sized amount while remaining stable otherwise.
    // ============================================================

    function findLikelySavedCoinValue() {
        var keys = [];
        try {
            for (var i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
            keys.sort(function(a, b) {
                return (/coin|currency|money/i.test(b || '') ? 1 : 0) - (/coin|currency|money/i.test(a || '') ? 1 : 0);
            });
            for (var j = 0; j < keys.length; j++) {
                var k = keys[j];
                if (!k || !/coin|currency|money/i.test(k)) continue;
                var raw = localStorage.getItem(k);
                if (raw == null) continue;
                var n = Number(String(raw).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
                if (Number.isInteger(n) && n >= 0 && n <= 10000000) return n;
            }
        } catch (e) {}
        return null;
    }

    function setCoinAddress(addr, value, confidence, reason) {
        if (addr == null || !Number.isFinite(value)) return;
        state.coinAddr = addr | 0;
        state.coinValue = value | 0;
        state.coinConfidence = confidence || state.coinConfidence || 1;
        state.results = [{ addr: state.coinAddr, value: state.coinValue, coin: true }];
        var idBox = document.getElementById("mm-coin-id");
        var valBox = document.getElementById("mm-coin-live");
        var status = document.getElementById("mm-coin-status");
        if (idBox) idBox.textContent = "0x" + state.coinAddr.toString(16);
        if (valBox) valBox.textContent = String(state.coinValue);
        if (status) status.textContent = "🟢 Coin ID locked (" + (reason || "auto-detected") + ")";
        renderResults();
        log("Automatic coin ID: 0x" + state.coinAddr.toString(16) + " = " + state.coinValue);
    }

    function autoCoinPrime() {
        if (state.coinAutoStarted) return;
        var view = getView();
        if (!view) return;
        state.coinAutoStarted = true;
        var saved = findLikelySavedCoinValue();
        state.coinCandidates.clear();
        state.coinScanActive = true;

        var index = 0;
        var total = view.length;
        var chunk = 120000;
        function process() {
            if (!state.memory || !state.memory.buffer) { state.coinScanActive = false; return; }
            try { view = getView(); total = view.length; } catch (e) { state.coinScanActive = false; return; }
            var end = Math.min(index + chunk, total);
            for (; index < end; index++) {
                var v = view[index];
                if (v < 0 || v > 10000000) continue;
                if (saved !== null && v !== saved) continue;
                var addr = index * 4;
                state.coinCandidates.set(addr, { value: v, plusOne: 0, changes: 0, stable: 0, lastChange: 0 });
                if (state.coinCandidates.size >= 30000) { index = total; break; }
            }
            if (index < total) {
                state.coinLastCandidateCount = state.coinCandidates.size;
                setTimeout(process, 0);
                return;
            }
            state.coinScanActive = false;
            // A stale/unrelated localStorage coin-like value should never lock the finder to zero matches.
            if (!state.coinCandidates.size && saved !== null) {
                log("Saved-value hint had no memory matches; retrying automatic scan without the hint.");
                state.coinAutoStarted = false;
                setTimeout(autoCoinPrime, 0);
                return;
            }
            state.coinLastCandidateCount = state.coinCandidates.size;
            log("Auto coin finder watching " + state.coinCandidates.size + " candidate addresses" + (saved !== null ? " for saved value " + saved : ""));
            beginCoinTracking();
        }
        process();
    }


    function coinLiveRefresh() {
        if (state.coinAddr == null) return;
        var current = readAt(state.coinAddr);
        if (Number.isInteger(current)) {
            state.coinValue = current;
            var valBox = document.getElementById("mm-coin-live");
            if (valBox) valBox.textContent = String(current);
            var row = state.results.find(function(r){ return r.addr === state.coinAddr; });
            if (row) row.value = current;
        }
    }
    var coinLiveTimer = setInterval(coinLiveRefresh, 250);

    function beginCoinTracking() {
        if (state.coinScanTimer) clearInterval(state.coinScanTimer);
        state.coinScanTimer = setInterval(function() {
            var view = getView();
            if (!view || !state.coinCandidates.size || state.coinAddr != null) return;
            var best = null;
            state.coinCandidates.forEach(function(c, addr) {
                var idx = addr / 4;
                if (idx < 0 || idx >= view.length) return;
                var cur = view[idx];
                if (!Number.isInteger(cur) || cur < 0 || cur > 10000000) return;
                if (cur === c.value) {
                    c.stable++;
                    return;
                }
                var delta = cur - c.value;
                c.changes++;
                c.lastChange = Date.now();
                if (delta === 1 || delta === 2 || delta === 3) c.plusOne++;
                c.value = cur;
                if (c.plusOne >= 2 && c.changes >= 2) {
                    var score = c.plusOne * 20 + Math.min(c.stable, 50);
                    if (!best || score > best.score) best = { addr: addr, value: cur, score: score, confidence: c.plusOne };
                }
            });
            if (best) {
                setCoinAddress(best.addr, best.value, best.confidence, "automatic change tracking");
                state.coinCandidates.clear();
                return;
            }
            var st = document.getElementById("mm-coin-status");
            if (st) st.textContent = "🟡 Watching " + state.coinCandidates.size + " possible counters — coin ID will lock automatically";
        }, 750);
    }

    function autoCoinTick() {
        if (!state.memory || state.coinAddr != null || state.coinScanActive) return;
        autoCoinPrime();
    }

    function scanNew(targetValue) {
        var view = getView();
        if (!view) { log("No memory yet — let the game finish loading, or reload with the menu active from the start."); return; }
        var target = state.watchType === "float32" ? parseFloat(targetValue) : parseInt(targetValue, 10);
        if (isNaN(target)) { log("Enter a valid number first."); return; }
        var eps = state.watchType === "float32" ? 0.001 : 0;
        var found = [];
        for (var i = 0; i < view.length; i++) {
            var v = view[i];
            if (state.watchType === "float32" ? Math.abs(v - target) < eps : v === target) {
                found.push({ addr: i * 4, value: v });
                if (found.length > 5000) break;
            }
        }
        state.results = found;
        log("New scan: " + found.length + " matches for " + target);
        renderResults();
        switchTab("scan");
    }

    function scanNext(mode, cmpValue) {
        var view = getView();
        if (!view || !state.results.length) return;
        var target = cmpValue !== undefined && cmpValue !== "" ? (state.watchType === "float32" ? parseFloat(cmpValue) : parseInt(cmpValue, 10)) : null;
        var next = [];
        state.results.forEach(function (r) {
            var cur = view[r.addr / 4];
            var ok = false;
            if (mode === "exact") ok = target !== null && cur === target;
            else if (mode === "changed") ok = cur !== r.value;
            else if (mode === "unchanged") ok = cur === r.value;
            else if (mode === "increased") ok = cur > r.value;
            else if (mode === "decreased") ok = cur < r.value;
            else if (mode === "greater") ok = target !== null && cur > target;
            else if (mode === "less") ok = target !== null && cur < target;
            if (ok) next.push({ addr: r.addr, value: cur });
        });
        state.results = next;
        log(mode + " scan: " + next.length + " remain");
        renderResults();
    }

    function toggleFreeze(addr, value) {
        if (state.frozen.hasOwnProperty(addr)) delete state.frozen[addr];
        else { state.frozen[addr] = value; ensureFreezeLoop(); }
        renderResults();
    }
    function freezeAllShown(value) {
        state.results.slice(0, 200).forEach(function (r) {
            state.frozen[r.addr] = value !== undefined ? value : r.value;
        });
        ensureFreezeLoop();
        renderResults();
        log("Froze " + Math.min(state.results.length, 200) + " addresses" + (value !== undefined ? " = " + value : ""));
    }
    function unfreezeAll() {
        state.frozen = {};
        renderResults();
        log("Unfroze all");
    }
    function ensureFreezeLoop() {
        if (state.freezeTimer) return;
        state.freezeTimer = setInterval(function () {
            for (var addr in state.frozen) if (state.frozen.hasOwnProperty(addr)) writeAt(Number(addr), state.frozen[addr]);
        }, 100);
    }

    // ============================================================
    // 3. UI — Liquid Glass
    // ============================================================

    var ACCENTS = { violet: "#8b5cf6", blue: "#3b82f6", pink: "#ec4899", green: "#10b981", amber: "#f59e0b" };
    var accent = ACCENTS.violet;
    var blurAmt = 22;

    var css = document.createElement("style");
    css.textContent = `
    #mm-host{position:fixed;inset:0;z-index:2147483647;pointer-events:none;isolation:isolate;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
    #mm-host *{box-sizing:border-box;}
    #mm-fab{position:absolute;bottom:18px;right:18px;z-index:2;pointer-events:auto;touch-action:manipulation;width:52px;height:52px;border-radius:50%;
      background:linear-gradient(145deg, rgba(255,255,255,.35), rgba(255,255,255,.08));
      backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);
      border:1px solid rgba(255,255,255,.4);box-shadow:0 6px 22px rgba(0,0,0,.35), inset 0 1px 1px rgba(255,255,255,.6);
      cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;color:#fff;
      transition:transform .15s ease;}
    #mm-fab:hover{transform:scale(1.08);}
    #mm-fab .dot{position:absolute;top:4px;right:4px;width:10px;height:10px;border-radius:50%;background:#6b7280;
      border:2px solid rgba(0,0,0,.3);}
    #mm-fab .dot.on{background:#22c55e;}

    #mm-panel{position:absolute;top:18px;right:18px;width:308px;z-index:3;display:none;pointer-events:auto;user-select:none;
      font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f3f4f6;
      border-radius:20px;overflow:hidden;
      background:linear-gradient(160deg, rgba(255,255,255,.16), rgba(255,255,255,.04));
      backdrop-filter:blur(var(--mm-blur,22px)) saturate(180%);-webkit-backdrop-filter:blur(var(--mm-blur,22px)) saturate(180%);
      border:1px solid rgba(255,255,255,.28);
      box-shadow:0 12px 40px rgba(0,0,0,.4), inset 0 1px 1px rgba(255,255,255,.35);}
    #mm-panel::before{content:"";position:absolute;top:0;left:0;right:0;height:60px;pointer-events:none;
      background:linear-gradient(180deg, rgba(255,255,255,.25), rgba(255,255,255,0));}
    #mm-head{position:relative;padding:12px 14px 10px;cursor:move;display:flex;align-items:center;justify-content:space-between;}
    #mm-head b{font-size:13px;letter-spacing:.2px;}
    #mm-head .mm-x{cursor:pointer;opacity:.75;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;
      justify-content:center;background:rgba(255,255,255,.12);}
    #mm-head .mm-x:hover{opacity:1;background:rgba(255,255,255,.22);}
    #mm-panel button,#mm-panel input,#mm-panel select,#mm-panel label,#mm-panel .mm-swatch{position:relative;z-index:10;pointer-events:auto;}
    #mm-panel input[type=text]{user-select:text;-webkit-user-select:text;}

    #mm-tabs{position:relative;display:flex;gap:4px;padding:0 10px 10px;}
    #mm-tabs button{flex:1;padding:6px 0;border:none;border-radius:10px;background:rgba(255,255,255,.08);
      color:#e5e7eb;font-size:10.5px;font-weight:600;cursor:pointer;transition:background .15s;}
    #mm-tabs button.active{background:var(--mm-accent);color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);}
    #mm-tabs button:hover:not(.active){background:rgba(255,255,255,.16);}

    #mm-body{position:relative;padding:2px 14px 14px;max-height:64vh;overflow-y:auto;}
    #mm-body::-webkit-scrollbar{width:6px;}
    #mm-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.25);border-radius:3px;}

    .mm-tabpane{display:none;}
    .mm-tabpane.active{display:block;}

    .mm-row{display:flex;gap:6px;margin-bottom:8px;align-items:center;flex-wrap:wrap;}
    .mm-row.tight{gap:4px;}
    .mm-label{font-size:10.5px;color:#c7c9d1;min-width:64px;}

    #mm-panel input[type=text],#mm-panel select{background:rgba(255,255,255,.1);color:#fff;
      border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:5px 7px;font-size:11.5px;outline:none;}
    #mm-panel input[type=text]{width:84px;}
    #mm-panel input[type=text]:focus,#mm-panel select:focus{border-color:var(--mm-accent);}
    #mm-panel input[type=range]{width:100%;accent-color:var(--mm-accent);}

    #mm-panel button.mm-btn{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.18);
      border-radius:9px;padding:6px 9px;cursor:pointer;font-size:10.5px;font-weight:600;transition:background .12s;}
    #mm-panel button.mm-btn:hover{background:rgba(255,255,255,.2);}
    #mm-panel button.mm-primary{background:var(--mm-accent);border-color:transparent;}
    #mm-panel button.mm-primary:hover{filter:brightness(1.12);}
    #mm-panel button.mm-active{background:#16a34a;border-color:transparent;}
    #mm-panel button.mm-danger{background:rgba(239,68,68,.75);border-color:transparent;}

    #mm-results{max-height:170px;overflow-y:auto;border:1px solid rgba(255,255,255,.14);border-radius:10px;margin:6px 0;}
    .mm-item{display:flex;justify-content:space-between;align-items:center;gap:4px;padding:5px 7px;
      border-bottom:1px solid rgba(255,255,255,.08);font-size:10.5px;}
    .mm-item:last-child{border-bottom:none;}
    .mm-item input{width:58px !important;padding:3px 5px !important;font-size:10px !important;}
    .mm-item button{padding:3px 6px !important;font-size:9.5px !important;}

    .mm-count{font-size:10px;color:#c7c9d1;margin:2px 0 6px;}
    .mm-hint{font-size:10px;color:#c7c9d1;opacity:.85;margin-top:4px;line-height:1.5;}
    .mm-swatch{width:20px;height:20px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,.5);}
    .mm-swatch.active{outline:2px solid #fff;}
    #mm-log{font-size:10px;color:#d1d5db;white-space:pre-wrap;max-height:220px;overflow-y:auto;}
    .mm-status{font-size:10px;color:#c7c9d1;margin-bottom:8px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.06);}
    .mm-fly-active{outline:3px solid #22c55e !important;}
    `;
    document.documentElement.style.setProperty("--mm-accent", accent);
    document.documentElement.style.setProperty("--mm-blur", blurAmt + "px");

    var host = document.createElement("div");
    host.id = "mm-host";

    var fab = document.createElement("div");
    fab.id = "mm-fab";
    fab.innerHTML = '✨<div class="dot" id="mm-dot"></div>';

    var panel = document.createElement("div");
    panel.id = "mm-panel";
    panel.innerHTML = `
      <div id="mm-head"><b>🧊 Mod Menu</b><div class="mm-x" id="mm-close">✕</div></div>
      <div id="mm-tabs">
        <button data-tab="scan" class="active">Scan</button>
        <button data-tab="cheats">Cheats</button>
        <button data-tab="move">Move</button>
        <button data-tab="settings">Set</button>
        <button data-tab="log">Log</button>
      </div>
      <div id="mm-body">

        <div class="mm-tabpane active" data-pane="scan">
          <div class="mm-status" id="mm-mem-status">Waiting for Unity WebGL memory…</div>
          <div class="mm-status" id="mm-coin-status">🟡 Automatic coin finder is waiting for Unity memory…</div>
          <div class="mm-row tight">
            <span class="mm-label">Coin ID</span><b id="mm-coin-id" style="font-size:11px">—</b><span class="mm-label" style="min-width:auto">Value</span><b id="mm-coin-live" style="font-size:11px">—</b>
          </div>
          <div class="mm-row tight">
            <select id="mm-type"><option value="int32">Int32 (coins/ints)</option><option value="float32">Float32 (pos/speed)</option></select>
            <input type="text" id="mm-value" placeholder="value">
            <button class="mm-btn mm-primary" id="mm-scan-new">New Scan</button>
          </div>
          <div class="mm-row tight">
            <button class="mm-btn" id="mm-f-changed">Changed</button>
            <button class="mm-btn" id="mm-f-unchanged">Unchanged</button>
            <button class="mm-btn" id="mm-f-inc">Increased</button>
            <button class="mm-btn" id="mm-f-dec">Decreased</button>
          </div>
          <div class="mm-row tight">
            <input type="text" id="mm-cmp" placeholder="compare #" style="width:70px">
            <button class="mm-btn" id="mm-f-exact">= exact</button>
            <button class="mm-btn" id="mm-f-gt">&gt; greater</button>
            <button class="mm-btn" id="mm-f-lt">&lt; less</button>
          </div>
          <div class="mm-count" id="mm-count">0 results</div>
          <div id="mm-results"></div>
          <div class="mm-row tight">
            <button class="mm-btn" id="mm-freeze-all">Freeze all shown</button>
            <button class="mm-btn" id="mm-unfreeze-all">Unfreeze all</button>
            <button class="mm-btn mm-danger" id="mm-clear">Clear</button>
          </div>
        </div>

        <div class="mm-tabpane" data-pane="cheats">
          <div class="mm-hint" style="margin-bottom:8px">Guided finder: walks you through locating a stat (like coins) step by step instead of hunting manually.</div>
          <div class="mm-row tight">
            <input type="text" id="mm-wizard-val" placeholder="current value">
            <button class="mm-btn mm-primary" id="mm-wizard-start">Start finder</button>
          </div>
          <div class="mm-row tight" id="mm-wizard-actions" style="display:none">
            <button class="mm-btn" id="mm-w-inc">Went up ↑</button>
            <button class="mm-btn" id="mm-w-dec">Went down ↓</button>
            <button class="mm-btn" id="mm-w-changed">Changed</button>
            <button class="mm-btn mm-danger" id="mm-w-reset">Reset</button>
          </div>
          <div class="mm-hint" id="mm-wizard-status"></div>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,.15);margin:10px 0">
          <div class="mm-label" style="margin-bottom:6px">Set ALL frozen values to:</div>
          <div class="mm-row tight">
            <button class="mm-btn" data-preset="0">0</button>
            <button class="mm-btn" data-preset="9999">9,999</button>
            <button class="mm-btn" data-preset="999999">999,999</button>
            <button class="mm-btn mm-primary" data-preset="999999999">999,999,999</button>
          </div>
          <div class="mm-row tight">
            <input type="text" id="mm-custom-preset" placeholder="custom #">
            <button class="mm-btn" id="mm-apply-custom">Apply to frozen</button>
          </div>
          <hr style="border:none;border-top:1px solid rgba(255,255,255,.15);margin:10px 0">
          <div class="mm-label" style="margin-bottom:6px">Export / import found addresses</div>
          <div class="mm-row tight">
            <button class="mm-btn" id="mm-export">Copy as JSON</button>
            <button class="mm-btn" id="mm-import">Paste JSON</button>
          </div>
        </div>

        <div class="mm-tabpane" data-pane="move">
          <div class="mm-row"><label class="mm-label" style="min-width:auto"><input type="checkbox" id="mm-fly"> Fly (arrow keys, Shift=up, Ctrl=down)</label></div>
          <div class="mm-row tight"><span class="mm-label">Fly speed</span><input type="range" id="mm-fly-speed" min="4" max="60" value="20"></div>
          <div class="mm-row"><label class="mm-label" style="min-width:auto"><input type="checkbox" id="mm-noclip"> "No-clip" (see-through view)</label></div>
          <div class="mm-row tight"><span class="mm-label">Opacity</span><input type="range" id="mm-noclip-op" min="10" max="100" value="50"></div>
          <div class="mm-row"><label class="mm-label" style="min-width:auto"><input type="checkbox" id="mm-slowmo"> Slow-mo rendering</label></div>
          <div class="mm-row tight"><span class="mm-label">Slow speed</span><input type="range" id="mm-slowmo-speed" min="10" max="90" value="50"></div>
          <div class="mm-row"><label class="mm-label" style="min-width:auto"><input type="checkbox" id="mm-speedboost"> Speed-boost (experimental, may look choppy)</label></div>
          <div class="mm-row tight"><button class="mm-btn" id="mm-reset-view">Reset view</button></div>
        </div>

        <div class="mm-tabpane" data-pane="settings">
          <div class="mm-label" style="margin-bottom:6px">Accent color</div>
          <div class="mm-row tight" id="mm-swatches"></div>
          <div class="mm-row tight" style="margin-top:10px"><span class="mm-label">Glass blur</span><input type="range" id="mm-blur" min="4" max="40" value="22"></div>
          <div class="mm-row tight"><button class="mm-btn" id="mm-reset-pos">Reset panel position</button></div>
          <div class="mm-hint">Shortcut: press <b>,</b> to show/hide the menu anytime.</div>
        </div>

        <div class="mm-tabpane" data-pane="log">
          <div id="mm-log"></div>
        </div>

      </div>
    `;

    function log(msg) {
        var l = document.getElementById("mm-log");
        var line = new Date().toLocaleTimeString() + "  " + msg;
        if (l) l.textContent = line + "\n" + l.textContent;
        else console.log("[ModMenu]", msg);
    }

    function updateStatusDot() {
        var dot = document.getElementById("mm-dot");
        if (dot) dot.classList.toggle("on", !!state.memory);
        var status = document.getElementById("mm-mem-status");
        if (status) {
            var canvas = findCanvas();
            if (state.memory) {
                status.textContent = "✅ Unity linked (" + state.memorySource + ", " +
                    (state.memory.buffer.byteLength / 1e6).toFixed(1) + " MB" +
                    (canvas ? ", canvas found" : ", waiting for canvas") + ")";
                autoCoinTick();
            } else {
                status.textContent = state.unityReady
                    ? "🟡 Unity found, waiting for live memory…"
                    : "⏳ Waiting for Unity WebGL to initialize…";
            }
        }
    }

    function renderResults() {
        var box = document.getElementById("mm-results");
        var count = document.getElementById("mm-count");
        if (!box) return;
        box.innerHTML = "";
        var shown = state.results.slice(0, 60);
        shown.forEach(function (r) {
            var frozen = state.frozen.hasOwnProperty(r.addr);
            var row = document.createElement("div");
            row.className = "mm-item";
            row.innerHTML =
                '<span>' + (r.coin ? '🪙 ' : '') + '0x' + r.addr.toString(16) + ' = <b>' + r.value + '</b></span>' +
                '<span><input type="text" class="mm-setval" value="' + r.value + '">' +
                '<button class="mm-btn mm-set">Set</button>' +
                '<button class="mm-btn mm-freeze ' + (frozen ? "mm-active" : "") + '">' + (frozen ? "❄" : "Freeze") + '</button></span>';
            row.querySelector(".mm-set").onclick = function () {
                var v = row.querySelector(".mm-setval").value;
                writeAt(r.addr, v);
                log("Set 0x" + r.addr.toString(16) + " = " + v);
            };
            row.querySelector(".mm-freeze").onclick = function () {
                var v = row.querySelector(".mm-setval").value;
                toggleFreeze(r.addr, state.watchType === "float32" ? parseFloat(v) : parseInt(v, 10));
            };
            box.appendChild(row);
        });
        if (count) count.textContent = state.results.length + " result" + (state.results.length === 1 ? "" : "s") + (state.results.length > 60 ? " (showing 60)" : "");
    }

    function switchTab(name) {
        panel.querySelectorAll("#mm-tabs button").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === name); });
        panel.querySelectorAll(".mm-tabpane").forEach(function (p) { p.classList.toggle("active", p.dataset.pane === name); });
    }

    // --- movement / visual tools ---
    function findCanvas() {
        return document.querySelector('canvas[id="#canvas"], #game-container canvas, canvas#canvas, canvas');
    }
    var flyState = { x: 0, y: 0, active: false, speed: 20 };
    function flyKeyHandler(e) {
        if (!flyState.active) return;
        var step = flyState.speed;
        if (e.key === "ArrowUp") flyState.y -= step;
        if (e.key === "ArrowDown") flyState.y += step;
        if (e.key === "ArrowLeft") flyState.x -= step;
        if (e.key === "ArrowRight") flyState.x += step;
        if (e.shiftKey) flyState.y -= step;
        if (e.ctrlKey) flyState.y += step;
        var c = findCanvas();
        if (c) { c.style.transform = "translate(" + flyState.x + "px," + flyState.y + "px)"; c.classList.add("mm-fly-active"); }
    }
    function resetView() {
        var c = findCanvas();
        if (c) { c.style.transform = ""; c.style.opacity = "1"; c.classList.remove("mm-fly-active"); }
        flyState.x = 0; flyState.y = 0;
    }

    var slowmoActive = false, slowmoDelay = 16, speedBoostActive = false;
    var origRAF = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function (cb) {
        if (speedBoostActive) { origRAF(cb); return origRAF(cb); } // schedule twice: rough frame-doubling
        if (slowmoActive) return origRAF(function (t) { setTimeout(function () { cb(t); }, slowmoDelay); });
        return origRAF(cb);
    };

    // --- guided coin/stat finder wizard ---
    function wizardStart(val) {
        scanNew(val);
        state.wizardStep = 1;
        document.getElementById("mm-wizard-actions").style.display = "flex";
        document.getElementById("mm-wizard-status").textContent =
            "Found " + state.results.length + " matches. Now go do something in-game that changes this stat (collect/spend), then tap the button that matches what happened.";
    }
    function wizardStep(mode) {
        scanNext(mode);
        document.getElementById("mm-wizard-status").textContent =
            state.results.length <= 5
                ? "Down to " + state.results.length + " candidate(s) — check the Scan tab to freeze/set it."
                : state.results.length + " candidates left — repeat: change the stat again, tap another button.";
    }

    // ============================================================
    // 4. MOUNT + WIRE EVENTS
    // ============================================================

    function mount() {
        document.head.appendChild(css);
        host.appendChild(fab);
        host.appendChild(panel);
        document.documentElement.appendChild(host);

        function stopMenuEvent(e) {
            if (e && e.stopImmediatePropagation) e.stopImmediatePropagation();
            if (e && e.stopPropagation) e.stopPropagation();
        }
        ["pointerdown","pointerup","click","dblclick","mousedown","mouseup","touchstart","touchend","wheel","contextmenu"].forEach(function(type){
            host.addEventListener(type, stopMenuEvent, false);
        });
        host.addEventListener("keydown", function(e){
            if (e.target && host.contains(e.target)) stopMenuEvent(e);
        }, false);

        fab.onclick = function (e) { stopMenuEvent(e); state.panelOpen = !state.panelOpen; panel.style.display = state.panelOpen ? "block" : "none"; };
        document.getElementById("mm-close").onclick = function (e) { stopMenuEvent(e); state.panelOpen = false; panel.style.display = "none"; };
        document.addEventListener("keydown", function (e) {
            var t = e.target;
            var typing = t && (
                t.tagName === "INPUT" ||
                t.tagName === "TEXTAREA" ||
                t.tagName === "SELECT" ||
                t.isContentEditable
            );

            if (!typing && e.key === ",") {
                e.preventDefault();
                state.panelOpen = !state.panelOpen;
                panel.style.display = state.panelOpen ? "block" : "none";
            }
        });

        panel.querySelectorAll("#mm-tabs button").forEach(function (b) { b.onclick = function (e) { stopMenuEvent(e); switchTab(b.dataset.tab); }; });

        document.getElementById("mm-type").onchange = function (e) { state.watchType = e.target.value; };
        document.getElementById("mm-scan-new").onclick = function () { scanNew(document.getElementById("mm-value").value); };
        document.getElementById("mm-f-changed").onclick = function () { scanNext("changed"); };
        document.getElementById("mm-f-unchanged").onclick = function () { scanNext("unchanged"); };
        document.getElementById("mm-f-inc").onclick = function () { scanNext("increased"); };
        document.getElementById("mm-f-dec").onclick = function () { scanNext("decreased"); };
        document.getElementById("mm-f-exact").onclick = function () { scanNext("exact", document.getElementById("mm-cmp").value); };
        document.getElementById("mm-f-gt").onclick = function () { scanNext("greater", document.getElementById("mm-cmp").value); };
        document.getElementById("mm-f-lt").onclick = function () { scanNext("less", document.getElementById("mm-cmp").value); };
        document.getElementById("mm-freeze-all").onclick = function () { freezeAllShown(); };
        document.getElementById("mm-unfreeze-all").onclick = function () { unfreezeAll(); };
        document.getElementById("mm-clear").onclick = function () { state.results = []; renderResults(); log("Cleared results"); };

        document.getElementById("mm-wizard-start").onclick = function () { wizardStart(document.getElementById("mm-wizard-val").value); };
        document.getElementById("mm-w-inc").onclick = function () { wizardStep("increased"); };
        document.getElementById("mm-w-dec").onclick = function () { wizardStep("decreased"); };
        document.getElementById("mm-w-changed").onclick = function () { wizardStep("changed"); };
        document.getElementById("mm-w-reset").onclick = function () {
            state.results = []; state.wizardStep = 0;
            document.getElementById("mm-wizard-actions").style.display = "none";
            document.getElementById("mm-wizard-status").textContent = "";
        };
        panel.querySelectorAll("[data-preset]").forEach(function (b) {
            b.onclick = function () { freezeAllShown(parseFloat(b.dataset.preset)); Object.keys(state.frozen).forEach(function(a){state.frozen[a]=parseFloat(b.dataset.preset);}); };
        });
        document.getElementById("mm-apply-custom").onclick = function () {
            var v = parseFloat(document.getElementById("mm-custom-preset").value);
            if (isNaN(v)) return;
            Object.keys(state.frozen).forEach(function (a) { state.frozen[a] = v; });
            log("Applied " + v + " to all frozen addresses");
        };
        document.getElementById("mm-export").onclick = function () {
            var data = JSON.stringify(state.results);
            navigator.clipboard && navigator.clipboard.writeText(data);
            log("Copied " + state.results.length + " addresses to clipboard");
        };
        document.getElementById("mm-import").onclick = function () {
            navigator.clipboard && navigator.clipboard.readText().then(function (text) {
                try { state.results = JSON.parse(text); renderResults(); log("Imported " + state.results.length + " addresses"); }
                catch (e) { log("Clipboard didn't contain valid address JSON"); }
            });
        };

        document.getElementById("mm-fly").onchange = function (e) {
            flyState.active = e.target.checked;
            if (flyState.active) { document.addEventListener("keydown", flyKeyHandler); log("Fly ON"); }
            else { document.removeEventListener("keydown", flyKeyHandler); resetView(); log("Fly OFF"); }
        };
        document.getElementById("mm-fly-speed").oninput = function (e) { flyState.speed = parseInt(e.target.value, 10); };
        document.getElementById("mm-noclip").onchange = function (e) {
            var c = findCanvas(); if (c) c.style.opacity = e.target.checked ? (document.getElementById("mm-noclip-op").value / 100) : "1";
        };
        document.getElementById("mm-noclip-op").oninput = function (e) {
            if (document.getElementById("mm-noclip").checked) { var c = findCanvas(); if (c) c.style.opacity = e.target.value / 100; }
        };
        document.getElementById("mm-slowmo").onchange = function (e) { slowmoActive = e.target.checked; log("Slow-mo " + (slowmoActive ? "ON" : "OFF")); };
        document.getElementById("mm-slowmo-speed").oninput = function (e) { slowmoDelay = parseInt(e.target.value, 10); };
        document.getElementById("mm-speedboost").onchange = function (e) { speedBoostActive = e.target.checked; log("Speed-boost " + (speedBoostActive ? "ON" : "OFF")); };
        document.getElementById("mm-reset-view").onclick = resetView;

        Object.keys(ACCENTS).forEach(function (name) {
            var sw = document.createElement("div");
            sw.className = "mm-swatch" + (ACCENTS[name] === accent ? " active" : "");
            sw.style.background = ACCENTS[name];
            sw.onclick = function () {
                accent = ACCENTS[name];
                document.documentElement.style.setProperty("--mm-accent", accent);
                panel.querySelectorAll(".mm-swatch").forEach(function (s) { s.classList.remove("active"); });
                sw.classList.add("active");
            };
            document.getElementById("mm-swatches").appendChild(sw);
        });
        document.getElementById("mm-blur").oninput = function (e) {
            document.documentElement.style.setProperty("--mm-blur", e.target.value + "px");
        };
        document.getElementById("mm-reset-pos").onclick = function () {
            panel.style.top = "18px"; panel.style.right = "18px"; panel.style.left = "auto";
        };

        // drag
        var dragging = false, offX = 0, offY = 0;
        var head = document.getElementById("mm-head");
        head.addEventListener("mousedown", function (e) { dragging = true; offX = e.clientX - panel.offsetLeft; offY = e.clientY - panel.offsetTop; });
        document.addEventListener("mousemove", function (e) {
            if (!dragging) return;
            panel.style.left = (e.clientX - offX) + "px"; panel.style.top = (e.clientY - offY) + "px"; panel.style.right = "auto";
        });
        document.addEventListener("mouseup", function () { dragging = false; });

        updateStatusDot();
        log("JustForkn Unity mod menu ready. Watching for the live Unity WebGL module.");
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
    else mount();
})();
