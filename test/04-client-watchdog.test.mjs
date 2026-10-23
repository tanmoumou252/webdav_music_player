import "../runtime-lock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { loadParts } from "./helper/load-parts.mjs";

// Tier-2/Tier-3 runtime lock for the client stall watchdog.
//
// The client playback script lives inside the renderHTML() template <script>
// and is never imported by the suite. The structural lock in 03-render-snapshot
// only proves the cleanup lines exist in the template bytes; it does NOT prove
// the exhausted branch actually stops the heartbeat at runtime. This harness
// executes the REAL rendered client script inside a vm sandbox with stubbed DOM
// + fake timers and drives the exhausted branch, closing review finding E2.
//
// The client <script> is guarded by the renderHTML template-literal escaping
// rules (no raw backtick / ${ inside it), so the extracted text is the exact
// browser-executable source. We append a hook that surfaces the closure
// internals (mirrors how test/helper/load-parts.mjs appends a return object).

const { renderHTML } = loadParts();

function extractClientScript() {
  const html = renderHTML();
  const open = "<script>";
  const start = html.indexOf(open);
  assert.ok(start >= 0, "client <script> block must exist in renderHTML output");
  const end = html.indexOf("</script>", start);
  assert.ok(end > start, "client <script> block must be closed");
  return html.slice(start + open.length, end);
}

function makeStubElement() {
  return {
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; } },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    scrollTo() {}, focus() {}, blur() {}, select() {}, click() {}, contains() { return false; },
    textContent: "", innerHTML: "", value: "", src: "",
    currentTime: 0, readyState: 0, volume: 1, muted: false, duration: 0, paused: true,
    dataset: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetHeight: 0, offsetTop: 0,
    children: [], parentNode: null,
    play() { return Promise.resolve(); }, pause() {}, load() {},
  };
}

// Build a fully isolated sandbox for one execution of the client script so the
// positive and mutation-negative runs can never share mutable state.
function runClient(scriptText, options = {}) {
  const prelude = options.prelude || "";
  const windowOverrides = options.windowOverrides || {};
  const elements = {};
  const getEl = (id) => (elements[id] || (elements[id] = makeStubElement()));
  const documentStub = {
    title: "",
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: makeStubElement,
    addEventListener() {}, removeEventListener() {},
    body: makeStubElement(),
    activeElement: null,
    hidden: false,
    contains() { return false; },
    execCommand() { return false; },
  };
  const timers = { intervals: [], cleared: [], nextId: 0 };
  timers.setInterval = (fn) => { const id = ++timers.nextId; timers.intervals.push({ id, fn }); return id; };
  timers.clearInterval = (id) => { timers.cleared.push(id); const i = timers.intervals.findIndex((t) => t.id === id); if (i >= 0) timers.intervals.splice(i, 1); };
  timers.setTimeout = () => ++timers.nextId;
  timers.clearTimeout = () => {};
  const storage = {
    _m: {},
    getItem(k) { return k in this._m ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); },
    removeItem(k) { delete this._m[k]; },
  };
  const clip = { texts: [], writeText(t) { clip.texts.push(t); return Promise.resolve(); } };
  const windowStub = {
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: () => ++timers.nextId,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    location: { search: "", href: "https://app.example.com/", pathname: "/" },
    history: { replaceState() {}, pushState() {} },
    crypto: { subtle: {} },
    scrollTo() {},
    jsmediatags: null,
    MediaMetadata: function (init) { this.title = init && init.title || ''; this.artist = init && init.artist || ''; this.album = init && init.album || ''; this.artwork = init && init.artwork || []; },
    document: documentStub,
    localStorage: storage,
    navigator: {
      clipboard: clip,
      mediaSession: {
        metadata: null,
        setActionHandler() {},
      },
    },
  };
  for (const [k, v] of Object.entries(windowOverrides)) {
    if (v === undefined) delete windowStub[k];
    else windowStub[k] = v;
  }
  const sandbox = {
    document: documentStub,
    window: windowStub,
    localStorage: storage,
    navigator: windowStub.navigator,
    console: { log() {}, warn() {}, error() {} },
    URL, URLSearchParams, AbortController, Blob, TextEncoder, TextDecoder,
    FileReader: function () { this.readAsText = () => {}; },
    Response, Request, Headers,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    // init() fetches /api/status then bails early when !isInitialized, so the
    // detached async tail can never re-arm the watchdog during our sync drive.
    fetch: async () => ({ ok: true, json: async () => ({ title: "T", isAdmin: false, isInitialized: false, sources: [] }), text: async () => "" }),
    __T: null,
  };
  sandbox.globalThis = sandbox;
  const hook =
    "\n;globalThis.__T = {" +
    "getState: () => ({ stallHeartbeat, stallRetries, pendingSeek, shareSeek: pendingShareSeek, playToken, currentNodeIndex, currentSongRef, lastProgressTime, waitingForGesture, userPaused, externallyPaused, title: document.title, mediaMetadata: navigator.mediaSession ? navigator.mediaSession.metadata : null, siteTitle: window.__siteTitle })," +
    "audio, fireTimeUpdate: () => { const f = audio.ontimeupdate; if (f) f(); }," +
    "getTagAbort: () => tagAbort," +
    "readEmbeddedTags," +
    "parseShareTime: typeof parseShareTime === 'function' ? parseShareTime : null," +
    "formatShareTime: typeof formatShareTime === 'function' ? formatShareTime : null," +
    "armShareSeek: typeof pendingShareSeek !== 'undefined' ? (v) => { pendingShareSeek = v; } : null," +
    "seedShareSong: (song, time) => { currentPlaylist = [song]; currentIndex = 0; audio.currentTime = time; }," +
    "copyShareUrl: () => copyCurrentSongShareUrl()," +
    "tryPlayFromNode, startStallHeartbeat, stopStallHeartbeat, recoverPlayback, stallHeartbeatTick, startPlayback, togglePlay, seekAudio, renderBufferedRanges, " +
    "beginDrag, resolveDropIndex, finishDrag, markNodeBad, isNodeAvoidable, clearNodeBad, " +
    "handleGlobalKeydown: typeof handleGlobalKeydown === 'function' ? handleGlobalKeydown : null, " +
    "handleLoginKeydown: typeof handleLoginKeydown === 'function' ? handleLoginKeydown : null, " +
    "loginAdmin: typeof loginAdmin === 'function' ? loginAdmin : null, " +
    "getLoginPending: () => (typeof adminLoggingIn !== 'undefined' ? adminLoggingIn : null)" +
    "};";
  runInNewContext(prelude + scriptText + hook, sandbox, { filename: "client.js" });
  return { T: sandbox.__T, timers, sandbox, clip };
}

const SONG = { id: "abc12345", name: "Alpha - One.mp3", availableNodes: [{ sourceId: "s1", href: "Alpha%20-%20One.mp3" }] };
// Whitespace-insensitive matcher for the cleanup sequence so the mutation
// sensitivity test does not depend on the template's exact indentation.
const CLEANUP_RE = /stopStallHeartbeat\(\);\s*stallRetries\s*=\s*0;\s*pendingSeek\s*=\s*null;/;

// Flush pending microtasks (audio.play() promise chain) so assertions observe
// the full async flow, not just the synchronous prefix of tryPlayFromNode.
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

test("active playback start forgets remembered progress and never resumes", () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  T.audio.paused = false; T.audio.readyState = 4; T.audio.currentTime = 40;
  T.fireTimeUpdate();
  T.startPlayback(SONG, 0, false, false);
  assert.equal(T.getState().pendingSeek, null, "a default (active-click) start must clear pendingSeek, never resume from remembered progress");
});

test("refresh-located start keeps remembered progress", async () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  T.audio.paused = false; T.audio.readyState = 4; T.audio.currentTime = 40;
  T.fireTimeUpdate();
  T.startPlayback(SONG, 0, false, false, true);
  assert.equal(T.getState().pendingSeek, 40, "the resume=true (refresh/深链) start must resume from remembered progress");
  await flushMicrotasks();
});

test("client watchdog: the exhausted branch actually clears the stall heartbeat interval", async () => {
  const { T, timers } = runClient(extractClientScript());
  T.startStallHeartbeat();
  assert.equal(timers.intervals.length, 1, "precondition: the watchdog interval must be running");
  // nodeIndex past the end -> the all-nodes-exhausted branch.
  await T.tryPlayFromNode(SONG, SONG.availableNodes.length, false);
  await flushMicrotasks();
  const st = T.getState();
  assert.equal(timers.intervals.length, 0, "the exhausted branch must clear the live stall interval — a surviving interval drives the repeat-recovery loop");
  assert.equal(timers.cleared.length, 1, "clearInterval must have been invoked exactly once");
  assert.equal(st.stallHeartbeat, null, "the heartbeat handle must be null after exhaustion");
  assert.equal(st.stallRetries, 0, "recovery retry budget must be reset");
  assert.equal(st.pendingSeek, null, "pending seek must be cleared so a stale resume point cannot survive");
});

test("client watchdog: a running watchdog is left alone by a NON-exhausted (mid-line) attempt", async () => {
  const { T, timers } = runClient(extractClientScript());
  T.startStallHeartbeat();
  assert.equal(timers.intervals.length, 1, "precondition: watchdog running");
  // nodeIndex within range -> must NOT clear the heartbeat (auto failover stays alive).
  await T.tryPlayFromNode(SONG, 0, false);
  await flushMicrotasks();
  assert.equal(timers.intervals.length, 1, "a mid-line attempt must keep the watchdog running for the next failover");
  assert.equal(timers.cleared.length, 0, "a mid-line attempt must not clear the interval");
});

test("client watchdog: fixture sensitivity — removing the cleanup lines keeps the interval alive", async () => {
  // Anti-greenwash guard: prove the positive assertion is load-bearing. If the
  // stopStallHeartbeat()+resets are stripped from the template, the exhausted
  // branch no longer clears the interval, so the first test above would fail.
  const raw = extractClientScript();
  assert.ok(CLEANUP_RE.test(raw), "the cleanup sequence must be present before mutation");
  const mutated = raw.replace(CLEANUP_RE, "/* cleanup removed */");
  assert.ok(!CLEANUP_RE.test(mutated), "mutation must have removed the cleanup sequence");
  const { T, timers } = runClient(mutated);
  T.startStallHeartbeat();
  assert.equal(timers.intervals.length, 1, "precondition: watchdog running under the mutated template");
  await T.tryPlayFromNode(SONG, SONG.availableNodes.length, false);
  await flushMicrotasks();
  assert.equal(timers.intervals.length, 1, "without the cleanup the watchdog must stay alive (this is the bug the fix removes)");
});

test("stall budget survives a paused/seek timeupdate (regression: unconditional reset erased the failover budget)", async () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  await flushMicrotasks();
  T.recoverPlayback();
  assert.equal(T.getState().stallRetries, 1, "precondition: one recovery charged the budget");
  T.audio.currentTime = 42; T.audio.paused = true; T.audio.readyState = 0;
  T.fireTimeUpdate();
  assert.equal(T.getState().stallRetries, 1, "Contract B non-trigger: paused/not-ready frame must NOT clear the charged budget");
  assert.equal(T.getState().lastProgressTime, 42, "Contract B degenerate-input: position is recorded regardless of the clear gate");
});

test("stall budget clears only on genuine forward playing progress", () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  T.recoverPlayback();
  assert.equal(T.getState().stallRetries, 1, "precondition: budget charged");
  T.audio.paused = false; T.audio.readyState = 4; T.audio.currentTime = 0;
  T.fireTimeUpdate();
  assert.equal(T.getState().stallRetries, 1, "Contract B boundary: equal position (strict >) must not clear");
  T.audio.currentTime = 5;
  T.fireTimeUpdate();
  assert.equal(T.getState().stallRetries, 0, "Contract B trigger: playing+settled+demuxed+advancing clears");
});

test("stall budget survives the seek-back reload frames while pendingSeek is armed", async () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  await flushMicrotasks();
  T.audio.paused = false; T.audio.readyState = 4; T.audio.currentTime = 30;
  T.fireTimeUpdate();                              // populates progressMemory(SONG)=30 (pendingSeek still null here)
  T.recoverPlayback();                             // stallRetries 0->1; pendingSeek = lastKnownProgress = 30
  assert.equal(T.getState().stallRetries, 1, "precondition: one recovery charged the budget");
  assert.notEqual(T.getState().pendingSeek, null, "precondition: recovery armed pendingSeek from remembered progress");
  T.audio.currentTime = 31; T.audio.readyState = 4; T.audio.paused = false;
  T.fireTimeUpdate();
  assert.equal(T.getState().stallRetries, 1, "armed-reload frame must NOT clear (pendingSeek!==null; the original bug)");
  T.audio.onloadedmetadata();
  assert.equal(T.getState().pendingSeek, null, "loadedmetadata settles the pending seek");
  T.audio.currentTime = 32;
  T.fireTimeUpdate();
  assert.equal(T.getState().stallRetries, 0, "after seek settles, genuine forward progress clears");
});

// F-A cancellation behavior lock (review E3): the tagAbort wiring in
// readEmbeddedTags must settle the read's promise to null on abort — verified
// at RUNTIME, not just by the structural string lock in 03-render-snapshot.
//
// A fake jsmediatags library whose read() never invokes its callbacks models a
// read "in flight" (e.g. stalled Range window fetch). getJsMediaTags() returns
// window.jsmediatags when set, so the loader fetch is bypassed with zero
// network. The returned object carries a feature-detected abort() that records
// the call, mirroring the production best-effort contract.

function runClientWithJmt() {
  // The fake library must exist BEFORE the script runs (getJsMediaTags caches
  // jmtLoader on first call), so it is injected as a prelude; the harness reads
  // the call/abort record back through the sandbox's own globalThis.
  const prelude =
    "globalThis.__holder = { reads: [], aborts: 0 };\n" +
    "window.jsmediatags = { read: function (u, c) { globalThis.__holder.reads.push(u); return { abort: function () { globalThis.__holder.aborts += 1; } }; } };\n";
  const { T, sandbox } = runClient(extractClientScript(), { prelude });
  return { T, holder: sandbox.globalThis.__holder };
}

test("tag read cancellation: aborting tagAbort settles the in-flight read to null", async () => {
  const { T, holder } = runClientWithJmt();
  T.startPlayback(SONG, 0, false, false);
  await flushMicrotasks();
  assert.ok(holder.reads.length === 0, "precondition: no tag read dispatched yet (no loadedmetadata fired)");
  // Drive the parse path directly: pendingTag dispatch happens on
  // loadedmetadata; but readEmbeddedTags is exposed, so drive it against the
  // abort controller's real signal (the production wiring under test).
  const p = T.readEmbeddedTags("/api/stream?sourceId=s1&file=Alpha%20-%20One.mp3");
  await flushMicrotasks(); // readEmbeddedTags is async: jmt.read dispatches after the first await tick
  assert.equal(holder.reads.length, 1, "the library URL reader must have been invoked exactly once");
  assert.ok(holder.reads[0].startsWith("https://app.example.com/api/stream"), "the tag read must target the absolute same-origin stream URL");
  const tagAbort = T.getTagAbort();
  assert.notEqual(tagAbort, null, "precondition: startPlayback armed the tag abort controller");
  tagAbort.abort();
  const resolved = await p;
  assert.equal(resolved, null, "Contract: an aborted tag read must settle to null (never hang, never resolve stale tags)");
  assert.equal(holder.aborts, 1, "the feature-detected best-effort reader.abort() must have been invoked on cancellation");
});

test("tag read cancellation: mutation sensitivity — removing done(null) from the abort wiring leaves the read unsettled", async () => {
  // Anti-greenwash guard for the behavior lock above: strip the settle call
  // from the wiring text; the promise must then never resolve (the bug shape
  // the string lock in 03 cannot catch).
  const raw = extractClientScript();
  const NEEDLE = "const cancelTagRead = () => { done(null); if (reader && typeof reader.abort === 'function') { try { reader.abort(); } catch (e) {} } };";
  assert.ok(raw.includes(NEEDLE), "the cancellation wiring must be present before mutation");
  const mutated = raw.replace(NEEDLE, "const cancelTagRead = () => { if (reader && typeof reader.abort === 'function') { try { reader.abort(); } catch (e) {} } };");
  assert.ok(!mutated.includes("done(null); if (reader"), "mutation must have removed the settle call");
  const { T, sandbox } = runClient(mutated, {
    prelude:
      "globalThis.__holder = { reads: [], aborts: 0 };\n" +
      "window.jsmediatags = { read: function (u, c) { globalThis.__holder.reads.push(u); return { abort: function () { globalThis.__holder.aborts += 1; } }; } };\n",
  });
  const holder = sandbox.globalThis.__holder;
  T.startPlayback(SONG, 0, false, false);
  await flushMicrotasks();
  const p = T.readEmbeddedTags("/api/stream?sourceId=s1&file=Alpha%20-%20One.mp3");
  await flushMicrotasks(); // same dispatch state as the positive lock: the read must be in flight before abort
  assert.equal(holder.reads.length, 1, "mutation precondition: the tag read must be dispatched and in flight before abort");
  T.getTagAbort().abort();
  const loser = await Promise.race([p.then(() => "settled"), flushMicrotasks().then(() => "pending")]);
  assert.equal(loser, "pending", "without done(null) the aborted read must NOT settle (proves the positive lock above is load-bearing)");
});

// Media title sync (plan 20261014-005312-mediashare-title-sync, findings A+B):
// the tab title and the lock-screen media metadata must follow the currently
// playing song. Pre-fix the client never writes document.title nor
// navigator.mediaSession.metadata (grep-verified zero occurrences), so these
// are business-red before the fix and green after.

test("media title sync: starting a song updates document.title with the display name and brand suffix", () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  assert.equal(
    T.getState().title,
    "Alpha - One" + " | Cloud Music Hub",
    "startPlayback must write the extension-stripped display name (fallback, pre-tags) into the tab title with the brand suffix"
  );
});

test("media title sync: MediaSession metadata is set at startPlayback and carries the playing song", () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  const md = T.getState().mediaMetadata;
  assert.notEqual(md, null, "the browser advertises mediaSession; the client must populate its metadata (finding B)");
  assert.equal(md.title, "Alpha - One", "metadata title must be the display name (fallback pre-tags)");
});

test("media title sync: a kernel without MediaMetadata must not throw during playback", () => {
  const raw = extractClientScript();
  // Feature-detection contract: the wiring must check window.MediaMetadata
  // before constructing it, so old kernels take the no-metadata path silently.
  assert.ok(raw.includes("window.MediaMetadata"), "the MediaMetadata constructor must be feature-detected (three-kernel rule)");
  const mutated = raw.replace(/if \(navigator\.mediaSession && window\.MediaMetadata\)/, "if (false)");
  const { T } = runClient(mutated);
  T.startPlayback(SONG, 0, false, false);
  assert.equal(T.getState().mediaMetadata, null, "without mediaSession support the playback flow must complete with no metadata and no throw");
  assert.equal(T.getState().title, "Alpha - One" + " | Cloud Music Hub", "title sync must survive the no-MediaSession kernel independently of finding B");
});

test("site title sync: init's data.title becomes the brand suffix for later document.title writes", async () => {
  const { T } = runClient(extractClientScript());
  await flushMicrotasks(); // top-level init() consumes the /api/status stub (title "T") before any playback write
  T.startPlayback(SONG, 0, false, false);
  assert.equal(T.getState().title, "Alpha - One" + " | T", "the brand suffix must come from the site title fetched by init(), not the hardcoded default");
});

test("site title sync: idle home page tab shows the configured site title from init", async () => {
  const { T } = runClient(extractClientScript());
  await flushMicrotasks();
  assert.equal(T.getState().title, "T", "with no share params the browser tab must show the site title fetched by init(), not the template default");
});

test("site title sync: a share page keeps its server-set tab title, init must not overwrite it", async () => {
  const { T } = runClient(extractClientScript(), {
    windowOverrides: { location: { search: "?play=deadbeef", href: "https://app.example.com/?play=deadbeef", pathname: "/" } },
  });
  await flushMicrotasks();
  assert.equal(T.getState().title, "", "the server-rendered share title is authoritative; init() must leave document.title untouched when a play/v/id param is present");
});

test("share time parse: youtube-style units only, floor at 3s", () => {
  const { T } = runClient(extractClientScript());
  assert.equal(T.parseShareTime("1m30s"), 90);
  assert.equal(T.parseShareTime("45s"), 45);
  assert.equal(T.parseShareTime("2m"), 120);
  assert.equal(T.parseShareTime("1h"), 3600);
  assert.equal(T.parseShareTime("1h2m3s"), 3723);
  assert.equal(T.parseShareTime("3s"), 3);
  assert.equal(T.parseShareTime("2s"), null, "below the 3s floor means no meaningful stamp");
  assert.equal(T.parseShareTime("90"), null, "unit-less seconds are rejected");
  assert.equal(T.parseShareTime("1:30"), null, "colon form is rejected");
  assert.equal(T.parseShareTime("abc"), null);
  assert.equal(T.parseShareTime(""), null);
  assert.equal(T.parseShareTime("86400s"), null, "a day-long stamp is noise for a track");
  assert.equal(T.parseShareTime("86399s"), null, "s-group caps at 2 digits, so 5-digit seconds never match");
  assert.equal(T.parseShareTime("23h59m59s"), 86399, "the largest legal sub-day stamp survives");
  assert.equal(T.formatShareTime(90) && T.parseShareTime(T.formatShareTime(90)) === 90, true, "roundtrip: 90");
  assert.equal(T.formatShareTime(3723) && T.parseShareTime(T.formatShareTime(3723)) === 3723, true, "roundtrip: 1h2m3s");
  assert.equal(T.formatShareTime(60) && T.parseShareTime(T.formatShareTime(60)) === 60, true, "roundtrip: 60");
  assert.equal(T.formatShareTime(3600) && T.parseShareTime(T.formatShareTime(3600)) === 3600, true, "roundtrip: 3600");
});

test("share time format: floor, unit compaction, <3s becomes empty", () => {
  const { T } = runClient(extractClientScript());
  assert.equal(T.formatShareTime(90), "1m30s");
  assert.equal(T.formatShareTime(45), "45s");
  assert.equal(T.formatShareTime(120), "2m");
  assert.equal(T.formatShareTime(3605), "1h5s");
  assert.equal(T.formatShareTime(3723), "1h2m3s");
  assert.equal(T.formatShareTime(2), "", "under the floor formats to nothing");
  assert.equal(T.formatShareTime(NaN), "");
  assert.equal(T.formatShareTime(95.7), "1m35s", "fractional playhead floors");
});

test("url share time overrides remembered progress once", () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  T.audio.paused = false; T.audio.readyState = 4; T.audio.currentTime = 40;
  T.fireTimeUpdate();
  T.armShareSeek(90);
  T.startPlayback(SONG, 0, false, false, true);
  assert.equal(T.getState().pendingSeek, 90, "the shared t must win over the local 40s record");
  assert.equal(T.getState().shareSeek, null, "the armed share time is consumed once");
  T.startPlayback(SONG, 0, false, false, true);
  assert.equal(T.getState().pendingSeek, 40, "the next resume falls back to the local record");
});

test("active start drops an armed share time", () => {
  const { T } = runClient(extractClientScript());
  T.armShareSeek(90);
  T.startPlayback(SONG, 0, false, false);
  assert.equal(T.getState().shareSeek, null, "a resume=false start must not leave the stamp armed for later");
  assert.equal(T.getState().pendingSeek, null, "and still plays from zero");
});

test("out-of-range share stamp is dropped by the existing metadata guard", () => {
  const { T } = runClient(extractClientScript());
  T.armShareSeek(9000);
  T.startPlayback(SONG, 0, false, false, true);
  assert.equal(T.getState().pendingSeek, 9000, "armed value reaches pendingSeek untouched at start");
  T.audio.duration = 100;
  T.audio.onloadedmetadata();
  assert.equal(T.getState().pendingSeek, null, "the guard must clear without seeking");
  assert.equal(T.audio.currentTime, 0, "no seek applied when the track is shorter than the stamp");
});

test("share copy embeds t from the playhead and stays plain before playback", () => {
  const { T, clip } = runClient(extractClientScript(), {
    windowOverrides: { location: { search: "", href: "https://app.example.com/", pathname: "/", origin: "https://app.example.com" } },
  });
  T.seedShareSong(SONG, 95);
  T.copyShareUrl();
  assert.deepEqual(clip.texts, ["https://app.example.com/?play=abc12345&t=1m35s"]);
  T.seedShareSong(SONG, 0);
  T.copyShareUrl();
  assert.equal(clip.texts.length, 2);
  assert.equal(clip.texts[1], "https://app.example.com/?play=abc12345", "no playhead, no t");
});

test("client stall-resume: a play() rejection is auto-recovered once canplay fires (no manual re-click)", async () => {
  const { T } = runClient(extractClientScript());
  await flushMicrotasks();
  let playCalls = 0;
  let rejectNext = true;
  T.audio.play = () => { playCalls += 1; return rejectNext ? Promise.reject(new Error("blocked")) : Promise.resolve(); };
  T.audio.paused = true;
  T.startPlayback(SONG, 0, false, false);
  await flushMicrotasks();
  assert.equal(T.getState().waitingForGesture, true, "precondition: a rejected play wedged the player into waitingForGesture");
  assert.equal(typeof T.audio.oncanplay, "function", "the client must wire an oncanplay auto-resume handler");
  rejectNext = false;
  const before = playCalls;
  T.audio.oncanplay();
  await flushMicrotasks();
  assert.ok(playCalls > before, "canplay must re-issue play() so the track starts on its own");
  assert.equal(T.getState().waitingForGesture, false, "a successful resume-play must clear waitingForGesture");
});

test("client stall-resume: an externally-paused element must NOT be auto-resumed by canplay", async () => {
  const { T } = runClient(extractClientScript());
  await flushMicrotasks();
  let playCalls = 0;
  let rejectNext = true;
  T.audio.play = () => { playCalls += 1; return rejectNext ? Promise.reject(new Error("blocked")) : Promise.resolve(); };
  T.audio.paused = true;
  T.startPlayback(SONG, 0, false, false);
  await flushMicrotasks();
  assert.equal(T.getState().waitingForGesture, true, "precondition: wedged");
  rejectNext = false;
  T.audio.onpause();
  assert.equal(T.getState().externallyPaused, true, "precondition: a non-user pause set externallyPaused");
  const before = playCalls;
  T.audio.oncanplay();
  await flushMicrotasks();
  assert.equal(playCalls, before, "externallyPaused must gate the auto-resume — no auto play()");
});

test("client stall-resume: the heartbeat attempts one resume while gesture-pending instead of muting forever", async () => {
  const { T } = runClient(extractClientScript());
  await flushMicrotasks();
  let playCalls = 0;
  let rejectNext = true;
  T.audio.play = () => { playCalls += 1; return rejectNext ? Promise.reject(new Error("blocked")) : Promise.resolve(); };
  T.audio.paused = true;
  T.startPlayback(SONG, 0, false, false);
  await flushMicrotasks();
  assert.equal(T.getState().waitingForGesture, true, "precondition: wedged; the old watchdog would dead-return here");
  rejectNext = false;
  const before = playCalls;
  T.stallHeartbeatTick();
  await flushMicrotasks();
  assert.ok(playCalls > before, "the re-armed watchdog must try to resume on its heartbeat, not return on waitingForGesture");
  assert.equal(T.getState().stallRetries, 0, "a gesture-pending resume must not charge the line-switch budget (it is not a line stall)");
});

test("client stall-resume: an explicit user pause must NEVER be auto-resumed by canplay or the heartbeat", async () => {
  const { T } = runClient(extractClientScript());
  await flushMicrotasks();
  let playCalls = 0;
  let rejectNext = true;
  T.audio.play = () => { playCalls += 1; return rejectNext ? Promise.reject(new Error("blocked")) : Promise.resolve(); };
  T.audio.paused = true;
  T.startPlayback(SONG, 0, false, false);
  await flushMicrotasks();
  assert.equal(T.getState().waitingForGesture, true, "precondition: wedged after a rejected play");
  rejectNext = false;
  T.audio.paused = false;
  T.togglePlay();
  await flushMicrotasks();
  assert.equal(T.getState().userPaused, true, "precondition: an explicit user pause (togglePlay else-branch) set userPaused and stopped the heartbeat");
  const before = playCalls;
  T.audio.oncanplay();
  T.stallHeartbeatTick();
  await flushMicrotasks();
  assert.equal(playCalls, before, "userPaused must hard-gate EVERY auto-resume path — the user's pause is never broken by canplay or the watchdog (E-2 safety invariant)");
});

test("client stall-resume mutation: removing the oncanplay wiring leaves the wedge with no resume source", async () => {
  const raw = extractClientScript();
  assert.ok(/audio\.oncanplay = \(\) => \{/.test(raw), "the oncanplay wiring must exist before mutation");
  const mutated = raw.replace(/audio\.oncanplay = \(\) => \{[\s\S]*?\};/, "/* oncanplay removed */");
  assert.ok(!/audio\.oncanplay/.test(mutated), "mutation must strip the oncanplay handler");
  const { T } = runClient(mutated);
  await flushMicrotasks();
  assert.equal(typeof T.audio.oncanplay, "undefined", "without the wiring the element has no canplay auto-resume — proves test 1 is load-bearing");
});

test("recovery point: seek-wait stall resumes at the live playhead, never the stale memory", () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  T.audio.paused = false; T.audio.readyState = 4; T.audio.currentTime = 30;
  T.fireTimeUpdate();
  T.audio.currentTime = 120; T.audio.readyState = 0;
  T.recoverPlayback();
  assert.equal(T.getState().pendingSeek, 120, "C-1: recovery point is the live playhead, not the pre-seek memory 30");
});

test("recovery point: an armed pendingSeek (share deep-link) is never downgraded", () => {
  const { T } = runClient(extractClientScript());
  T.armShareSeek(95);
  T.startPlayback(SONG, 0, false, false, true);
  T.audio.currentTime = 0; T.audio.readyState = 0;
  T.recoverPlayback();
  assert.equal(T.getState().pendingSeek, 95, "C-1: armed pendingSeek survives recovery untouched");
});

test("recovery point: dead element falls back to remembered progress (regression lock)", () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  T.audio.paused = false; T.audio.readyState = 4; T.audio.currentTime = 30;
  T.fireTimeUpdate();
  T.audio.currentTime = 0; T.audio.readyState = 0;
  T.recoverPlayback();
  assert.equal(T.getState().pendingSeek, 30, "C-1: playhead unusable (0) falls back to lastKnownProgress");
});

test("recovery point: togglePlay dead-element reconnection keeps remembered progress (W5 regression lock)", () => {
  const { T } = runClient(extractClientScript());
  T.startPlayback(SONG, 0, false, false);
  T.audio.paused = false; T.audio.readyState = 4; T.audio.currentTime = 30;
  T.fireTimeUpdate();
  T.audio.error = new Error("x"); T.audio.readyState = 0; T.audio.currentTime = 0;
  T.audio.paused = true;
  T.togglePlay();
  assert.equal(T.getState().pendingSeek, 30, "C-1: the togglePlay dead-element branch must keep lastKnownProgress, not the zeroed playhead");
});

test("seekAudio: out-of-range clientX clamps to [0, duration]; dead bar and non-finite duration are no-ops", () => {
  const { T, sandbox } = runClient(extractClientScript());
  const bar = sandbox.document.getElementById('progress-bar');
  bar.getBoundingClientRect = () => ({ left: 0, width: 100 });
  const barClasses = new Set();
  bar.classList = { add(c) { barClasses.add(c); }, remove(c) { barClasses.delete(c); }, toggle() {}, contains(c) { return barClasses.has(c); } };
  T.audio.duration = 100;
  T.seekAudio({ clientX: 150 });
  assert.equal(T.audio.currentTime, 100, "C-2: pct clamped to 1 -> currentTime = duration");
  T.seekAudio({ clientX: -50 });
  assert.equal(T.audio.currentTime, 0, "C-2: pct clamped to 0");
  T.seekAudio({ clientX: 50 });
  assert.equal(T.audio.currentTime, 50, "C-2: in-range click maps linearly and arms is-seeking");
  assert.ok(bar.classList.contains('is-seeking'), "C-4: an effective seek arms the seeking visual state");
  T.audio.onseeked();
  assert.ok(!bar.classList.contains('is-seeking'), "C-4: onseeked clears the seeking visual state");
  bar.getBoundingClientRect = () => ({ left: 0, width: 0 });
  T.audio.currentTime = 42;
  T.seekAudio({ clientX: 30 });
  assert.equal(T.audio.currentTime, 42, "C-2: zero-width rect (hidden bar) must be a no-op, never Infinity*duration");
  bar.getBoundingClientRect = () => ({ left: 0, width: 100 });
  T.audio.duration = NaN;
  T.seekAudio({ clientX: 80 });
  assert.equal(T.audio.currentTime, 42, "C-2: NaN duration is a no-op");
});

test("renderBufferedRanges: playhead-containing range is drawn; empty buffered and missing duration zero out", () => {
  const { T, sandbox } = runClient(extractClientScript());
  const el = sandbox.document.getElementById('progress-buffered');
  T.audio.duration = 200; T.audio.currentTime = 60;
  T.audio.buffered = { length: 2, start: (i) => [0, 120][i], end: (i) => [30, 200][i] };
  T.renderBufferedRanges();
  assert.equal(el.style.width, "15%", "C-3: no range contains playhead 60 -> fallback first range 30/200 = 15%");
  T.audio.buffered = { length: 2, start: (i) => [0, 120][i], end: (i) => [100, 200][i] };
  T.renderBufferedRanges();
  assert.equal(el.style.left, "0%", "C-3: containing range [0,100] at playhead 60");
  assert.equal(el.style.width, "50%", "C-3: width (100-0)/200");
  T.audio.buffered = { length: 0, start: () => 0, end: () => 0 };
  T.renderBufferedRanges();
  assert.equal(el.style.width, "0%", "C-3: empty TimeRanges -> zero width");
  T.audio.duration = NaN;
  T.audio.buffered = { length: 1, start: () => 0, end: () => 50 };
  T.renderBufferedRanges();
  assert.equal(el.style.width, "0%", "C-3: non-finite duration -> zero out, never NaN%");
});

function makeCard(name) {
  const card = {
    name,
    classList: { contains: (c) => c === "source-card" },
    parentNode: null,
    previousElementSibling: null,
    nextElementSibling: null,
  };
  return card;
}
function wireCards(cards) {
  cards.forEach((c, i) => {
    c.previousElementSibling = cards[i - 1] || null;
    c.nextElementSibling = cards[i + 1] || null;
    c.parentNode = { insertBefore: (node, ref) => {
      const from = cards.indexOf(node);
      const to = cards.indexOf(ref);
      cards.splice(from, 1);
      cards.splice(cards.indexOf(ref) + (to > from ? 1 : 0), 0, node);
    } };
  });
}

function makeDragCard(name, top) {
  const card = makeCard(name);
  card.__dragging = false;
  card.classList.add = (c) => { if (c === "dragging") card.__dragging = true; };
  card.classList.remove = (c) => { if (c === "dragging") card.__dragging = false; };
  card.dataset = {};
  card.getBoundingClientRect = () => ({ top, height: 100, left: 0, width: 300 });
  return card;
}
function wireDragContainer(sandbox, cards) {
  const container = sandbox.document.getElementById('sources-container');
  container.querySelectorAll = () => cards;
  container.querySelector = () => null;
  container.insertBefore = (node, ref) => {
    const from = cards.indexOf(node);
    if (from < 0) return;
    const to = cards.indexOf(ref);
    cards.splice(from, 1);
    cards.splice(cards.indexOf(ref) + (to > from ? 1 : 0), 0, node);
  };
  container.appendChild = (node) => {
    const from = cards.indexOf(node);
    if (from < 0) return;
    cards.splice(from, 1);
    cards.push(node);
  };
  return container;
}
function dragWindowOverrides(winHandlers) {
  return {
    addEventListener: (type, fn) => { (winHandlers[type] = winHandlers[type] || []).push(fn); },
    removeEventListener: (type, fn) => { const l = winHandlers[type] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
  };
}
function beginDragOn(T, card) {
  T.beginDrag({ pointerId: 1, clientY: 0, preventDefault() {}, stopPropagation() {}, target: { closest: () => ({ closest: () => card }) } });
}
function fireLast(winHandlers, type, event) {
  const l = winHandlers[type];
  l[l.length - 1](event);
}

test("drag move: finishDrag relocates the card node and preserves input values byte-for-byte (A12)", () => {
  const winHandlers = {};
  const { T, sandbox } = runClient(extractClientScript(), { windowOverrides: dragWindowOverrides(winHandlers) });
  const a = makeDragCard("A", 0), b = makeDragCard("B", 100), c = makeDragCard("C", 200);
  b.value = "编辑中的密码";
  const cards = [a, b, c];
  wireDragContainer(sandbox, cards);
  const order = () => cards.map((x) => x.name).join("");

  beginDragOn(T, b);
  fireLast(winHandlers, "pointermove", { pointerId: 1, clientY: 200 });
  assert.equal(order(), "ABC", "precondition: the move phase only shows the indicator, it must not relocate the card");
  assert.equal(b.__dragging, true, "the dragging translucency class must be on during the drag");

  T.finishDrag({ pointerId: 1, clientY: 200 });
  assert.equal(order(), "ACB", "a drop before C relocates B via node move (insertBefore), never innerHTML");
  assert.equal(b.value, "编辑中的密码", "input values survive a move byte-for-byte (A12)");
  assert.equal(b.__dragging, false, "no .dragging residue after the drop");
  assert.equal((winHandlers.pointermove || []).length, 0, "window drag listeners must be detached after the drop");
});

test("drag guards: pointerId mismatch, un-started end, out-of-container drop are all no-ops", () => {
  const winHandlers = {};
  const { T, sandbox } = runClient(extractClientScript(), { windowOverrides: dragWindowOverrides(winHandlers) });
  const a = makeDragCard("A", 0), b = makeDragCard("B", 100), c = makeDragCard("C", 200);
  const cards = [a, b, c];
  wireDragContainer(sandbox, cards);
  const order = () => cards.map((x) => x.name).join("");

  T.finishDrag({ pointerId: 1, clientY: 0 });
  assert.equal(order(), "ABC", "an un-started finishDrag must be a no-op, never a crash and never a relocation");

  beginDragOn(T, b);
  fireLast(winHandlers, "pointermove", { pointerId: 1, clientY: 250 });
  fireLast(winHandlers, "pointerup", { pointerId: 99, clientY: 250 });
  assert.equal(order(), "ABC", "a pointerId mismatch on pointerup must not relocate the card");
  assert.equal(b.__dragging, true, "a mismatched pointerup must not tear down the active drag state");

  T.finishDrag({ pointerId: 1, clientY: 999 });
  assert.equal(order(), "ACB", "a drop beyond the last card appends the dragged card to the end");
  assert.equal(b.__dragging, false, "no .dragging residue after the drop");

  const p = makeDragCard("P", 0), q = makeDragCard("Q", 100);
  const pair = [p, q];
  wireDragContainer(sandbox, pair);
  const pairOrder = () => pair.map((x) => x.name).join("");
  const origGet = sandbox.document.getElementById;
  beginDragOn(T, q);
  fireLast(winHandlers, "pointermove", { pointerId: 1, clientY: 300 });
  sandbox.document.getElementById = (id) => (id === 'sources-container' ? null : origGet(id));
  T.finishDrag({ pointerId: 1, clientY: 300 });
  sandbox.document.getElementById = origGet;
  assert.equal(pairOrder(), "PQ", "an out-of-container drop (no container) must return the card to its origin");
  assert.equal(q.__dragging, false, "an out-of-container drop must still clear the dragging state");
});

test("node health: mark/avoid/clear/TTL round-trip on the localStorage stub", () => {
  const { T, sandbox } = runClient(extractClientScript());
  assert.equal(T.isNodeAvoidable('s1'), false, "no record -> the source is healthy");
  T.markNodeBad('s1');
  assert.equal(T.isNodeAvoidable('s1'), true, "a marked source is avoidable within TTL");
  assert.ok(sandbox.localStorage._m['webdav_player_node_health_v1'], "health bits must persist under the dedicated storage key");
  const stored = JSON.parse(sandbox.localStorage._m['webdav_player_node_health_v1']);
  assert.equal(typeof stored.s1, "number", "badUntil must be stored as a number");
  stored.s1 = Date.now() - 1;
  sandbox.localStorage._m['webdav_player_node_health_v1'] = JSON.stringify(stored);
  assert.equal(T.isNodeAvoidable('s1'), false, "an expired badUntil (TTL) reads back as healthy");
  T.markNodeBad('s1');
  T.clearNodeBad('s1');
  assert.equal(T.isNodeAvoidable('s1'), false, "an explicit clear removes the avoidance mark (success clears)");
  T.markNodeBad('');
  assert.equal(T.isNodeAvoidable(''), false, "an empty sourceId is a guarded no-op");
});

test("playback start: an avoidable first node is skipped to the first healthy line, last line always tried", async () => {
  const SONG2 = { id: "def67890", name: "Beta - Two.mp3", availableNodes: [{ sourceId: "s1", href: "Beta%20-%20Two.mp3" }, { sourceId: "s2", href: "Beta%20-%20Two%20mirror.mp3" }] };
  const { T, sandbox } = runClient(extractClientScript());
  await T.tryPlayFromNode(SONG2, 0, false);
  await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 0, "no health records -> zero bypass: exact current behavior");
  assert.equal(sandbox.document.getElementById('info-node').textContent, '线路: 1/2', "info-node must show the requested line when nothing is avoided");

  T.markNodeBad('s1');
  await T.tryPlayFromNode(SONG2, 0, false);
  await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 1, "an avoidable first node is skipped to the first healthy line");
  assert.equal(sandbox.document.getElementById('info-node').textContent, '线路: 2/2', "info-node must reflect the effective line, not the requested one");

  T.markNodeBad('s2');
  await T.tryPlayFromNode(SONG2, 0, false);
  await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 1, "all lines avoided -> the last line is still hard-tried (avoid, never ban)");
  assert.equal(sandbox.document.getElementById('info-node').textContent, '线路: 2/2', "the hard-tried last line is announced as-is");
});

// ---- E-4 契约 C-A：空格 hijack 门控 ----
test("E-4 C-A: space on page body toggles playback and preventDefaults", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = null;
  let played = 0, prevented = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(played, 1, "C-A 触发域: nothing focused => space reaches togglePlay");
  assert.equal(prevented, 1, "C-A: a handled space must preventDefault so the page does not scroll");
});

test("E-4 C-A: space inside a text input must not toggle and must not preventDefault", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = { tagName: 'INPUT' };
  let played = 0, prevented = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(played, 0, "C-A 不该触发域①: typing a space in an input must not hijack playback");
  assert.equal(prevented, 0, "C-A: an unhandled space must let the browser insert it");
});

test("E-4 C-A: space on a focused button must fall through to native activation", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = { tagName: 'BUTTON' };
  let played = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() {} });
  assert.equal(played, 0, "C-A 不该触发域②: a focused control keeps its native space activation");
});

test("E-4 C-A: space while a modal is open must not toggle", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = null;
  const m = sandbox.document.getElementById('pass-modal');
  m.classList = { contains: (c) => c === 'show', add() {}, remove() {}, toggle() {} };
  let played = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() {} });
  assert.equal(played, 0, "C-A 不该触发域④: space must yield while the passphrase modal is showing");
});

test("E-4 C-A: a held space (event.repeat) must not toggle (autorepeat debounce)", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = null;
  let played = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', repeat: true, preventDefault() {} });
  assert.equal(played, 0, "C-A 不该触发域⑥: autorepeat keydown must not flip playback");
});

test("E-4 C-A: space on a focused select must yield to native activation", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = { tagName: 'SELECT' };
  let played = 0, prevented = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(played, 0, "C-A 不该触发域②: a focused SELECT keeps its native space dropdown activation");
  assert.equal(prevented, 0, "C-A: an unhandled space must not block the native select behavior");
});

test("E-4 C-A: space on a focused link must yield to native activation", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = { tagName: 'A' };
  let played = 0, prevented = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(played, 0, "C-A 不该触发域②: a focused A link keeps its native space activation");
  assert.equal(prevented, 0, "C-A: an unhandled space must not block the link's default action");
});

test("E-4 C-A: space inside a contenteditable must not toggle", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = { tagName: 'DIV', isContentEditable: true };
  let played = 0, prevented = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(played, 0, "C-A 不该触发域③: typing a space in a contenteditable must not hijack playback");
  assert.equal(prevented, 0, "C-A: an unhandled space must let the editor insert it");
});

test("E-4 C-A: space while the volume popover is open must not toggle", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = null;
  const vp = sandbox.document.getElementById('volume-popover');
  vp.classList = { contains: (c) => c === 'show', add() {}, remove() {}, toggle() {} };
  let played = 0, prevented = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(played, 0, "C-A 不该触发域⑤: space must yield while the volume popover is showing");
  assert.equal(prevented, 0, "C-A: the popover stays interactive, the space must not be swallowed");
});

test("E-4 C-A: space while playing pauses the audio (pause half of the toggle)", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = null;
  let paused = 0, played = 0, prevented = 0;
  T.audio.paused = false;
  T.audio.pause = () => { paused++; T.audio.paused = true; };
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: ' ', preventDefault() { prevented++; } });
  assert.equal(paused, 1, "C-A 触发域: a space during playback must reach togglePlay's pause half exactly once");
  assert.equal(played, 0, "C-A: the pause half must never re-play from the space path");
  assert.equal(prevented, 1, "C-A: the handled pause space must also preventDefault the page scroll");
  assert.equal(T.getState().userPaused, true, "C-A: pausing via space sets userPaused so canplay/heartbeat must not auto-resume");
});

test("E-4 shared-handler invariant: Escape must not enter the space branch or toggle", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.document.activeElement = null;
  let played = 0;
  T.audio.paused = true;
  T.audio.play = () => { played++; return Promise.resolve(); };
  T.handleGlobalKeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(played, 0, "non-space keys must never reach togglePlay (shared handler normal path unchanged)");
});

// ---- E-5 契约 C-C/C-D：登录框回车 + 防重入 ----
test("E-5 C-C: Enter in the admin login box submits loginAdmin", () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.fetch = () => new Promise(() => {}); // stay pending so the in-flight flag is observable
  assert.equal(T.getLoginPending(), false, "precondition: no submit in flight");
  T.handleLoginKeydown({ key: 'Enter' });
  assert.equal(T.getLoginPending(), true, "C-C: Enter must invoke loginAdmin, flipping the submit flag");
});

test("E-5 C-C: non-Enter keys must not submit", () => {
  const { T, sandbox } = runClient(extractClientScript());
  let calls = 0;
  sandbox.fetch = () => { calls++; return new Promise(() => {}); };
  T.handleLoginKeydown({ key: 'a' });
  assert.equal(T.getLoginPending(), false, "C-C 不该触发域: typing a letter must not trigger a submit");
  assert.equal(calls, 0, "no login request on a non-Enter key");
});

test("E-5 C-D: reentrancy guard blocks the second synchronous submit", () => {
  const { T, sandbox } = runClient(extractClientScript());
  let calls = 0;
  sandbox.fetch = () => { calls++; return new Promise(() => {}); }; // never settles => flag stays true
  T.loginAdmin();
  T.loginAdmin();
  assert.equal(calls, 1, "C-D: the second submit must be blocked, firing exactly one login request");
});

test("E-5 C-D: the flag resets after a settled submit, permitting a later re-submit", async () => {
  const { T, sandbox } = runClient(extractClientScript());
  let calls = 0;
  sandbox.fetch = () => { calls++; return Promise.reject(new Error("net-down")); };
  T.loginAdmin().catch(() => {});
  await flushMicrotasks();
  assert.equal(calls, 1, "first submit fires once");
  assert.equal(T.getLoginPending(), false, "C-D/A-7: finally must reset the flag even when fetch rejects");
  T.loginAdmin().catch(() => {});
  await flushMicrotasks();
  assert.equal(calls, 2, "C-D: once the prior request settled a later submit is allowed (not permanently wedged)");
});

// ---- 接线结构锁：注册行必须绑到具名 handler ----
test("E-4/E-5 wiring: keydown registrations bind the named handlers (structure lock)", () => {
  const raw = extractClientScript();
  assert.match(raw, /document\.addEventListener\('keydown',\s*handleGlobalKeydown\)/, "global keydown must bind handleGlobalKeydown");
  assert.match(raw, /getElementById\('login-admin-pass'\)\.addEventListener\('keydown',\s*handleLoginKeydown\)/, "login box must bind handleLoginKeydown");
  assert.match(raw, /function handleLoginKeydown\(e\) \{\s*if \(e\.key === 'Enter'\) loginAdmin\(\);/, "login Enter must call loginAdmin");
});

// ---- F5 避让末位重试 ----
test("F5 last-resort retry: a line skipped by avoidance gets exactly one final attempt before the all-failed branch", async () => {
  const SONG3 = { id: "f5aa1100", name: "Gamma - Three.mp3", availableNodes: [{ sourceId: "s1", href: "a.mp3" }, { sourceId: "s2", href: "b.mp3" }] };
  const { T } = runClient(extractClientScript());
  const srcs = [];
  Object.defineProperty(T.audio, "src", {
    get() { return this.__src || ""; },
    set(v) { this.__src = v; srcs.push(String(v)); },
    configurable: true,
  });
  T.markNodeBad('s1');
  await T.tryPlayFromNode(SONG3, 0, false);
  await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 1, "precondition: s1 is skipped to s2 on a fresh chain");
  T.audio.onerror();
  for (let k = 0; k < 4; k++) await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 0, "the skipped s1 must get its last-resort attempt after the normal lines fail");
  assert.ok(srcs.some((u) => u.indexOf("sourceId=s1") >= 0), "s1's stream URL must actually be attempted, got " + JSON.stringify(srcs));
});

test("F5 no-mark chain unchanged: a healthy line set never enters the retry path", async () => {
  const SONG4 = { id: "f5bb2200", name: "Delta - Four.mp3", availableNodes: [{ sourceId: "s1", href: "a.mp3" }, { sourceId: "s2", href: "b.mp3" }] };
  const { T } = runClient(extractClientScript());
  await T.tryPlayFromNode(SONG4, 0, false);
  await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 0, "no avoidance -> no skip -> no queue: exact current behavior");
  T.audio.onerror();
  for (let k = 0; k < 4; k++) await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 1, "with no queued skips the chain advances s1 -> s2 and terminates normally");
});

test("F5 bound & convergence: all four lines avoided -> every line gets a genuine attempt, attempts are finite, the chain reaches the all-failed branch", async () => {
  const SONG5 = { id: "f5cc3300", name: "Eps - Five.mp3", availableNodes: [{ sourceId: "s1", href: "a.mp3" }, { sourceId: "s2", href: "b.mp3" }, { sourceId: "s3", href: "c.mp3" }, { sourceId: "s4", href: "d.mp3" }] };
  const { T } = runClient(extractClientScript());
  const srcs = [];
  Object.defineProperty(T.audio, "src", {
    get() { return this.__src || ""; },
    set(v) { this.__src = v; srcs.push(String(v)); },
    configurable: true,
  });
  ['s1', 's2', 's3'].forEach((id) => T.markNodeBad(id));
  await T.tryPlayFromNode(SONG5, 0, false);
  for (let k = 0; k < 40; k++) {
    await flushMicrotasks();
    if (T.audio.onerror) T.audio.onerror();
  }
  await flushMicrotasks();
  const settled = srcs.length;
  assert.ok(settled > 0 && settled <= 12, "attempts must be finite and well under runaway, got " + settled + " (measured trace: s4,s1,s4,s2,s4,s3,s4 = 7)");
  const tried = new Set(srcs.map((u) => /sourceId=([^&]+)/.exec(u)[1]));
  assert.ok(tried.has('s1') && tried.has('s2') && tried.has('s3') && tried.has('s4'), "every avoided line must get a real last-resort attempt, tried=" + [...tried].join(","));
  for (let k = 0; k < 12; k++) {
    await flushMicrotasks();
    if (T.audio.onerror) T.audio.onerror();
  }
  await flushMicrotasks();
  assert.equal(srcs.length, settled, "the chain must CONVERGE: once the skip-queue drains and the last line is hard-tried, no further attempts may be issued");
});

// ---- retry-queue advance ordering (review finding: skipped-line failure must pop the next queued skip) ----
test("retry-queue advance: a failed last-resort line plays the next queued skip, not a +1 re-scan onto an already-tried line", async () => {
  const SONGR = { id: "r3adv001", name: "Retr - Queue.mp3", availableNodes: [
    { sourceId: "a", href: "a.mp3" }, { sourceId: "b", href: "b.mp3" }, { sourceId: "c", href: "c.mp3" },
    { sourceId: "d", href: "d.mp3" }, { sourceId: "e", href: "e.mp3" }] };
  const { T } = runClient(extractClientScript());
  T.markNodeBad("a");
  T.markNodeBad("b");
  await T.tryPlayFromNode(SONGR, 0, false);
  await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 2, "precondition: a and b skipped into the queue, first healthy line c (index 2) plays");
  // Fail the normal lines forward (c -> d -> e), which drives the chain past the end and into the
  // retry-queue pass; the queue pops its first skipped line a (index 0) as a genuine last-resort try.
  for (let k = 0; k < 3; k++) {
    T.audio.onerror();
    for (let j = 0; j < 6; j++) await flushMicrotasks();
  }
  assert.equal(T.getState().currentNodeIndex, 0, "precondition: after c/d/e fail, the queue pops last-resort line a (index 0)");
  // Now the last-resort line a itself fails. Correct behavior: advance to the next QUEUED skip (b, index 1).
  // Buggy behavior: effectiveIndex + 1 = 1 re-enters the avoidable-skip walk and lands back on the last
  // hard-tried line e (index 4), re-trying an already-failed line and stranding queued skip b.
  T.audio.onerror();
  for (let k = 0; k < 6; k++) await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 1, "retry-queue advance: a failing must play the next queued skip b (index 1), not re-scan onto a retried line");
});

test("G3 onerror marks only on a confirmed origin-probe failure: a media/decode error whose probe answered OK must advance the mirror WITHOUT blacklisting the source", async () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  const SONG_OK = { id: "g3ok0001", name: "Probe - Ok.mp3", availableNodes: [{ sourceId: "s1", href: "a.mp3" }, { sourceId: "s2", href: "b.mp3" }] };
  await T.tryPlayFromNode(SONG_OK, 0, false);
  await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 0, "precondition: s1 (index 0) plays, nothing avoided");
  T.audio.onerror();
  for (let k = 0; k < 6; k++) await flushMicrotasks();
  assert.equal(T.getState().currentNodeIndex, 1, "a decode/media error still advances to the next mirror");
  assert.equal(T.isNodeAvoidable("s1"), false, "a source whose probe answered OK must NOT be avoided for 24h over a decode error");
  assert.equal(sandbox.localStorage.getItem("webdav_player_node_health_v1"), null, "no health bits may be written when the probe confirms the origin is alive");
});

test("G3 onerror still marks when the probe confirms a non-2xx origin failure (regression shield against over-fix)", async () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" });
  const SONG_BAD = { id: "g3bad001", name: "Probe - Bad.mp3", availableNodes: [{ sourceId: "s1", href: "a.mp3" }, { sourceId: "s2", href: "b.mp3" }] };
  await T.tryPlayFromNode(SONG_BAD, 0, false);
  await flushMicrotasks();
  T.audio.onerror();
  for (let k = 0; k < 6; k++) await flushMicrotasks();
  assert.equal(T.isNodeAvoidable("s1"), true, "a probe that reports a non-2xx origin failure must still mark the node bad");
});

test("G3 onerror still marks when the probe fetch itself throws / network down (regression shield)", async () => {
  const { T, sandbox } = runClient(extractClientScript());
  sandbox.fetch = async () => { throw new Error("net-down"); };
  const SONG_THROW = { id: "g3thr001", name: "Probe - Throw.mp3", availableNodes: [{ sourceId: "s1", href: "a.mp3" }, { sourceId: "s2", href: "b.mp3" }] };
  await T.tryPlayFromNode(SONG_THROW, 0, false);
  await flushMicrotasks();
  T.audio.onerror();
  for (let k = 0; k < 6; k++) await flushMicrotasks();
  assert.equal(T.isNodeAvoidable("s1"), true, "a probe that throws must be treated as an origin failure and mark the node bad");
});
