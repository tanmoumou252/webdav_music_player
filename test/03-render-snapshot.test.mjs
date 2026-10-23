import "../runtime-lock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadParts } from "./helper/load-parts.mjs";

const { renderHTML } = loadParts();

function compactTemplate(text) {
  return text.replace(/\s+/g, " ").trim();
}

const GOLDEN_SHA256 = "5002adc25ea7bcb9a91d71726c2691d027e5af41e0cd73b9d78b53425242def0";
const GOLDEN_LENGTH = 121896;

test("Tier-3 renderHTML snapshot: golden length & sha256 master", () => {
  const html = renderHTML();
  assert.equal(html.length, GOLDEN_LENGTH, "HTML length drift");
  const sha = createHash("sha256").update(html, "utf8").digest("hex");
  assert.equal(sha, GOLDEN_SHA256, "HTML digest drift — template literal bytes must remain strictly identical");
});

test("Tier-3 renderHTML snapshot: structural anchors", () => {
  const html = renderHTML();
  assert.ok(html.startsWith("<!DOCTYPE html>"), "must start with DOCTYPE");
  assert.ok(html.endsWith("</html>"), "must end with </html> (no trailing newline in template literal return)");
  assert.ok(html.includes("<title>Cloud Music Hub</title>"), "default title must be present for /play= replacement");
  assert.ok(html.includes("<style>"), "inlined style must be present");
  assert.ok(html.includes(":root {"), "root vars must be present");
  assert.ok(html.includes("async function init() {"), "main app init present");
  assert.ok(html.includes('<svg style="display:none;">'), "symbol sprite present");
  assert.ok(html.includes('id="icon-play"'), "play icon symbol present");
  assert.ok(html.includes('id="icon-pause"'), "pause icon symbol present");
});

test("Tier-3 regression lock: template-cooked regex preserved verbatim", () => {
  const html = renderHTML();
  // 已知缺陷保留：renderHTML 外层模板内的 song.name.replace(/\.[^/.]+$/, "")，
  // 模板字符串求值把 \. cook 成 .，客户端拿到的是单点号正则。
  // 有意原样保留，不要顺手修：
  assert.ok(
    html.includes('song.name.replace(/.[^/.]+$/, "");'),
    "must contain the template-cooked single-dot regex"
  );
  assert.ok(
    !html.includes('song.name.replace(/\\.[^/.]+$/, "")'),
    "must NOT contain the un-cooked backslash variant — doing so means someone touched the template escaping"
  );
});

test("Tier-3 lock: client escapeHtml differs from server escapeHtmlText by design", () => {
  const html = renderHTML();
  assert.ok(html.includes("function escapeHtml(s) {"), "client escapeHtml function must be defined");
  assert.ok(html.includes("return String(s).replace(/&/g, '&amp;')"), "client escapeHtml implementation body");
  assert.ok(!html.includes("escapeHtmlText("), "server-only escapeHtmlText must never appear in client template");
});

test("Tier-3 mobile layout lock: no page scroll, dvh-capped cover, cover clears the floating buttons", () => {
  const html = renderHTML();
  const WIDE_ANCHOR = "@media (max-width: 768px)";
  const SHORT_ANCHOR = "@media (max-height: 560px)";
  const COMPACT_ANCHOR = "@media (max-width: 360px)";
  const wideIdx = html.indexOf(WIDE_ANCHOR);
  const shortIdx = html.indexOf(SHORT_ANCHOR);
  const compactIdx = html.indexOf(COMPACT_ANCHOR);
  assert.ok(wideIdx >= 0, "the wide-breakpoint media query must exist");
  assert.ok(shortIdx >= 0, "the short-breakpoint media query must exist");
  assert.ok(compactIdx >= 0, "the compact-breakpoint media query must exist");
  assert.ok(wideIdx < shortIdx && shortIdx < compactIdx, "media queries must appear in wide -> short -> compact order");
  const wide = html.slice(wideIdx, shortIdx);
  assert.ok(wide.includes("overflow: hidden"), "mobile stage must not scroll the page");
  assert.ok(wide.includes("justify-content: flex-start"), "flex-start keeps the cover below the floating buttons");
  assert.ok(wide.includes("height: min(72vw, 300px, 42dvh)"), "cover height must be capped by dvh");
  assert.ok(wide.includes("flex: 1 1 auto; min-height: 88px; height: auto"), "lyrics view must flex-shrink");
  assert.ok(!wide.includes("height: min(38vh, 300px)"), "the fixed 38vh lyrics height must be gone");
  const short = html.slice(shortIdx, compactIdx);
  assert.ok(short.includes("height: min(48dvh, 40vw, 240px)"), "short-viewport cover cap must exist");
  assert.ok(short.includes("overflow: hidden"), "short-viewport stage must not scroll either");

  const widePad = /\.stage \{ display: flex; flex-direction: column;[^}]*padding: (\d+)px/.exec(wide);
  const shortPad = /\.stage \{ display: flex; flex-direction: column;[^}]*padding: (\d+)px/.exec(short);
  assert.ok(widePad && shortPad, "mobile .stage padding must stay parseable");
  const BUTTON_ZONE = 16 + 38;
  assert.ok(
    Number(widePad[1]) > BUTTON_ZONE,
    "cover top edge must sit strictly below the floating buttons: " + widePad[1] + " > " + BUTTON_ZONE
  );
  assert.ok(
    Number(shortPad[1]) > BUTTON_ZONE,
    "short-viewport cover top edge must clear the buttons too: " + shortPad[1] + " > " + BUTTON_ZONE
  );
});

test("Tier-3 share head lock: anchor present, og tags injected not hardcoded", () => {
  const html = renderHTML();
  assert.ok(html.includes("<!--SHARE_HEAD-->"), "share head anchor must exist in the template");
  assert.ok(!html.includes("og:image"), "og tags must be injected per request, never hardcoded");
  assert.ok(html.includes('<audio id="audio" preload="auto"></audio>'), "audio element must carry preload=auto (buffer-ahead for slow overseas WebDAV origins)");
});

test("Tier-3 buffered-ranges lock: progress-buffered layer, renderer and progress wiring exist", () => {
  const html = renderHTML();
  assert.ok(html.includes('id="progress-buffered"'), "buffered layer div must exist inside progress-bar");
  assert.ok(html.includes("function renderBufferedRanges()"), "buffered renderer must exist");
  assert.ok(html.includes("audio.onprogress = renderBufferedRanges;"), "buffered renderer must be wired to onprogress");
  assert.ok(html.includes(".progress-buffered { position: absolute;"), "buffered layer CSS must exist");
  assert.ok(html.includes("renderBufferedRanges();"), "timeupdate must refresh the buffered layer");
});

test("Tier-3 source ordering lock: drag handle, state machine and CSS exist", () => {
  const html = renderHTML();
  assert.ok(html.includes("function beginDrag(e) {"), "drag state machine entry must be defined");
  assert.ok(html.includes("function resolveDropIndex(e) {"), "drop index resolver must be defined");
  assert.ok(html.includes("function finishDrag(e) {"), "drag finalizer must be defined");
  assert.ok(html.includes('class="drag-handle"'), "drag handle styling hook must exist");
  assert.ok(html.includes(".source-card.dragging { opacity: 0.45; }"), "dragging translucency CSS must exist");
  assert.ok(html.includes(".drag-indicator-line { height: 2px;"), "drop indicator CSS must exist");
  assert.ok(html.includes(".drag-handle { background: none; border: none; color: var(--sub); cursor: grab; padding: 4px; border-radius: 4px; display: flex; align-items: center; touch-action: none; -webkit-tap-highlight-color: transparent; }"), "touch-action: none is scoped to the handle only");
  assert.ok(html.includes('id="icon-drag-indicator"'), "drag indicator sprite must exist");
  assert.ok(!html.includes('class="move-btn"'), "move buttons must be removed (DEC-9: no coexistence)");
  assert.ok(!html.includes("function moveCard(btnEl, dir) {"), "the old mover must be gone");
  assert.ok(!html.includes('id="icon-chevron-up"'), "no chevron-up sprite may appear (legacy contract kept)");
});

test("Tier-3 playback resilience lock: heartbeat watchdog, resume and tag cache wired", () => {
  const html = renderHTML();
  assert.ok(html.includes("function recoverPlayback()"));
  assert.ok(html.includes("function stallHeartbeatTick()"));
  assert.ok(html.includes("stallHeartbeat = window.setInterval(stallHeartbeatTick, STALL_HEARTBEAT_MS);"));
  assert.ok(html.includes("if (!currentSongRef || userPaused || externallyPaused) return;"), "the heartbeat must no longer mute on waitingForGesture alone");
  assert.ok(!html.includes("userPaused || waitingForGesture || externallyPaused"), "the old waitingForGesture-muting guard must be gone");
  assert.ok(html.includes("if (waitingForGesture) { tryResumeGesture(); return; }"), "a gesture-pending watchdog must attempt one resume per heartbeat");
  assert.ok(html.includes("function tryResumeGesture()"), "the gesture-resume helper must exist");
  assert.ok(html.includes("audio.oncanplay = () => {"), "the buffered auto-resume wiring must exist");
  assert.ok(!html.includes("function armStallWatch"), "the event-armed watchdog must be fully replaced by the heartbeat");
  assert.ok(html.includes("waitingForGesture = true;"));
  assert.ok(html.includes("pendingSeek = lastKnownProgress(song);"));
  assert.ok(html.includes("const PROGRESS_STORE_KEY = 'webdav_player_progress_v1';"));
  assert.ok(html.includes("if (pendingSeek === null) pendingSeek = lastKnownProgress(song);"), "tryPlayFromNode:1415 backfill must stay — recoverPlayback:1740 next-mirror resume depends solely on it");
  assert.ok(html.includes("function startPlayback(song, nodeIndex = 0, syncUrl = true, isAuto = false, resume = false) {"), "startPlayback must carry the trailing resume param after isAuto (guards A-9 形参序漂移)");
  assert.ok(html.includes("forgetProgress(song);"), "the active-start (resume=false) branch must forget progress, not merely null pendingSeek");
  assert.ok(html.includes("function parseShareTime(raw) {"), "share-time parser must exist (t=1m30s contract)");
  assert.ok(html.includes("function formatShareTime(sec) {"), "share-time formatter must exist");
  assert.ok(html.includes("let pendingShareSeek = null;"), "the one-shot share seek slot must exist");
  assert.ok(html.includes("if (targetPlayId || legacySongName) pendingShareSeek = parseShareTime(urlParams.get('t'));"), "init must arm the share time only alongside a play target");
  assert.ok(html.includes("'&t=' + stamp"), "the copy path must embed the stamp");
  assert.ok(html.includes("let tagCache = new Map();"));
  assert.ok(html.includes("async function parseAndCacheTags(song, url, token)"));
  assert.ok(
    compactTemplate(html).includes("const tags = await readEmbeddedTags(url); if (tags) { if (tagCache.has(key)) { const discardedCoverUrl = tags.coverUrl; if (discardedCoverUrl) URL.revokeObjectURL(discardedCoverUrl); } else { tagCache.set(key, tags); } trimTagCache(key, songKey(currentSongRef)); } if (token !== playToken) return;"),
    "an existing tag-cache entry must win and an unused parsed cover blob must be released"
  );
  assert.ok(
    !compactTemplate(html).includes("if (tags) { tagCache.set(key, tags); trimTagCache(key, songKey(currentSongRef)); }"),
    "the unconditional tag-cache overwrite must stay gone"
  );
  assert.ok(
    compactTemplate(html).includes("renderTags(tagCache.get(key) || tags, song.name);"),
    "the current play must render the retained cache entry, never a discarded parse whose blob was revoked"
  );
  assert.ok(!html.includes("URL.revokeObjectURL(prevCover)"), "cover blob ownership must move to the tag cache");
  assert.ok(!html.includes("function parseTagsDirectly("), "the uncached tag parser must be gone");
});

test("Tier-3 all-nodes-failed lock: the exhausted branch stops the watchdog and clears recovery state", () => {
  const html = compactTemplate(renderHTML());
  assert.ok(
    html.includes("if (!song.availableNodes || nodeIndex >= song.availableNodes.length) { if (token !== playToken) return; stopStallHeartbeat(); stallRetries = 0; pendingSeek = null;"),
    "the all-nodes-exhausted branch must stop the stall heartbeat and clear retries/pendingSeek before reporting"
  );
  assert.ok(
    !html.includes("pendingSeek = null; stallRetries = 0;"),
    "the reset pair must never appear without stopStallHeartbeat() preceding it — a reordered or stop-less cleanup must not exist"
  );
});

test("Tier-3 progress-memory lock: key derives from currentSongRef, writes gated behind pendingSeek", () => {
  const html = renderHTML();
  assert.ok(html.includes("const rememberingKey = songKey(currentSongRef);"), "memory key must follow the actually-playing song");
  assert.ok(!html.includes("const rememberingKey = songKey(currentPlaylist[currentIndex]);"), "memory key must never be derived from the mutable playlist slot");
  assert.ok(html.includes("if (pendingSeek === null && isFinite(audio.currentTime)) {"), "memory writes must be skipped while a seek/load is pending");
  assert.ok(!html.includes("const key = songKey(currentPlaylist[currentIndex]);"), "pagehide must use the same ref-derived key");
  assert.ok(html.includes("const key = songKey(currentSongRef);"), "pagehide key must exist");
});

test("Tier-3 tag-cache trim lock: protected entries are skipped, never a hard return", () => {
  const html = renderHTML();
  assert.ok(html.includes("if (tagKey === keepKey || tagKey === shownKey) continue;"), "trim must skip protected keys and keep evicting");
  assert.ok(!html.includes("if (oldest === keepKey || oldest === shownKey) return;"), "the old hard-return trim must be gone");
  assert.ok(html.includes("trimTagCache(key, songKey(currentSongRef));"), "shown key must be ref-derived");
});

test("Tier-3 stale-play lock: an expired play rejection cannot set waitingForGesture", () => {
  const html = compactTemplate(renderHTML());
  assert.ok(html.includes("}).catch(err => { if (token !== playToken) return;"), "the play rejection handler must start with the token guard");
});

test("Tier-3 mirror-token lock: every node attempt allocates an independent token", () => {
  const html = compactTemplate(renderHTML());
  assert.ok(html.includes("async function tryPlayFromNode(song, nodeIndex, isAuto = false) { const token = ++playToken;"), "each mirror attempt must allocate a fresh token");
  assert.ok(!html.includes("async function tryPlayFromNode(song, nodeIndex, isAuto = false) { const token = playToken;"), "a mirror attempt must not reuse the song-level token");
});

test("Tier-3 stall-recovery lock: only genuine forward progress resets the retry budget", () => {
  const html = compactTemplate(renderHTML());
  assert.ok(
    html.includes("audio.ontimeupdate = () => { if (!audio.paused && pendingSeek === null && audio.readyState >= 3 && audio.currentTime > lastProgressTime) { lastProgressAt = Date.now(); stallRetries = 0; } lastProgressTime = audio.currentTime;"),
    "ontimeupdate must clear the retry budget only on playing, seek-settled, demuxed, advancing frames"
  );
  assert.ok(
    !html.includes("audio.ontimeupdate = () => { lastProgressTime = audio.currentTime; lastProgressAt = Date.now(); stallRetries = 0;"),
    "the unconditional timeupdate reset must be gone — it erased the failover budget on seek/reload timeupdates"
  );
  assert.ok(
    html.includes("if (audio.currentTime > lastProgressTime + 0.1) { lastProgressTime = audio.currentTime; lastProgressAt = Date.now(); return; }"),
    "the heartbeat forward-progress observation must remain byte-identical"
  );
});

test("Tier-3 lyrics-stale lock: a tag-cache miss clears lyrics before scheduling the parse", () => {
  const html = compactTemplate(renderHTML());
  assert.ok(
    html.includes("} else { renderLrc(''); pendingTag = { song: song, url: streamUrl, token: playToken }; }"),
    "the cache-miss branch must clear the previous song's lyrics before pendingTag is set"
  );
});

test("Tier-3 tag-read lock: jsmediatags reads by URL (Range-savvy partial fetches) with cancellation preserved", () => {
  const html = renderHTML();
  assert.ok(html.includes("const tagUrl = new URL(url, window.location.href).href;"), "Contract C-2: the stream URL must be absolutized so the library's URL reader (HTTP Range windows: ID3v2 head / ID3v1 tail / MP4 moov / FLAC VORBISID3) dispatches with correct absolute offsets");
  assert.ok(html.includes("jmt.read(tagUrl, {"), "Contract C-2: the library must receive the URL and fetch only the byte windows each format needs, never a materialized whole-file Blob");
  assert.ok(!html.includes("await fetch(url"), "the whole-file fetch of the tag path must be gone");
  assert.ok(!html.includes("res.blob()"), "the whole-file Blob materialization must be gone");
  assert.ok(!html.includes("'Range': 'bytes=0-524288'"), "the fixed head-only 512 KB Range cap must stay gone (the library negotiates its own ranges)");
  assert.ok(html.includes("tagAbort.signal.addEventListener('abort', cancelTagRead)"), "cancellation wiring: the abort signal must settle the read and best-effort abort the library reader (feature-detected)");
});

test("Tier-3 drag handle lock: icon-drag-indicator equals the official Material Symbols (MD3) code, not the stopped legacy npm glyph", () => {
  const html = renderHTML();
  const m = /<symbol id="icon-drag-indicator" viewBox="([^"]*)"><path d="([^"]+)"\/><\/symbol>/.exec(html);
  assert.ok(m, "drag-indicator symbol with a single path must exist");
  // 官方 Material Symbols drag_indicator（outlined 与 rounded 此 glyph 字节一致）取自
  // fonts.gstatic.com/s/i/short-term/release/materialsymbols{outlined,rounded}/drag_indicator/default/24px.svg
  assert.equal(m[1], "0 -960 960 960", "MD3 Material Symbols glyph must carry the 960 grid viewBox");
  const OFFICIAL_M3 = "M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z";
  const BROKEN_SCATTER = "M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z";
  assert.equal(m[2], OFFICIAL_M3, "the six-dot handle must be byte-equal to the official MD3 code");
  assert.notEqual(m[2], BROKEN_SCATTER, "the pre-fix 3+2+1 scatter glyph must never reappear");
});