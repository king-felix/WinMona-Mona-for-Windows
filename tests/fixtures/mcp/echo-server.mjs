#!/usr/bin/env node
// A deliberately small MCP stdio server used by P17 scope tests.
//
// It speaks newline-delimited JSON-RPC on stdin/stdout, advertises one read-only
// tool, and never touches the network or the filesystem. It exists so Mona can
// prove health, tool discovery, enable/disable and redaction against a real
// handshake instead of a mocked one.

import { createInterface } from 'node:readline';

const serverInfo = { name: 'mona-fixture-echo', version: '1.0.0' };

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (message.method === undefined) return; // response to a server-initiated request
  if (message.id === undefined) return; // notification, no reply
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize':
      reply(message.id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo,
      });
      break;
    case 'ping':
      reply(message.id, {});
      break;
    case 'tools/list':
      reply(message.id, {
        tools: [
          {
            name: 'echo_text',
            description: 'Return the supplied text unchanged. Read-only fixture tool.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      });
      break;
    case 'tools/call': {
      const text = typeof params.arguments?.text === 'string' ? params.arguments.text : '';
      reply(message.id, { content: [{ type: 'text', text }] });
      break;
    }
    case 'resources/list':
      reply(message.id, { resources: [] });
      break;
    case 'prompts/list':
      reply(message.id, { prompts: [] });
      break;
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
