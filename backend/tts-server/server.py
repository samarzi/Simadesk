"""
Minimal Edge TTS HTTP server.
POST /synthesize  { "text": "...", "voice": "ru-RU-SvetlanaNeural", "rate": "+0%" }
→ audio/mpeg binary
"""
import asyncio
import io
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import edge_tts

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass  # silence access log

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path != '/synthesize':
            self.send_response(404); self.end_headers(); return
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length) or b'{}')
        text  = str(body.get('text', ''))[:3000]
        voice = str(body.get('voice', 'ru-RU-SvetlanaNeural'))
        rate  = str(body.get('rate',  '+0%'))
        if not text.strip():
            self.send_response(400); self._cors(); self.end_headers(); return
        try:
            audio = asyncio.run(self._synth(text, voice, rate))
            self.send_response(200)
            self._cors()
            self.send_header('Content-Type', 'audio/mpeg')
            self.send_header('Content-Length', str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except Exception as e:
            self.send_response(502)
            self._cors()
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'content-type,authorization,apikey')
        self.send_header('Access-Control-Allow-Methods', 'POST,OPTIONS')

    @staticmethod
    async def _synth(text, voice, rate):
        buf = io.BytesIO()
        async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
            if chunk['type'] == 'audio':
                buf.write(chunk['data'])
        return buf.getvalue()

if __name__ == '__main__':
    print('TTS server on :8765')
    HTTPServer(('0.0.0.0', 8765), Handler).serve_forever()
