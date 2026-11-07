/* Beam custom Web Receiver (CAF v3) with its own on-screen display. */
const NS = 'urn:x-cast:dev.nino.beam';
const context = cast.framework.CastReceiverContext.getInstance();
const player = context.getPlayerManager();
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const video = $('video');
const body = document.body;

// Use our own <video> instead of <cast-media-player>, so we draw the whole UI ourselves.
player.setMediaElement(video);

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  stop: 'M6 6h12v12H6z',
};

// ---------------------------------------------------------------- idle screen
function tick() { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
tick(); setInterval(tick, 10000);
const showIdle = (hint) => { if (hint) $('hint').textContent = hint; $('idle').classList.remove('hidden'); hud(false); };
const hideIdle = () => $('idle').classList.add('hidden');

let toastTimer;
function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

// ---------------------------------------------------------------- HUD
let hudTimer;
/** Show the HUD; auto-hide after `ms` unless paused/buffering. */
function hud(on, ms = 4000) {
  clearTimeout(hudTimer);
  body.classList.toggle('hud-on', on);
  if (on && ms > 0) hudTimer = setTimeout(() => { if (!video.paused && !body.classList.contains('buffering')) hud(false); }, ms);
}

function flash(icon) {
  $('flashIcon').setAttribute('d', ICONS[icon]);
  const f = $('flash'); f.classList.add('show');
  setTimeout(() => f.classList.remove('show'), 700);
}

function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}

function setMeta(media, beam) {
  const md = (media && media.metadata) || {};
  $('title').textContent = md.title || 'Now playing';
  $('subtitle').textContent = [beam && beam.host, md.subtitle && md.subtitle !== (beam && beam.host) ? md.subtitle : null]
    .filter(Boolean).join('  ·  ');
  const img = md.images && md.images[0] && md.images[0].url;
  const art = $('art');
  art.classList.toggle('has', !!img);
  art.style.backgroundImage = img ? `url("${img}")` : '';
  const live = media && media.streamType === 'LIVE';
  body.classList.toggle('live', !!live);
  const chips = [];
  if (live) chips.push('<span class="chip live">Live</span>');
  if (beam && beam.quality) chips.push(`<span class="chip q">${beam.quality}</span>`);
  $('chips').innerHTML = chips.join('');
}

function setState() {
  const s = $('state');
  if (body.classList.contains('buffering')) s.innerHTML = 'Buffering…';
  else if (video.paused) s.innerHTML = `<svg viewBox="0 0 24 24"><path fill="#9AA0AD" d="${ICONS.pause}"/></svg>Paused`;
  else s.innerHTML = '';
}

function updateBar() {
  const dur = player.getDurationSec() || video.duration;
  const pos = player.getCurrentTimeSec();
  if (isFinite(dur) && dur > 0) {
    $('played').style.width = (100 * Math.min(pos / dur, 1)) + '%';
    let buf = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 1) buf = Math.max(buf, video.buffered.end(i));
    }
    // Map media-element time onto the player's timeline (they can differ for HLS with offsets).
    const offset = pos - video.currentTime;
    $('buffered').style.width = (100 * Math.min((buf + offset) / dur, 1)) + '%';
    $('pos').textContent = fmt(pos);
    $('dur').textContent = fmt(dur);
    const ends = new Date(Date.now() + (dur - pos) * 1000);
    $('ends').textContent = 'Ends at ' + ends.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
setInterval(() => { if (body.classList.contains('hud-on')) updateBar(); }, 250);

// ---------------------------------------------------------------- subtitles (live timing + style)
const sub = { url: null, cues: [], offset: 0, lastHtml: '' };
let style = { scale: 1, color: '#FFFFFF', bg: 0, outline: true, bottom: 8 };

function applyStyle() {
  const el = $('subs');
  el.style.fontSize = (4.4 * (style.scale || 1)) + 'vh';
  el.style.color = style.color || '#fff';
  document.documentElement.style.setProperty('--sub-bottom', (style.bottom ?? 8) + '%');
  el.style.bottom = '';
  el.style.textShadow = style.outline ? '0 0 6px #000, 0 2px 3px #000' : 'none';
  sub.lastHtml = '';
}

function parseTime(s) {
  const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  return m ? ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0').slice(0, 3) : null;
}
function parseVtt(text) {
  const out = [];
  text.replace(/\r/g, '').split(/\n\s*\n/).forEach(block => {
    const lines = block.split('\n'); const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) return;
    const [a, b] = lines[i].split('-->'); const s = parseTime(a), e = parseTime(b || '');
    if (s != null && e != null) out.push({ s, e, text: lines.slice(i + 1).join('\n').trim() });
  });
  return out.sort((x, y) => x.s - y.s);
}
const safe = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>');

async function setSub(s) {
  if (!s || !s.url) { sub.url = null; sub.cues = []; renderSubs(true); return; }
  sub.offset = s.offsetMs || 0;
  if (s.url === sub.url) return;
  try {
    const r = await fetch(s.url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    sub.cues = parseVtt(await r.text()); sub.url = s.url;
    toast('Subtitles: ' + (s.label || 'on'));
  } catch (e) { sub.cues = []; sub.url = null; report('Subtitle fetch failed: ' + e.message); }
}
function renderSubs(force) {
  let html = '';
  if (sub.cues.length) {
    const t = player.getCurrentTimeSec() * 1000 - sub.offset;
    html = sub.cues.filter(c => c.s <= t && t < c.e)
      .map(c => `<span class="line" style="background:rgba(0,0,0,${style.bg || 0})">${safe(c.text)}</span>`).join('<br>');
  }
  if (force || html !== sub.lastHtml) { $('subs').innerHTML = html; sub.lastHtml = html; }
}
(function loop() { renderSubs(false); requestAnimationFrame(loop); })();

// ---------------------------------------------------------------- phone messages
context.addCustomMessageListener(NS, (event) => {
  const d = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  if (d.type === 'sub') setSub(d.sub);
  else if (d.type === 'offset') { sub.offset = d.ms || 0; toast(`Subtitle timing ${(sub.offset / 1000).toFixed(1)}s`); }
  else if (d.type === 'style') { style = d.style || style; applyStyle(); }
});

function report(detail) {
  console.warn('[beam]', detail);
  toast(detail, true);
  try { context.sendCustomMessage(NS, undefined, { type: 'error', detail }); } catch (e) {}
}

// ---------------------------------------------------------------- player events
player.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (req) => {
  const beam = req.customData && req.customData.beam;
  if (beam && beam.style) { style = beam.style; applyStyle(); }
  setSub(beam ? beam.sub || null : null);
  setMeta(req.media, beam);
  showIdle('Loading ' + ((req.media.metadata && req.media.metadata.title) || 'video') + '…');
  return req;
});

const E = cast.framework.events.EventType;
player.addEventListener(E.PLAYER_LOAD_COMPLETE, () => { hideIdle(); updateBar(); hud(true, 6000); });
player.addEventListener(E.PLAYING, () => { hideIdle(); body.classList.remove('buffering'); setState(); });
player.addEventListener(E.PLAY, () => { flash('play'); setState(); hud(true, 2500); });
player.addEventListener(E.PAUSE, () => { flash('pause'); setState(); updateBar(); hud(true, 0); });
player.addEventListener(E.SEEKING, () => { updateBar(); hud(true, 4000); });
player.addEventListener(E.SEEKED, () => { updateBar(); hud(true, 3000); });
player.addEventListener(E.BUFFERING, (e) => {
  body.classList.toggle('buffering', !!e.isBuffering);
  setState();
  if (e.isBuffering) hud(true, 0); else hud(true, 2000);
});
player.addEventListener(E.MEDIA_FINISHED, () => { setSub(null); body.classList.remove('buffering'); showIdle('Finished. Pick another video on your phone.'); });
player.addEventListener(E.ERROR, (e) => {
  const code = e.detailedErrorCode;
  const map = {
    104: 'Load failed', 110: 'Media element error', 200: 'Generic error',
    311: 'Segment network error', 312: 'Segment fetch failed', 313: 'Manifest network error',
    314: 'Manifest fetch failed', 315: 'Playlist error', 321: 'HLS segment parse error',
    322: 'DASH manifest error', 411: 'HLS network error', 412: 'HLS manifest invalid',
    420: 'Source buffer error', 421: 'Media keys / DRM error',
  };
  report(`${map[code] || 'Playback error'} (${code ?? '?'})`);
  body.classList.remove('buffering');
  showIdle('Something went wrong. Check your phone for details.');
});

// ---------------------------------------------------------------- start
const playbackConfig = new cast.framework.PlaybackConfig();
playbackConfig.autoResumeDuration = 4;
playbackConfig.autoResumeNumberOfSegments = 2;
playbackConfig.initialBandwidth = 6_000_000;
playbackConfig.manifestRequestHandler = (r) => { r.withCredentials = false; };
playbackConfig.segmentRequestHandler = (r) => { r.withCredentials = false; };

if (params.has('debug')) context.setLoggerLevel(cast.framework.LoggerLevel.DEBUG);

context.start({
  customNamespaces: { [NS]: cast.framework.system.MessageType.JSON },
  playbackConfig,
  supportedCommands: cast.framework.messages.Command.ALL_BASIC_MEDIA,
  // Shaka handles fMP4/muxed HLS (and TS via its transmuxer); ?mpl=1 falls back to the legacy player.
  useShakaForHls: params.get('mpl') !== '1',
  maxInactivity: 3600,
  disableIdleTimeout: false,
});
applyStyle();
