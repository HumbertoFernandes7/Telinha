/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// O codigo do Worker da "copia na hora" (core/captureCopy.ts), como texto: roda num Worker de blob: (ou data:, se o CSP
// recusar), sem import. JavaScript puro de proposito (o esbuild do Vencord nao passa por aqui).
//
// Protocolo (main → worker):
//   { op: "init", methods: ["webgpu", "canvas2d"] }  → { type: "ready", method, adapter } ou { type: "failed", error }
//   { op: "run", readable, writable }                 → transfere o readable do MediaStreamTrackProcessor (fonte) e o
//                                                       writable do MediaStreamTrackGenerator (o que vai para os envios)
//   { op: "refresh" }                                 → reenvia o ultimo quadro copiado (um espectador novo)
//   { op: "stats" }                                   → { type: "stats", ... } (contadores acumulados)
//   { op: "stop" }                                    → solta tudo e fecha o writable
// Worker → main, alem das respostas: { type: "warn", message } (uma vez por problema) e { type: "ended", error? }.
//
// Por quadro: le da fonte, copia na placa de video para uma textura nossa, fecha o original na hora e escreve a copia
// no gerador com o MESMO timestamp. Nada volta para o processador. Contrapressao: no WebGPU com MAX_INFLIGHT copias
// ainda na fila da placa, ou o gerador sem espaco, o quadro novo e descartado (o processador ja guarda so o mais novo,
// maxBufferSize 1): nada fica enfileirado. A copia falhando: o quadro original segue (o comportamento de antes), e
// depois de FAIL_LIMIT falhas seguidas a copia desliga e o resto passa direto. st.written conta o que o gerador aceitou.
export const COPY_WORKER_SOURCE = String.raw`"use strict";
var MAX_INFLIGHT = 3;
var FAIL_LIMIT = 30;
var SLOW_MS = 2.5, SLOW_SAMPLE = 120, slowChecked = false, allowed = [];
var method = null, device = null, canvas = null, gctx = null, c2d = null, pipeline = null, sampler = null, layout = null;
var reader = null, writer = null, stopped = false, passthrough = false, fails = 0, inflight = 0;
var last = null, lastAt = 0;
var st = { frames: 0, copied: 0, passed: 0, written: 0, dropped: 0, dropGpu: 0, dropWrite: 0, refreshed: 0, copyMs: 0, copyMax: 0, gpuMs: 0, gpuN: 0, gpuMax: 0, gpuLate: 0, width: 0, height: 0 };
var warned = {};
function post(type, data) { var m = data || {}; m.type = type; self.postMessage(m); }
function describe(e) { return e && e.name ? e.name + ": " + e.message : String(e); }
function warnOnce(key, message) { if (warned[key]) return; warned[key] = true; post("warn", { message: message }); }
var WGSL = "@group(0) @binding(0) var s: sampler;\n@group(0) @binding(1) var t: texture_external;\n"
  + "struct V { @builtin(position) p: vec4f, @location(0) uv: vec2f };\n"
  + "@vertex fn vs(@builtin(vertex_index) i: u32) -> V { var xy = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));"
  + " var o: V; o.p = vec4f(xy[i], 0.0, 1.0); o.uv = vec2f((xy[i].x + 1.0) * 0.5, (1.0 - xy[i].y) * 0.5); return o; }\n"
  + "@fragment fn fs(v: V) -> @location(0) vec4f { return textureSampleBaseClampToEdge(t, s, v.uv); }\n";

async function initWebGpu() {
  if (!self.navigator || !navigator.gpu) throw new Error("sem WebGPU");
  var adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("sem adaptador WebGPU");
  device = await adapter.requestDevice();
  device.lost.then(function (info) {
    if (stopped) return;
    device = null;
    inflight = 0;
    if (c2dReady()) { method = "canvas2d"; warnOnce("lost", "WebGPU perdeu a placa de vídeo (" + (info && info.message || "sem motivo") + "): a cópia continua pelo canvas 2D"); }
    else { passthrough = true; warnOnce("lost", "WebGPU perdeu a placa de vídeo (" + (info && info.message || "sem motivo") + "): a cópia na hora desligou e a captura segue direto"); }
  });
  canvas = new OffscreenCanvas(16, 16);
  gctx = canvas.getContext("webgpu");
  if (!gctx) throw new Error("sem contexto webgpu no OffscreenCanvas");
  var format = navigator.gpu.getPreferredCanvasFormat();
  gctx.configure({ device: device, format: format, alphaMode: "opaque", usage: 0x10 });
  var module = device.createShaderModule({ code: WGSL });
  pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module: module, entryPoint: "vs" }, fragment: { module: module, entryPoint: "fs", targets: [{ format: format }] }, primitive: { topology: "triangle-list" } });
  layout = pipeline.getBindGroupLayout(0);
  sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
  var info = adapter.info || {};
  return [info.vendor, info.architecture, info.description].filter(Boolean).join(" ") || "?";
}
function c2dReady() {
  if (c2d) return true;
  try {
    var c = new OffscreenCanvas(16, 16);
    c2d = c.getContext("2d", { alpha: false });
    if (c2d) c2dCanvas = c;
    return !!c2d;
  } catch (e) { return false; }
}
var c2dCanvas = null;

function fit(c, w, h) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
function init(d) {
  allowed = d.methods || ["canvas2d", "webgpu"];
  return allowed.reduce(function (p, m) {
    return p.then(function (done) {
      if (done) return done;
      if (m === "webgpu") return initWebGpu().then(function (adapter) { method = "webgpu"; return { method: method, adapter: adapter }; }, function (e) { return { skip: describe(e) }; }).then(function (r) { if (r.skip) { init.why.push("webgpu: " + r.skip); return null; } return r; });
      if (m === "canvas2d") { if (c2dReady()) { method = "canvas2d"; return { method: method, adapter: null }; } init.why.push("canvas2d: sem contexto 2d"); return null; }
      return null;
    });
  }, Promise.resolve(null));
}
init.why = [];

function copy(frame) {
  var w = frame.displayWidth, h = frame.displayHeight;
  var opts = { timestamp: frame.timestamp, alpha: "discard" };
  if (frame.duration != null) opts.duration = frame.duration;
  if (method === "webgpu" && device) {
    fit(canvas, w, h);
    var ext = device.importExternalTexture({ source: frame });
    var bind = device.createBindGroup({ layout: layout, entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: ext }] });
    var enc = device.createCommandEncoder();
    var pass = enc.beginRenderPass({ colorAttachments: [{ view: gctx.getCurrentTexture().createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
    var t0 = performance.now();
    device.queue.submit([enc.finish()]);
    inflight++;
    device.queue.onSubmittedWorkDone().then(function () {
      inflight--;
      var ms = performance.now() - t0;
      st.gpuMs += ms; st.gpuN++; if (ms > st.gpuMax) st.gpuMax = ms;
      if (ms > 33) st.gpuLate++;
    }, function () { inflight--; });
    return new VideoFrame(canvas, opts);
  }
  fit(c2dCanvas, w, h);
  c2d.drawImage(frame, 0, 0, w, h);
  return new VideoFrame(c2dCanvas, opts);
}

// at most one write in flight to the generator and one waiting: a newer frame replaces the waiting one (dropped)
var writing = false, waiting = null;
function emit(out) {
  if (!writer) { out.close(); return; }
  if (writing) { if (waiting) { waiting.close(); st.dropped++; st.dropWrite++; } waiting = out; return; }
  writing = true;
  // written: o gerador aceitou o quadro (o main confere que a copia anda: captureCopy.ts → o vigia do fluxo)
  writer.write(out).then(function () { st.written++; next(); }, function () { out.close(); next(); });
}
function next() {
  writing = false;
  var w = waiting; waiting = null;
  if (w) emit(w);
}
function keepLast(out) {
  if (last) last.close();
  last = null;
  try { last = out.clone(); lastAt = performance.now(); } catch (e) { last = null; }
}

async function loop() {
  for (;;) {
    var r;
    try { r = await reader.read(); } catch (e) { if (!stopped) post("ended", { error: describe(e) }); break; }
    if (r.done || stopped) { if (r.value) r.value.close(); break; }
    var frame = r.value;
    st.frames++;
    st.width = frame.displayWidth; st.height = frame.displayHeight;
    if (passthrough) { st.passed++; emit(frame); continue; }
    if (method === "webgpu" && inflight >= MAX_INFLIGHT) { frame.close(); st.dropped++; st.dropGpu++; continue; }
    var t0 = performance.now(), out = null;
    try { out = copy(frame); fails = 0; }
    catch (e) {
      out = null;
      if (++fails >= FAIL_LIMIT) { passthrough = true; warnOnce("fail", "A cópia na hora falhou " + FAIL_LIMIT + " vezes seguidas (" + describe(e) + "): desligada, a captura segue direto"); }
      else warnOnce("fail1", "A cópia na hora falhou num quadro (" + describe(e) + "): esse quadro foi direto");
    }
    if (!out) { st.passed++; emit(frame); continue; }
    frame.close();
    var ms = performance.now() - t0;
    st.copyMs += ms; if (ms > st.copyMax) st.copyMax = ms;
    st.copied++;
    if (!slowChecked && method === "canvas2d" && st.copied >= SLOW_SAMPLE) checkSlow();
    keepLast(out);
    emit(out);
  }
  finish();
}

// canvas 2D sem aceleracao (raster por software) le cada quadro de volta para o processador: lento. Uma vez, depois de
// SLOW_SAMPLE copias, acima de SLOW_MS em media passa para o WebGPU (se ele foi permitido e existe)
function checkSlow() {
  slowChecked = true;
  var avg = st.copyMs / st.copied;
  if (avg <= SLOW_MS) return;
  var text = "o canvas 2D está lento (" + avg.toFixed(1) + " ms por quadro, sem aceleração?)";
  if (allowed.indexOf("webgpu") < 0) { warnOnce("slow", text); return; }
  initWebGpu().then(function (adapter) {
    if (stopped || passthrough) return;
    method = "webgpu";
    post("info", { message: text + ": a cópia passou para o WebGPU (" + adapter + ")" });
  }, function (e) { warnOnce("slow", text + " e o WebGPU não está disponível (" + describe(e) + ")"); });
}

function finish() {
  stopped = true;
  if (last) { last.close(); last = null; }
  if (waiting) { waiting.close(); waiting = null; }
  try { if (reader) reader.cancel().catch(function () { }); } catch (e) { }
  try { if (writer) writer.close().catch(function () { }); } catch (e) { }
  reader = writer = null;
  if (device) { try { device.destroy(); } catch (e) { } device = null; }
}

function refresh() {
  if (!last || !writer || stopped) return;
  var ts = last.timestamp + Math.max(1, Math.round((performance.now() - lastAt) * 1000));
  var again = null;
  try { again = new VideoFrame(last, { timestamp: ts }); } catch (e) { return; }
  st.refreshed++;
  emit(again);
}

self.onmessage = function (e) {
  var d = e.data || {};
  if (d.op === "init") {
    if (d.maxInflight > 0) MAX_INFLIGHT = d.maxInflight;
    init(d).then(function (r) { if (r) post("ready", r); else post("failed", { error: init.why.join("; ") || "nenhum método" }); }, function (x) { post("failed", { error: describe(x) }); });
  } else if (d.op === "run") {
    reader = d.readable.getReader();
    writer = d.writable.getWriter();
    loop();
  } else if (d.op === "refresh") {
    refresh();
  } else if (d.op === "stats") {
    var s = {}; for (var k in st) s[k] = st[k];
    s.method = passthrough ? "passthrough" : method; s.inflight = inflight;
    post("stats", s);
  } else if (d.op === "stop") {
    finish();
  }
};
post("hello");
`;
