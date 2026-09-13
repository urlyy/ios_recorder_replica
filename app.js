// Local audio only. Change src to another file in this directory when needed.
// `time` (status-bar clock), `date` and `duration` are display text only:
// leave `duration` empty to derive it from the decoded audio metadata instead.
const RECORDING = {
  src: 'record/主要是想邀请您.m4a',
  time: '12:34',
  title: '电话录音',
  date: '2026年1月14日',
  duration: '5:14',
  transcript: '',
};

// Replace with your own repository link. Used only by the floating helper bar,
// which sits outside the iOS replica and auto-hides so it stays out of recordings.
const GITHUB_URL = 'https://github.com/urlyy/ios_recorder_replica';

const audio = document.querySelector('#audio');
const canvas = document.querySelector('#waveform');
const ctx = canvas.getContext('2d');
const play = document.querySelector('#play');
const back = document.querySelector('#back');
const forward = document.querySelector('#forward');
const error = document.querySelector('#error');
const elapsed = document.querySelector('#elapsed');
const total = document.querySelector('#duration');
const statusTime = document.querySelector('#status-time');
const pixelsPerSecond = 100;
const peaksPerSecond = 25;
const waveformColor = '#080808';
let peaks = new Float32Array(0);
let peakScale = 1;
let duration = 0;
let frame = 0;
let audioURL = '';
let loading = false;

function format(value, precise = false) {
  const seconds = Number.isFinite(value) ? Math.max(0, value) : 0;
  const showHours = seconds >= 3600 || (precise && duration >= 3600);
  const totalMinutes = Math.floor(seconds / 60);
  const minutes = String(showHours ? totalMinutes % 60 : totalMinutes);
  const prefix = showHours ? `${Math.floor(seconds / 3600)}:` : '';
  const time = `${prefix}${precise || showHours ? minutes.padStart(2, '0') : minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return precise ? `${time}.${String(Math.floor(seconds % 1 * 100)).padStart(2, '0')}` : time;
}

// Status-bar clock: start from RECORDING.time and advance in lockstep with the
// playback position, so the 24-hour clock ticks forward as the recording plays.
const clockBase = (() => {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(RECORDING.time || '');
  return match ? (Number(match[1]) % 24) * 3600 + Number(match[2]) * 60 : null;
})();

function updateStatusClock() {
  if (clockBase === null) {
    statusTime.textContent = RECORDING.time;
    return;
  }
  const nowSecs = Math.floor(clockBase + (audio.currentTime || 0)) % 86400;
  const hh = Math.floor(nowSecs / 3600);
  const mm = Math.floor((nowSecs % 3600) / 60);
  statusTime.textContent = `${hh}:${String(mm).padStart(2, '0')}`;
}

// One amplitude envelope for all decoded channels; no generated or random bars.
async function generateWaveform(arrayBuffer) {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) throw new Error('Web Audio is unavailable');
  const context = new AudioContextClass();
  try {
    const buffer = await context.decodeAudioData(arrayBuffer);
    const count = Math.max(1, Math.ceil(buffer.duration * peaksPerSecond));
    const samples = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    const result = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * buffer.length / count);
      const end = Math.floor((i + 1) * buffer.length / count);
      let peak = 0;
      for (const channel of samples) {
        for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(channel[j]));
      }
      result[i] = peak;
      if (i > 0 && i % 2048 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return result;
  } finally {
    await context.close();
  }
}

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  if (!width || !height) return;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const waveHeight = height - 28;
  const center = waveHeight / 2;
  const current = audio.currentTime || 0;
  const leftTime = current - width / 2 / pixelsPerSecond;
  const rightTime = current + width / 2 / pixelsPerSecond;
  const recordingStart = duration ? Math.max(0, width / 2 - current * pixelsPerSecond) : 0;
  const recordingEnd = duration ? Math.min(width, width / 2 + (duration - current) * pixelsPerSecond) : width;
  ctx.fillStyle = '#f4f4f6';
  ctx.fillRect(recordingStart, 0, recordingEnd - recordingStart, waveHeight);
  if (!peaks.length) {
    ctx.fillStyle = '#e6e6e9';
    ctx.fillRect(0, center, width, 1 / ratio);
  }
  for (let i = Math.max(0, Math.floor(leftTime * peaksPerSecond)); i < peaks.length; i++) {
    const time = i / peaksPerSecond;
    const x = Math.round((width / 2 + (time - current) * pixelsPerSecond) * ratio) / ratio;
    if (x > width) break;
    const amplitude = Math.max(1, Math.min(1, peaks[i] * peakScale) * waveHeight * .64);
    ctx.fillStyle = waveformColor;
    ctx.fillRect(x, center - amplitude / 2, 1, amplitude);
  }
  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  // Clip labels to the canvas so a time entering from either edge is revealed
  // sliver by sliver as it scrolls in, instead of popping in at full width.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, waveHeight, width, height - waveHeight);
  ctx.clip();
  for (let quarter = Math.floor(leftTime * 4); quarter <= Math.ceil(rightTime * 4); quarter++) {
    const second = quarter / 4;
    const x = width / 2 + (second - current) * pixelsPerSecond;
    const major = quarter % 4 === 0;
    ctx.fillStyle = '#e9e9eb';
    ctx.fillRect(x, waveHeight, 1, major ? 10 : 5);
    if (major && second >= 0) {
      ctx.fillStyle = '#c4c4c8';
      ctx.fillText(format(second), x, height - 6);
    }
  }
  ctx.restore();
  elapsed.textContent = format(current, true);
  updateStatusClock();
}

function tick() {
  draw();
  if (!audio.paused) frame = requestAnimationFrame(tick);
}

function renderPlay() {
  const running = !audio.paused;
  document.querySelector('.screen').classList.toggle('is-playing', running);
  play.disabled = loading || !duration || !!audio.error;
  back.disabled = forward.disabled = play.disabled;
  const label = running ? '暂停' : '播放';
  const icon = lucide.createElement(running ? lucide.Pause : lucide.Play);
  icon.classList.add(running ? 'pause-icon' : 'play-icon');
  icon.setAttribute('aria-hidden', 'true');
  play.replaceChildren(icon);
  play.setAttribute('aria-label', label);
  play.title = error.textContent || label;
  cancelAnimationFrame(frame);
  if (!audio.paused) tick();
  else draw();
}

async function togglePlayback() {
  if (loading || !duration || audio.error) return;
  if (!audio.paused) return audio.pause();
  try {
    await audio.play();
    error.textContent = '';
  } catch {
    error.textContent = '无法播放此音频';
    renderPlay();
  }
}

play.addEventListener('click', togglePlayback);

// Skip 15 seconds back/forward, clamped to the recording bounds like iOS.
function skip(seconds) {
  if (loading || !duration || audio.error) return;
  seekTo((audio.currentTime || 0) + seconds);
}
back.addEventListener('click', () => skip(-15));
forward.addEventListener('click', () => skip(15));

// Drag the waveform left/right to scrub. The playhead stays centered, so
// dragging right reveals earlier audio (time decreases) and left advances it.
let dragging = false;
let dragStartX = 0;
let dragStartTime = 0;
let resumeAfterDrag = false;

function seekTo(time) {
  const clamped = Math.max(0, Math.min(duration, time));
  audio.currentTime = clamped;
  draw();
}

canvas.addEventListener('pointerdown', event => {
  if (loading || !duration || audio.error) return;
  dragging = true;
  dragStartX = event.clientX;
  dragStartTime = audio.currentTime || 0;
  resumeAfterDrag = !audio.paused;
  if (resumeAfterDrag) audio.pause();
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('is-scrubbing');
});

canvas.addEventListener('pointermove', event => {
  if (!dragging) return;
  const deltaSeconds = (event.clientX - dragStartX) / pixelsPerSecond;
  seekTo(dragStartTime - deltaSeconds);
});

function endDrag(event) {
  if (!dragging) return;
  dragging = false;
  canvas.classList.remove('is-scrubbing');
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (resumeAfterDrag && duration && !audio.error) audio.play().catch(() => renderPlay());
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);


for (const event of ['play', 'pause', 'ended']) audio.addEventListener(event, renderPlay);
audio.addEventListener('timeupdate', draw);
audio.addEventListener('seeked', draw);
audio.addEventListener('loadedmetadata', () => {
  duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  // The displayed total time is either the configured text or derived from metadata.
  if (!RECORDING.duration) total.textContent = format(duration);
  renderPlay();
});
audio.addEventListener('error', () => {
  error.textContent = '未能读取录音';
  duration = 0;
  audio.pause();
  renderPlay();
});

async function loadRecording(blob) {
  if (loading) return false;
  loading = true;
  error.textContent = '';
  renderPlay();
  let audioBlob = blob;
  try {
    if (!audioBlob) {
      const response = await fetch(RECORDING.src, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Audio HTTP ${response.status}`);
      audioBlob = await response.blob();
    }
    // A local object URL supports seeking even on static servers without Range.
    const previousURL = audioURL;
    audioURL = URL.createObjectURL(audioBlob);
    peaks = new Float32Array(0);
    peakScale = 1;
    duration = 0;
    audio.pause();
    audio.currentTime = 0;
    audio.src = audioURL;
    audio.load();
    if (previousURL) URL.revokeObjectURL(previousURL);
  } catch {
    error.textContent = blob ? '无法读取所选音频' : '未找到本地音频文件';
    loading = false;
    renderPlay();
    return false;
  }
  try {
    peaks = await generateWaveform(await audioBlob.arrayBuffer());
    const sorted = Float32Array.from(peaks).sort();
    const referencePeak = sorted[Math.floor((sorted.length - 1) * .98)];
    peakScale = referencePeak > 0 ? 1 / referencePeak : 1;
    error.textContent = '';
    play.title = '播放';
  } catch {
    error.textContent = '无法解码音频波形';
  } finally {
    loading = false;
    renderPlay();
  }
  return !audio.error;
}

// The page uses the system font stack, so non-Apple devices without PingFang
// SC fall back to their own fonts. Show a self-dismissing hint only then.
function notifyFontFallback() {
  const ready = document.fonts && document.fonts.check
    ? Promise.resolve(document.fonts.ready).then(() => document.fonts.check('16px "PingFang SC"'))
    : Promise.resolve(true);
  ready.then(hasPingFang => {
    if (hasPingFang) return;
    const toast = document.createElement('div');
    toast.className = 'font-hint';
    toast.setAttribute('role', 'status');
    toast.textContent = '当前设备缺少苹方字体，已回退到系统字体，字形可能与 iOS 略有差异。';
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    setTimeout(() => {
      toast.classList.remove('is-visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 4500);
  });
}

// Floating helper bar: repo link + local upload. It lives outside the iOS
// replica and auto-hides after a few seconds so screen recordings stay clean.
function setupHelperBar() {
  const bar = document.querySelector('[data-helper]');
  const repo = document.querySelector('#repo-link');
  const upload = document.querySelector('#upload');
  const file = document.querySelector('#file');
  const dismiss = document.querySelector('#dismiss');
  repo.href = GITHUB_URL;
  let hideTimer = 0;
  // Hidden for the rest of this session; a refresh brings the bar back since
  // nothing is persisted.
  let dismissed = false;
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => bar.classList.remove('is-visible'), 2000);
  };
  const reveal = () => {
    if (dismissed) return;
    bar.classList.add('is-visible');
    scheduleHide();
  };
  reveal();
  // Only movement reveals the bar; clicks/taps/keys must not summon it.
  window.addEventListener('pointermove', reveal, { passive: true });
  bar.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  bar.addEventListener('pointerleave', scheduleHide);
  dismiss.addEventListener('click', () => {
    dismissed = true;
    clearTimeout(hideTimer);
    bar.classList.remove('is-visible');
  });
  upload.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const picked = file.files && file.files[0];
    if (!picked) return;
    // The file never leaves the browser; it is read via an in-memory object URL.
    // Only the audio is swapped — the title, date and other text stay unchanged.
    await loadRecording(picked);
    file.value = '';
    reveal();
  });
}

new ResizeObserver(draw).observe(canvas);
updateStatusClock();
document.querySelector('#title').textContent = RECORDING.title;
document.querySelector('#date').textContent = RECORDING.date;
total.textContent = RECORDING.duration || format(0);
lucide.createIcons();
draw();
loadRecording();
notifyFontFallback();
setupHelperBar();
window.generateWaveform = generateWaveform;
window.addEventListener('pagehide', event => {
  if (!event.persisted && audioURL) URL.revokeObjectURL(audioURL);
});
