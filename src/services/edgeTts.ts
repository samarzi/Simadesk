/**
 * Edge TTS — Microsoft Neural voices via server-side proxy.
 *
 * Browser → Supabase Edge Function → Microsoft speech.platform.bing.com WebSocket
 *
 * Direct browser WebSocket to Microsoft is blocked (Origin header check).
 * The proxy function runs server-side (Deno), which has no such restriction.
 *
 * Синтез и воспроизведение разделены намеренно: потоковая озвучка (ttsStream)
 * синтезирует следующую фразу, пока звучит текущая, поэтому ей нужен доступ
 * к этим шагам по отдельности.
 */

const PROXY_URL = `${(import.meta as any).env?.VITE_API_URL ?? ''}/functions/v1/tts-edge`;
const API_KEY   = (import.meta as any).env?.VITE_API_KEY ?? '';

// Converts TTS rate multiplier (1.0 = normal) to SSML prosody rate string
function toRate(mult: number): string {
  const pct = Math.round((mult - 1) * 100);
  return (pct >= 0 ? '+' : '') + pct + '%';
}

let _audioCtx: AudioContext | null = null;
let _source: AudioBufferSourceNode | null = null;
let _audio: HTMLAudioElement | null = null;

/**
 * Поколение озвучки. Любой stop() увеличивает счётчик, и все операции,
 * начатые в прошлом поколении, тихо завершаются — так очередь фраз не
 * «догоняет» пользователя звуком после того, как он нажал стоп.
 */
let _generation = 0;
const _inflight = new Set<AbortController>();

export function edgeTtsGeneration(): number { return _generation; }

/** Call synchronously inside a user-gesture handler to unlock AudioContext.
 *  Chrome blocks AudioContext created outside a user gesture.
 */
export function edgeTtsUnlock(): void {
  try {
    if (!_audioCtx || _audioCtx.state === 'closed') {
      _audioCtx = new AudioContext();
    }
    if (_audioCtx.state === 'suspended') {
      _audioCtx.resume().catch(() => {});
    }
  } catch { /* ignore */ }
}

export function edgeTtsStop(): void {
  _generation++;
  for (const c of _inflight) { try { c.abort(); } catch { /* ignore */ } }
  _inflight.clear();
  try { _source?.stop(); } catch { /* ignore */ }
  _source = null;
  if (_audio) { _audio.pause(); _audio.src = ''; _audio = null; }
}

/** Синтезировать речь и вернуть MP3, ничего не проигрывая. */
export async function edgeTtsSynthesize(
  text: string,
  rateMultiplier = 1.0,
  voice = 'ru-RU-SvetlanaNeural',
): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  _inflight.add(ctrl);
  // Dynamic timeout: at least 8s, +1s per 100 chars of text
  const timeoutMs = Math.min(30_000, 8_000 + Math.ceil(text.length / 100) * 1_000);
  const timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);

  const token = (typeof localStorage !== 'undefined' && localStorage.getItem('access_token')) || API_KEY;
  try {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': API_KEY,
      },
      body: JSON.stringify({ text, voice, rate: toRate(rateMultiplier) }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`TTS proxy ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error('TTS proxy: empty audio');
    return buf;
  } finally {
    clearTimeout(timeoutId);
    _inflight.delete(ctrl);
  }
}

/** Проиграть готовый MP3. Промис резолвится, когда звук закончился. */
export function edgeTtsPlayBuffer(buf: ArrayBuffer): Promise<void> {
  return new Promise<void>((resolve) => { void _playMp3(buf, resolve); });
}

export async function edgeTtsSpeak(
  text: string,
  onEnd?: () => void,
  rateMultiplier = 1.0,
  voice = 'ru-RU-SvetlanaNeural',
): Promise<void> {
  edgeTtsStop();
  const gen = _generation;
  const buf = await edgeTtsSynthesize(text, rateMultiplier, voice);
  if (gen !== _generation) { onEnd?.(); return; }
  await _playMp3(buf, onEnd);
}

async function _playMp3(buf: ArrayBuffer, onEnd?: () => void): Promise<void> {
  // Try Web Audio API (unlocked by edgeTtsUnlock in user gesture)
  try {
    if (!_audioCtx || _audioCtx.state === 'closed') {
      _audioCtx = new AudioContext();
    }
    if (_audioCtx.state === 'suspended') {
      await _audioCtx.resume();
    }
    const ctx = _audioCtx;
    const audioBuffer = await ctx.decodeAudioData(buf.slice(0));
    const src = ctx.createBufferSource();
    _source = src;
    src.buffer = audioBuffer;
    src.connect(ctx.destination);
    src.onended = () => { if (_source === src) _source = null; onEnd?.(); };
    src.start();
    return;
  } catch { /* fall through to HTML Audio */ }

  // Fallback: HTML Audio element
  try {
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url  = URL.createObjectURL(blob);
    const a    = new Audio(url);
    _audio = a;
    a.onended = () => { URL.revokeObjectURL(url); if (_audio === a) _audio = null; onEnd?.(); };
    a.onerror = () => { URL.revokeObjectURL(url); if (_audio === a) _audio = null; onEnd?.(); };
    await a.play();
  } catch { onEnd?.(); }
}
