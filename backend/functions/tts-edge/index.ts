/**
 * Edge TTS Proxy — Supabase Edge Function
 *
 * Proxies Microsoft Edge TTS WebSocket from the server side.
 * Browser WebSocket gets rejected by Microsoft (Origin check);
 * server-side Deno WebSocket has no such restriction.
 *
 * POST /functions/v1/tts-edge
 * Body: { text: string, voice?: string, rate?: string }
 * Response: audio/mpeg binary
 */

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TOKEN}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function uid(): string {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  let text = '', voice = 'ru-RU-SvetlanaNeural', rate = '+0%';
  try {
    const body = await req.json();
    text  = (body.text  ?? '').slice(0, 3000);
    voice = body.voice ?? voice;
    rate  = body.rate  ?? rate;
  } catch {
    return new Response(JSON.stringify({ error: 'bad_json' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  if (!text.trim()) {
    return new Response(JSON.stringify({ error: 'empty_text' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const connId = uid();
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'>` +
    `<voice name='${voice}'>` +
    `<prosody rate='${rate}' pitch='+0Hz'>${xmlEsc(text)}</prosody>` +
    `</voice></speak>`;

  try {
    const audioChunks: Uint8Array[] = [];

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${WS_URL}&ConnectionId=${connId}`);

      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('Edge TTS timeout'));
      }, 15_000);

      ws.onopen = () => {
        const reqId = uid();
        ws.send(
          `X-Timestamp:${new Date().toISOString()}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`
        );
        ws.send(
          `X-RequestId:${reqId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${new Date().toISOString()}\r\nPath:ssml\r\n\r\n${ssml}`
        );
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          if (ev.data.includes('Path:turn.end')) {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve();
          }
        } else {
          // Deno delivers binary as Blob or ArrayBuffer depending on ws.binaryType
          const processBuffer = (buf: ArrayBuffer) => {
            if (buf.byteLength > 2) {
              const headerLen = new DataView(buf).getUint16(0);
              const audioStart = 2 + headerLen;
              if (audioStart < buf.byteLength) {
                audioChunks.push(new Uint8Array(buf.slice(audioStart)));
              }
            }
          };

          if (ev.data instanceof ArrayBuffer) {
            processBuffer(ev.data);
          } else if (ev.data instanceof Blob) {
            ev.data.arrayBuffer().then(processBuffer);
          } else if (ev.data instanceof Uint8Array) {
            const b = ev.data.buffer.slice(ev.data.byteOffset, ev.data.byteOffset + ev.data.byteLength);
            processBuffer(b);
          }
        }
      };

      ws.onerror = () => { clearTimeout(timer); reject(new Error('WS error')); };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (ev.code !== 1000 && ev.code !== 1001) reject(new Error(`WS closed: ${ev.code}`));
      };
    });

    const total = audioChunks.reduce((s, c) => s + c.length, 0);
    if (total === 0) {
      return new Response(JSON.stringify({ error: 'no_audio' }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of audioChunks) { merged.set(c, off); off += c.length; }

    return new Response(merged, {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'audio/mpeg', 'Content-Length': String(merged.length), 'Cache-Control': 'no-store' },
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown';
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
});
