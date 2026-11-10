(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = 16000;            // samples per second the speech model expects
  var SAME_VOICE = 0.42;    // how alike two voiceprints must be to count as one speaker
  var MAX_SPEAKERS = 8;
  var COLORS = ['#2f7fb5', '#c0622a', '#2a9163', '#9a55b3', '#c04a55', '#7f8f22', '#1f9aa5', '#a88412'];
  var SIZES = { 'onnx-community/whisper-base': 125, 'onnx-community/whisper-small': 300 };

  var db = null, sessions = [], cur = null;
  var worker = null, modelsReady = false, loading = false;
  var recording = false, starting = false, ctx = null, stream = null, node = null, chunker = null, wake = null;
  var recStart = 0, tick = null, pending = 0, chunkSeq = 0;

  // ---------- small helpers ----------
  function ls(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
    return null;
  }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' : '') + p(m) + ':' + p(s);
  }
  function say(msg, kind) { $('status').textContent = msg; $('status').className = kind || ''; }
  function badge(msg, ok) { $('badge').textContent = msg; $('badge').className = ok ? 'ok' : ''; }
  function busy() { return recording || starting || pending > 0; }
  function defaultTitle() {
    return 'Conversation, ' + new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function nameOf(sess, k) { return (sess.names && sess.names[k]) || 'Speaker ' + (k + 1); }

  // ---------- storage (this browser only) ----------
  function openDb() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('talknotes', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('sessions', { keyPath: 'id' }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function dbAll() {
    return new Promise(function (res) {
      if (!db) return res([]);
      var rq = db.transaction('sessions').objectStore('sessions').getAll();
      rq.onsuccess = function () { res(rq.result || []); };
      rq.onerror = function () { res([]); };
    });
  }
  function dbPut(s) { if (db) { try { db.transaction('sessions', 'readwrite').objectStore('sessions').put(s); } catch (e) {} } }
  function dbDel(id) { if (db) { try { db.transaction('sessions', 'readwrite').objectStore('sessions').delete(id); } catch (e) {} } }

  function newSession() {
    return { id: 's' + Date.now(), title: '', created: Date.now(), dur: 0, segs: [], names: {}, cents: [], notes: '' };
  }
  function save(sess) {
    sess = sess || cur;
    if (!sess || !sess.segs.length) return;
    if (sess === cur) sess.title = $('title').value.trim() || sess.title || defaultTitle();
    if (sessions.indexOf(sess) < 0) sessions.unshift(sess);
    dbPut(sess);
    renderHistory();
  }

  // ---------- who is speaking ----------
  function cosine(a, b) {
    var d = 0, x = 0, y = 0;
    for (var i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
    return d / (Math.sqrt(x * y) || 1);
  }
  function addVoice(c, emb, w) {
    var n = 0, i;
    for (i = 0; i < emb.length; i++) n += emb[i] * emb[i];
    n = Math.sqrt(n) || 1;
    if (!c.v) { c.v = new Array(emb.length); for (i = 0; i < emb.length; i++) c.v[i] = 0; }
    for (i = 0; i < emb.length; i++) c.v[i] += emb[i] / n * w;
    c.n += w;
  }
  function assignSpeaker(sess, emb, dur) {
    var cents = sess.cents, last = sess.segs.length ? sess.segs[sess.segs.length - 1].k : 0;
    if (!emb) { if (!cents.length) cents.push({ v: null, n: 0 }); return last; }
    if (cents.length === 1 && !cents[0].v) { addVoice(cents[0], emb, dur); return 0; }
    var best = -1, bestSim = -2;
    for (var i = 0; i < cents.length; i++) {
      if (!cents[i].v) continue;
      var sim = cosine(cents[i].v, emb);
      if (sim > bestSim) { bestSim = sim; best = i; }
    }
    if (best >= 0 && (bestSim >= SAME_VOICE || cents.length >= MAX_SPEAKERS)) { addVoice(cents[best], emb, dur); return best; }
    // A short remark is too little to tell a new voice from a familiar one: never start a new speaker on it.
    if (best >= 0 && dur < 2.5) return bestSim >= 0.25 ? best : last;
    cents.push({ v: null, n: 0 });
    addVoice(cents[cents.length - 1], emb, dur);
    return cents.length - 1;
  }

  // ---------- transcript ----------
  function turnsOf(sess) {
    var out = [];
    sess.segs.forEach(function (g) {
      if (!g.t) return;
      var last = out[out.length - 1];
      if (last && last.k === g.k && g.s - last.e < 30) { last.segs.push(g); last.e = g.e; }
      else out.push({ k: g.k, s: g.s, e: g.e, segs: [g] });
    });
    return out;
  }
  function turnText(t, sess) {
    var cjk = sess.lang === 'chinese';
    return t.segs.map(function (g) { return g.t; }).join(cjk ? '' : ' ');
  }
  function transcriptText(sess) {
    return turnsOf(sess).map(function (t) {
      return nameOf(sess, t.k) + ' [' + fmt(t.s) + ']\n' + turnText(t, sess);
    }).join('\n\n');
  }
  function speakerCount(sess) {
    var n = sess.cents.length;
    sess.segs.forEach(function (g) { if (g.k + 1 > n) n = g.k + 1; });
    return n;
  }

  function renderSpeakers() {
    var wrap = $('speakers');
    wrap.innerHTML = '';
    var n = cur ? speakerCount(cur) : 0;
    $('speakersWrap').hidden = !cur || !cur.segs.length;
    for (var k = 0; k < n; k++) (function (k) {
      var d = document.createElement('div'); d.className = 'spk';
      var sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = COLORS[k % COLORS.length];
      var inp = document.createElement('input');
      inp.type = 'text'; inp.id = 'spk' + k; inp.placeholder = 'Speaker ' + (k + 1); inp.value = cur.names[k] || '';
      inp.setAttribute('aria-label', 'Name for speaker ' + (k + 1));
      inp.oninput = function () { cur.names[k] = inp.value.trim(); renderTranscript(); };
      inp.onchange = function () { save(); };
      d.appendChild(sw); d.appendChild(inp); wrap.appendChild(d);
    })(k);
  }

  function renderTranscript() {
    var box = $('transcript');
    var editable = !busy();
    box.innerHTML = '';
    if (!cur || !cur.segs.some(function (g) { return g.t; })) {
      var p = document.createElement('p'); p.id = 'empty';
      p.textContent = recording
        ? 'Listening. The first piece of transcript appears after about half a minute.'
        : 'The transcript appears here in pieces, about every half minute, while you record. Let people know before you record them.';
      box.appendChild(p);
      return;
    }
    var n = speakerCount(cur);
    turnsOf(cur).forEach(function (t, idx) {
      var div = document.createElement('div'); div.className = 'turn';
      div.style.borderLeftColor = COLORS[t.k % COLORS.length];
      var sel = document.createElement('select');
      sel.id = 'turn' + idx; sel.setAttribute('aria-label', 'Speaker for this part');
      for (var k = 0; k < n; k++) {
        var o = document.createElement('option'); o.value = k; o.textContent = nameOf(cur, k);
        if (k === t.k) o.selected = true;
        sel.appendChild(o);
      }
      if (n < MAX_SPEAKERS) { var add = document.createElement('option'); add.value = 'new'; add.textContent = '+ Someone else'; sel.appendChild(add); }
      sel.disabled = !editable;
      sel.onchange = function () {
        var k = sel.value === 'new' ? n : +sel.value;
        if (sel.value === 'new') cur.cents.push({ v: null, n: 0 });
        t.segs.forEach(function (g) { g.k = k; });
        save(); renderSpeakers(); renderTranscript();
      };
      var tm = document.createElement('time'); tm.textContent = fmt(t.s);
      var txt = document.createElement('p'); txt.className = 'text';
      txt.textContent = turnText(t, cur);
      if (editable) {
        txt.contentEditable = 'true'; txt.spellcheck = true;
        txt.onblur = function () {
          var v = txt.textContent.trim();
          if (v === turnText(t, cur)) return;
          t.segs[0].t = v;
          for (var i = 1; i < t.segs.length; i++) t.segs[i].t = '';
          save();
        };
      }
      div.appendChild(sel); div.appendChild(tm); div.appendChild(txt);
      box.appendChild(div);
    });
  }

  function refresh() {
    var has = !!(cur && cur.segs.some(function (g) { return g.t; }));
    var idle = !busy();
    $('recBtn').disabled = !modelsReady || starting || (!recording && pending > 0);
    $('recBtn').classList.toggle('on', recording);
    $('recLabel').textContent = recording ? 'Stop' : (has ? 'Keep recording' : 'Start recording');
    $('notesBtn').disabled = !has || !idle;
    $('copyBtn').disabled = !has;
    $('saveBtn').disabled = !has;
    $('newBtn').disabled = !has || !idle;
    $('file').disabled = !modelsReady || !idle;
    $('lang').disabled = !idle;
    $('model').disabled = !idle || loading;
    $('notesWrap').hidden = !has;
    $('timer').textContent = fmt(elapsed());
  }
  function renderAll() { renderSpeakers(); renderTranscript(); refresh(); }
  function elapsed() { return (cur ? cur.dur : 0) + (recording ? (Date.now() - recStart) / 1000 : 0); }

  // ---------- cutting the audio into pieces for the speech model ----------
  function makeChunker(startAt, sess) {
    var parts = [], len = 0, at = startAt;
    var MAX = 28 * S, MINCUT = 16 * S, FR = Math.floor(0.2 * S);
    function join() { var a = new Float32Array(len), o = 0; parts.forEach(function (p) { a.set(p, o); o += p.length; }); return a; }
    function emit(a) {
      var e = 0;
      for (var i = 0; i < a.length; i++) e += a[i] * a[i];
      var rms = Math.sqrt(e / (a.length || 1));
      var secs = a.length / S;   // measure before the audio is handed to the worker
      if (a.length >= 0.4 * S && rms > 0.0015) {
        pending++;
        worker.postMessage({ type: 'chunk', id: ++chunkSeq, sid: sess.id, audio: a, offset: at, lang: sess.lang }, [a.buffer]);
      }
      at += secs;
    }
    return {
      push: function (p) {
        parts.push(p); len += p.length;
        if (len < MAX) return;
        var a = join(), best = MINCUT, bestE = Infinity;
        for (var i = MINCUT; i + FR <= a.length; i += FR >> 1) {      // cut at the quietest moment
          var e = 0;
          for (var j = i; j < i + FR; j++) e += a[j] * a[j];
          if (e < bestE) { bestE = e; best = i + (FR >> 1); }
        }
        var rest = a.slice(best);
        emit(a.slice(0, best));
        parts = [rest]; len = rest.length;
      },
      flush: function () { if (len) emit(join()); parts = []; len = 0; return at; }
    };
  }

  // ---------- recording ----------
  function ensureSession() {
    if (!cur) cur = newSession();
    if (!$('title').value.trim()) $('title').value = defaultTitle();
    cur.title = $('title').value.trim();
    if (!cur.segs.length) cur.lang = $('lang').value;
    return cur;
  }

  function start() {
    if (!modelsReady || busy()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.AudioWorkletNode) {
      say('This browser cannot record here. Use a current version of Safari or Chrome.', 'err'); return;
    }
    starting = true; refresh();
    say('Asking for the microphone…');
    var AC = window.AudioContext || window.webkitAudioContext;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } })
      .then(function (st) {
        stream = st;
        ctx = new AC();
        return ctx.audioWorklet.addModule('rec-worklet.js');
      })
      .then(function () {
        if (ctx.state === 'suspended') ctx.resume();
        var sess = ensureSession();
        var src = ctx.createMediaStreamSource(stream);
        node = new AudioWorkletNode(ctx, 'rec');
        var mute = ctx.createGain(); mute.gain.value = 0;
        src.connect(node); node.connect(mute); mute.connect(ctx.destination);
        chunker = makeChunker(sess.dur, sess);
        node.port.onmessage = function (e) {
          var a = e.data, s = 0;
          for (var i = 0; i < a.length; i += 8) s += a[i] * a[i];
          $('meter').firstElementChild.style.width = Math.min(100, Math.sqrt(s / (a.length / 8)) * 700) + '%';
          if (recording) chunker.push(a);
        };
        recording = true; starting = false; recStart = Date.now();
        tick = setInterval(function () { $('timer').textContent = fmt(elapsed()); }, 500);
        lockScreenOn();
        say('Recording. Keep this screen open; the transcript fills in as you go.', 'ok');
        renderAll();
      })
      .catch(function (e) {
        starting = false; cleanupAudio();
        var denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        say(denied ? 'The microphone is blocked. Allow it for this site in your browser settings, then try again.'
                   : 'Could not start the microphone: ' + ((e && e.message) || e), 'err');
        refresh();
      });
  }

  function cleanupAudio() {
    clearInterval(tick);
    try { if (node) { node.port.onmessage = null; node.disconnect(); } } catch (e) {}
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (ctx) ctx.close(); } catch (e) {}
    node = null; stream = null; ctx = null;
    if (wake) { try { wake.release(); } catch (e) {} wake = null; }
    $('meter').firstElementChild.style.width = '0';
  }
  function lockScreenOn() {
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { wake = w; }).catch(function () {});
  }

  function stop() {
    if (!recording) return;
    recording = false;
    cur.dur = chunker.flush();
    chunker = null;
    cleanupAudio();
    save();
    afterWork();
    renderAll();
  }

  function afterWork() {
    if (recording) return;
    if (pending > 0) say('Finishing the transcript… ' + pending + (pending === 1 ? ' piece' : ' pieces') + ' left.');
    else if (cur && cur.segs.length) say('Done. Name the speakers, fix any words, then make notes.', 'ok');
    else if (modelsReady) say('Ready. Press Start recording.');
  }

  // ---------- an audio file you already have ----------
  function importFile(file) {
    if (!file || !modelsReady || busy()) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    starting = true; refresh();
    say('Reading "' + file.name + '"…');
    var actx = new AC();
    file.arrayBuffer()
      .then(function (ab) { return new Promise(function (res, rej) { actx.decodeAudioData(ab, res, rej); }); })
      .then(function (buf) {
        var off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * S)), S);
        var src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
        return off.startRendering();
      })
      .then(function (r) {
        try { actx.close(); } catch (e) {}
        var data = r.getChannelData(0);
        if (cur && cur.segs.length) save();
        cur = newSession();
        $('title').value = file.name.replace(/\.[^.]+$/, '');
        ensureSession();
        var ch = makeChunker(0, cur);
        for (var i = 0; i < data.length; i += 8000) ch.push(data.slice(i, i + 8000));
        cur.dur = ch.flush();
        starting = false;
        if (!pending) say('That file sounds silent, so there is nothing to transcribe.', 'err'); else afterWork();
        renderAll();
      })
      .catch(function (e) {
        starting = false;
        say('Could not read that file. Try an m4a, mp3 or wav recording.', 'err');
        refresh();
      });
  }

  // ---------- speech models ----------
  function startWorker() {
    worker = new Worker('worker.js', { type: 'module' });
    worker.onmessage = function (ev) {
      var m = ev.data;
      if (m.type === 'progress') {
        var pct = Math.round(m.loaded / m.total * 100);
        $('setupBar').hidden = false; $('setupBar').value = pct;
        $('setupMsg').textContent = Math.round(m.loaded / 1048576) + ' of ' + Math.round(m.total / 1048576) + ' MB';
      } else if (m.type === 'ready') {
        modelsReady = true; loading = false;
        ls('tn.ready', $('model').value);
        $('setup').hidden = true;
        badge('Ready, works offline', true);
        afterWork(); refresh();
      } else if (m.type === 'result') {
        var sess = cur && cur.id === m.sid ? cur : sessions.filter(function (s) { return s.id === m.sid; })[0];
        pending = Math.max(0, pending - 1);
        if (sess) {
          m.segs.forEach(function (g) { sess.segs.push({ s: g.s, e: g.e, t: g.t, k: assignSpeaker(sess, g.emb, g.e - g.s) }); });
          save(sess);
        }
        afterWork(); renderAll();
      } else if (m.type === 'error') {
        if (m.during === 'load') {
          loading = false; modelsReady = false; ls('tn.ready', null);
          showSetup(navigator.onLine ? 'The download did not finish (' + m.message + '). Try again.'
                                     : 'You are offline. Connect to the internet once to finish setup.');
          badge('Setup needed');
        } else {
          pending = Math.max(0, pending - 1);
          say('One piece could not be transcribed (' + m.message + ').', 'err');
        }
        refresh(); renderTranscript();
      }
    };
    worker.onerror = function (e) {
      loading = false;
      showSetup('The speech engine could not start in this browser (' + (e.message || 'unknown error') + ').');
      badge('Not working here');
      refresh();
    };
  }
  function showSetup(msg) {
    $('setup').hidden = false;
    $('size').textContent = SIZES[$('model').value] || 125;
    $('setupMsg').textContent = msg || '';
    $('setupBtn').disabled = false;
    $('setupBar').hidden = true;
  }
  function loadModels(firstTime) {
    if (loading) return;
    loading = true; modelsReady = false;
    $('setupBtn').disabled = true;
    badge(firstTime ? 'Downloading…' : 'Loading…');
    say(firstTime ? 'Downloading the speech models. Keep this page open.' : 'Loading the speech models…');
    if (!worker) startWorker();
    worker.postMessage({ type: 'load', model: $('model').value });
    refresh();
  }

  // The service worker makes the app load offline and lets the models use several cores.
  // That only takes effect after one reload, so do it before the big download starts.
  function setupClicked() {
    $('setupBtn').disabled = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    var needReload = 'serviceWorker' in navigator && !self.crossOriginIsolated && !ls('tn.reloaded');
    if (!needReload) { loadModels(true); return; }
    $('setupMsg').textContent = 'Preparing…';
    var done = false;
    var go = function (reload) {
      if (done) return; done = true;
      if (reload) { ls('tn.reloaded', '1'); ls('tn.autosetup', '1'); location.reload(); }
      else loadModels(true);
    };
    navigator.serviceWorker.ready.then(function () { setTimeout(function () { go(true); }, 300); }, function () { go(false); });
    setTimeout(function () { go(false); }, 90000);
  }

  // ---------- notes, copy, save ----------
  function notesPrompt() {
    return 'Turn this conversation transcript into clear, useful notes.\n\n' +
      'The transcript came from automatic speech recognition on my device: some words are wrong and a few lines may be assigned to the wrong speaker. Fix obvious errors from context, and do not invent details that are not there. Write the notes in the language of the transcript.\n\n' +
      'Use exactly these sections, and leave out any section that would be empty:\n' +
      '## Summary\n(2 to 4 sentences)\n## Key points\n(bullets)\n## Decisions\n(bullets)\n## Action items\n(one per line as "- [ ] task (owner, due date if mentioned)")\n## Open questions\n(bullets)\n\n' +
      'Conversation: ' + (cur.title || 'Untitled') + '\n\nTranscript:\n' + transcriptText(cur);
  }
  function copyText(text) {
    function fallback() {
      var t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      t.remove();
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
    return Promise.resolve(fallback());
  }
  function makeNotes() {
    save();
    if (!navigator.onLine) { say('Notes need the internet. Your transcript is saved here; come back to this when you are online.', 'err'); return; }
    var p = notesPrompt(), url = 'https://claude.ai/new', q = encodeURIComponent(p);
    if (q.length < 6000) url += '?q=' + q;
    window.open(url, '_blank', 'noopener');
    copyText(p).then(function (ok) {
      say(ok ? 'Claude opened. If the message box is empty, paste, then send. Paste the notes back here to keep them.'
             : 'Claude opened. Use "Copy transcript" here and paste it there.', 'ok');
    });
  }
  function download() {
    save();
    var text = '# ' + cur.title + '\n' + new Date(cur.created).toLocaleString() + '\n\n' +
      (cur.notes ? cur.notes.trim() + '\n\n---\n\n' : '') + '## Transcript\n\n' + transcriptText(cur) + '\n';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = (cur.title || 'conversation').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  // ---------- earlier conversations ----------
  function renderHistory() {
    var list = $('history');
    list.innerHTML = '';
    sessions.sort(function (a, b) { return b.created - a.created; });
    $('historyPanel').hidden = !sessions.length;
    sessions.forEach(function (s) {
      var li = document.createElement('li');
      var open = document.createElement('button');
      open.className = 'open'; open.type = 'button'; open.textContent = s.title || 'Untitled';
      open.onclick = function () { if (!busy()) openSession(s); };
      var when = document.createElement('span'); when.className = 'when';
      when.textContent = new Date(s.created).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + fmt(s.dur || 0) + (s.notes ? ' · notes' : '');
      var del = document.createElement('button');
      del.className = 'link'; del.type = 'button'; del.textContent = 'Delete';
      del.onclick = function () {
        if (busy()) return;
        if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = 'Really delete?'; return; }
        sessions = sessions.filter(function (x) { return x !== s; });
        dbDel(s.id);
        if (cur === s) blank();
        renderHistory();
      };
      li.appendChild(open); li.appendChild(when); li.appendChild(del);
      list.appendChild(li);
    });
  }
  function openSession(s) {
    if (cur && cur !== s) save();
    cur = s;
    $('title').value = s.title || ''; $('notes').value = s.notes || '';
    if (s.lang) $('lang').value = s.lang;
    say('Opened "' + (s.title || 'Untitled') + '".');
    renderAll();
    window.scrollTo(0, 0);
  }
  function blank() {
    cur = null;
    $('title').value = ''; $('notes').value = '';
    afterWork(); renderAll();
  }

  // ---------- wiring ----------
  $('recBtn').onclick = function () { if (recording) stop(); else start(); };
  $('setupBtn').onclick = setupClicked;
  $('notesBtn').onclick = makeNotes;
  $('saveBtn').onclick = download;
  $('newBtn').onclick = function () { save(); blank(); };
  $('copyBtn').onclick = function () {
    copyText(transcriptText(cur)).then(function (ok) { say(ok ? 'Transcript copied.' : 'Could not copy. Use "Save as file" instead.', ok ? 'ok' : 'err'); });
  };
  $('file').onchange = function () { var f = $('file').files[0]; $('file').value = ''; importFile(f); };
  $('title').onchange = function () { if (cur) { cur.title = $('title').value.trim(); save(); } };
  var nt = null;
  $('notes').oninput = function () { clearTimeout(nt); nt = setTimeout(function () { if (cur) { cur.notes = $('notes').value; save(); } }, 600); };
  $('lang').onchange = function () { ls('tn.lang', $('lang').value); if (cur && !cur.segs.length) cur.lang = $('lang').value; };
  $('model').onchange = function () {
    ls('tn.model', $('model').value);
    modelsReady = false; ls('tn.ready', null);
    badge('Setup needed'); say('Download the speech models for this quality setting to continue.');
    showSetup(); refresh();
  };
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && recording && !wake) lockScreenOn();
  });
  window.addEventListener('beforeunload', function (e) { if (busy()) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- start up ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  var savedLang = ls('tn.lang'); if (savedLang) $('lang').value = savedLang;
  var savedModel = ls('tn.model'); if (savedModel && SIZES[savedModel]) $('model').value = savedModel;
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  $('iosTip').hidden = !(ios && !standalone);

  openDb().then(function (d) { db = d; return dbAll(); }).then(function (all) {
    sessions = all;
    renderHistory();
  });

  var auto = ls('tn.autosetup');
  if (auto) { ls('tn.autosetup', null); showSetup(); loadModels(true); }
  else if (ls('tn.ready') === $('model').value) loadModels(false);
  else { badge('Setup needed'); say('Finish the one-time setup above, then you can record.'); showSetup(); }
  renderAll();

  // Small hook so the app can be checked automatically.
  window.__talknotes = { state: function () { return { ready: modelsReady, pending: pending, cur: cur, isolated: !!self.crossOriginIsolated }; } };
})();
