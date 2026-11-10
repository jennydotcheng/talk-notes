// Runs the speech models off the main thread. Everything here happens on the device.
import { pipeline, AutoProcessor, AutoModel, env } from './vendor/transformers.min.js';

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
  : 1;

const S = 16000;
const SPEAKER_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
let asr = null, spkProc = null, spkModel = null, loadedModel = null;

function progressTracker() {
  const files = {};
  let last = 0;
  return (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files[p.name + '/' + p.file] = [p.loaded, p.total];
    let loaded = 0, total = 0;
    for (const k in files) { loaded += files[k][0]; total += files[k][1]; }
    const now = Date.now();
    if (now - last > 200) { last = now; self.postMessage({ type: 'progress', loaded, total }); }
  };
}

async function load(model) {
  if (asr && loadedModel === model) { self.postMessage({ type: 'ready' }); return; }
  const cb = progressTracker();
  asr = await pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'wasm', progress_callback: cb });
  spkProc = await AutoProcessor.from_pretrained(SPEAKER_MODEL, { progress_callback: cb });
  spkModel = await AutoModel.from_pretrained(SPEAKER_MODEL, { dtype: 'fp32', device: 'wasm', progress_callback: cb });
  loadedModel = model;
  self.postMessage({ type: 'ready', threads: env.backends.onnx.wasm.numThreads });
}

const JUNK = /^\s*[\[(][^\])]*[\])]\s*$/; // "[BLANK_AUDIO]", "(music)" and similar

async function voiceprint(audio) {
  try {
    const inputs = await spkProc(audio);
    const out = await spkModel(inputs);
    const t = out.embeddings || out.last_hidden_state || out[Object.keys(out)[0]];
    return Array.from(t.data);
  } catch (e) {
    return null;
  }
}

async function transcribe(msg) {
  const audio = msg.audio;
  const dur = audio.length / S;
  const out = await asr(audio, { return_timestamps: true, language: msg.lang, task: 'transcribe' });
  const chunks = out.chunks && out.chunks.length ? out.chunks : [{ timestamp: [0, dur], text: out.text || '' }];
  const segs = [];
  let prevText = '';
  for (const c of chunks) {
    const text = (c.text || '').trim();
    if (!text || JUNK.test(text) || text === prevText) continue;
    prevText = text;
    let s = c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0;
    let e = c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : dur;
    s = Math.max(0, Math.min(s, dur));
    e = Math.max(s, Math.min(e, dur));
    let emb = null;
    if (e - s >= 1.0) {
      const end = Math.min(e, s + 8);
      emb = await voiceprint(audio.subarray(Math.floor(s * S), Math.floor(end * S)));
    }
    segs.push({ s: msg.offset + s, e: msg.offset + e, t: text, emb });
  }
  self.postMessage({ type: 'result', id: msg.id, sid: msg.sid, segs });
}

// Handle one message at a time, in order.
let chain = Promise.resolve();
self.onmessage = (ev) => {
  const msg = ev.data;
  chain = chain.then(async () => {
    try {
      if (msg.type === 'load') await load(msg.model);
      else if (msg.type === 'chunk') await transcribe(msg);
    } catch (e) {
      self.postMessage({ type: 'error', during: msg.type, id: msg.id, sid: msg.sid, message: String((e && e.message) || e) });
    }
  });
};
