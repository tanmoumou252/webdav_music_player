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
      clipboard: { writeText() { return Promise.resolve(); } },
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
    "getState: () => ({ stallHeartbeat, stallRetries, pendingSeek, playToken, currentNodeIndex, currentSongRef, lastProgressTime, title: document.title, mediaMetadata: navigator.mediaSession ? navigator.mediaSession.metadata : null, siteTitle: window.__siteTitle })," +
    "audio, fireTimeUpdate: () => { const f = audio.ontimeupdate; if (f) f(); }," +
    "getTagAbort: () => tagAbort," +
    "readEmbeddedTags," +
    "tryPlayFromNode, startStallHeartbeat, stopStallHeartbeat, recoverPlayback, stallHeartbeatTick, startPlayback" +
    "};";
  runInNewContext(prelude + scriptText + hook, sandbox, { filename: "client.js" });
  return { T: sandbox.__T, timers, sandbox };
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
