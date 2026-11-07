/* Beam custom Web Receiver (CAF v3). */
const NS = 'urn:x-cast:dev.nino.beam';
const context = cast.framework.CastReceiverContext.getInstance();
const player = context.getPlayerManager();
const params = new URLSearchParams(location.search);

const $ = (id) => document.getElementById(id);
const subsEl = $('subs');
const idleEl = $('idle');

// ---------------------------------------------------------------- idle screen
function tick() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
tick(); setInterval(tick, 10000);
const showIdle = (hint) => { if (hint) $('hint').textContent = hint; idleEl.classList.remove('hidden'); };
const hideIdle = () => idleEl.classList.add('hidden');

let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
}

// ---------------------------------------------------------------- subtitles
const sub = { url: null, cues: [], offset: 0, lastHtml: '' };
let style = { scale: 1, color: '#FFFFFF', bg: 0, outline: true, bottom: 8 };

function applyStyle() {
  subsEl.style.fontSize = (4.4 * (style.scale || 1)) + 'vh';
  subsEl.style.color = style.color || '#fff';
  subsEl.style.bottom = (style.bottom ?? 8) + '%';
  subsEl.style.textShadow = style.outline ? '0 0 6px #000, 0 2px 3px #000' : 'none';
  subsEl.querySelectorAll('span.line').forEach(s => s.style.background = `rgba(0,0,0,${style.bg || 0})`);
  sub.lastHtml = '';
}

function parseTime(s) {
  const m = s.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0').slice(0, 3);
}

function parseVtt(text) {
  const out = [];
  text.replace(/\r/g, '').split(/\n\s*\n/).forEach(block => {
    const lines = block.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) return;
    const [a, b] = lines[i].split('-->');
    const s = parseTime(a), e = parseTime(b || '');
    if (s == null || e == null) return;
    out.push({ s, e, text: lines.slice(i + 1).join('\n').trim() });
  });
  return out.sort((x, y) => x.s - y.s);
}

function safe(t) {
  // Escape everything, then re-allow simple <i>, <b>, <u>.
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>');
}

async function setSub(s) {
  if (!s || !s.url) { sub.url = null; sub.cues = []; render(true); return; }
  sub.offset = s.offsetMs || 0;
  if (s.url === sub.url) return;
  try {
    const r = await fetch(s.url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    sub.cues = parseVtt(await r.text());
    sub.url = s.url;
    toast(`Subtitles: ${s.label || 'on'}`);
  } catch (e) {
    sub.cues = []; sub.url = null;
    report('Subtitle fetch failed: ' + e.message);
  }
}

function render(force) {
  let html = '';
  if (sub.cues.length) {
    const t = player.getCurrentTimeSec() * 1000 - sub.offset;
    const active = sub.cues.filter(c => c.s <= t && t < c.e);
    html = active.map(c => `<span class="line" style="background:rgba(0,0,0,${style.bg || 0})">${safe(c.text)}</span>`).join('<br>');
  }
  if (force || html !== sub.lastHtml) { subsEl.innerHTML = html; sub.lastHtml = html; }
}
(function loop() { render(false); requestAnimationFrame(loop); })();

// ---------------------------------------------------------------- messages from the phone
context.addCustomMessageListener(NS, (event) => {
  const d = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  switch (d.type) {
    case 'sub': setSub(d.sub); break;
    case 'offset': sub.offset = d.ms || 0; toast(`Subtitle timing ${(sub.offset / 1000).toFixed(1)}s`); break;
    case 'style': style = d.style || style; applyStyle(); break;
  }
});

function report(detail) {
  console.warn('[beam]', detail);
  toast(detail);
  try { context.sendCustomMessage(NS, undefined, { type: 'error', detail }); } catch (e) {}
}

// ---------------------------------------------------------------- player hooks
player.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, (req) => {
  const beam = req.customData && req.customData.beam;
  if (beam) {
    if (beam.style) { style = beam.style; applyStyle(); }
    setSub(beam.sub || null);
  } else setSub(null);
  showIdle('Loading…');
  return req;
});

const E = cast.framework.events.EventType;
player.addEventListener(E.PLAYER_LOAD_COMPLETE, () => hideIdle());
player.addEventListener(E.PLAYING, () => hideIdle());
player.addEventListener(E.MEDIA_FINISHED, () => { setSub(null); showIdle('Ready. Pick a video on your phone.'); });
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
  showIdle('Something went wrong. Check your phone for details.');
});

// ---------------------------------------------------------------- start
const playbackConfig = new cast.framework.PlaybackConfig();
playbackConfig.autoResumeDuration = 4;          // seconds buffered before resuming after a stall
playbackConfig.autoResumeNumberOfSegments = 2;
playbackConfig.initialBandwidth = 6_000_000;    // start at a decent quality on home Wi-Fi
playbackConfig.manifestRequestHandler = (r) => { r.withCredentials = false; };
playbackConfig.segmentRequestHandler = (r) => { r.withCredentials = false; };

if (params.has('debug')) context.setLoggerLevel(cast.framework.LoggerLevel.DEBUG);

context.start({
  customNamespaces: { [NS]: cast.framework.system.MessageType.JSON },
  playbackConfig,
  supportedCommands: cast.framework.messages.Command.ALL_BASIC_MEDIA,
  useShakaForHls: params.get('shaka') === '1',
  maxInactivity: 3600,
});
applyStyle();
