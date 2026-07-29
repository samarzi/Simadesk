/**
 * Edge TTS — Microsoft Neural voices via server-side proxy.
 *
 * Browser → Supabase Edge Function → Microsoft speech.platform.bing.com WebSocket
 *
 * Direct browser WebSocket to Microsoft is blocked (Origin header check).
 * The proxy function runs server-side (Deno), which has no such restriction.
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
let _abortCtrl: AbortController | null = null;

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
  _abortCtrl?.abort();
  _abortCtrl = null;
  try { _source?.stop(); } catch {}
  _source = null;
  if (_audio) { _audio.pause(); _audio.src = ''; _audio = null; }
}

export async function edgeTtsSpeak(
  text: string,
  onEnd?: () => void,
  rateMultiplier = 1.0,
  voice = 'ru-RU-SvetlanaNeural',
): Promise<void> {
  edgeTtsStop();

  const ctrl = new AbortController();
  _abortCtrl = ctrl;
  // Dynamic timeout: at least 8s, +1s per 100 chars of text
  const timeoutMs = Math.min(30_000, 8_000 + Math.ceil(text.length / 100) * 1_000);
  const timeoutId = setTimeout(() => ctrl.abort(), timeoutMs);

  const token = (typeof localStorage !== 'undefined' && localStorage.getItem('access_token')) || API_KEY;
  let res: Response;
  try {
    res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': API_KEY,
      },
      body: JSON.stringify({ text, voice, rate: toRate(rateMultiplier) }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res!.ok) {
    throw new Error(`TTS proxy ${res!.status}`);
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error('TTS proxy: empty audio');

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
    src.onended = () => { _source = null; onEnd?.(); };
    src.start();
    return;
  } catch { /* fall through to HTML Audio */ }

  // Fallback: HTML Audio element
  try {
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const url  = URL.createObjectURL(blob);
    const a    = new Audio(url);
    _audio = a;
    a.onended = () => { URL.revokeObjectURL(url); _audio = null; onEnd?.(); };
    a.onerror = () => { URL.revokeObjectURL(url); _audio = null; onEnd?.(); };
    await a.play();
  } catch { onEnd?.(); }
}
