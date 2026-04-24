from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os, sys

class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Expose-Headers', 'Content-Length,Content-Range')
        super().end_headers()

os.chdir(os.path.expanduser('~/dev/heapdocs/dumps'))
ThreadingHTTPServer(('127.0.0.1', 10001), H).serve_forever()
