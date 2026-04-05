from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.error
import os

class handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = json.loads(self.rfile.read(length))

        messages = body.get('messages', [])
        model    = body.get('model', 'llama3-70b-8192')

        api_key = os.environ.get('GROQ_API_KEY', '')
        if not api_key:
            self._respond(500, {'error': 'GROQ_API_KEY non configurata'})
            return

        payload = json.dumps({
            'model':    model,
            'messages': messages,
            'max_tokens': 1024,
            'temperature': 0.7,
        }).encode()

        req = urllib.request.Request(
            'https://api.groq.com/openai/v1/chat/completions',
            data=payload,
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type':  'application/json',
            },
            method='POST'
        )

        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                content = data['choices'][0]['message']['content']
                self._respond(200, {'message': {'role': 'assistant', 'content': content}})
        except urllib.error.HTTPError as e:
            err = e.read().decode()
            self._respond(e.code, {'error': err})
        except Exception as e:
            self._respond(500, {'error': str(e)})

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _respond(self, code, data):
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, *args):
        pass
