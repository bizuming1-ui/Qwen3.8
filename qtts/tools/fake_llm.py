#!/usr/bin/env python3
"""Loopback-only OpenAI-compatible SSE fixture for gateway chat testing.

Never used by the production start script and never claims to be DeepSeek.
"""
from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *_args):
        return

    def do_POST(self):  # noqa: N802
        if self.path != "/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(min(length, 1024 * 1024)))
            assert body["stream"] is True
            assert body["messages"][-1]["role"] == "user"
        except (ValueError, KeyError, AssertionError):
            self.send_error(400)
            return
        print(f"fake LLM received model={body.get('model')} messages={len(body['messages'])}", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        chunks = ["你好，", "今天过得怎么样？", "我们可以慢慢聊。"]
        for text in chunks:
            event = {"choices": [{"delta": {"content": text}, "finish_reason": None}]}
            self.wfile.write(("data: " + json.dumps(event, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()
        event = {"choices": [{"delta": {}, "finish_reason": "stop"}]}
        self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7123
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"fake LLM fixture on 127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
