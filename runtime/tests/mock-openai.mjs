#!/usr/bin/env node
/**
 * A minimal OpenAI-compatible chat-completions server for CI.
 *
 * It implements just enough for a DSH agent turn: `GET /v1/models`, and
 * `POST /v1/chat/completions` which — on the first call — asks for one
 * `root_shell` tool call, and on the second call (once the tool result is in
 * the history) answers with plain text. That proves the whole chain: DSH
 * boots, the provider route configured from the app's settings is used, the
 * Parakeet root tool is registered and callable, and its output comes back
 * into the conversation.
 *
 * Usage: mock-openai.mjs <port> [tool-name] [tool-args-json]
 */
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 0);
const toolName = process.argv[3] ?? 'root_shell';
const toolArgs = process.argv[4] ?? JSON.stringify({ description: 'check the uid', command: 'id' });

const MODEL = 'mock-model';
let calls = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
    const json = (obj) => {
      if (body.stream && obj.choices) return sse(obj);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    // Streaming form of a completed response: one delta chunk carrying the
    // whole message, then a finish chunk with usage, then [DONE].
    const sse = (obj) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const { message, finish_reason } = obj.choices[0];
      const delta = { role: 'assistant' };
      if (message.content) delta.content = message.content;
      if (message.tool_calls) delta.tool_calls = message.tool_calls.map((t, index) => ({ index, ...t }));
      const head = { id: obj.id, object: 'chat.completion.chunk', created: obj.created, model: obj.model };
      res.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason }], usage: obj.usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    if (req.url.startsWith('/v1/models') || req.url === '/models') {
      return json({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'mock' }] });
    }
    if (!req.url.includes('chat/completions')) {
      res.writeHead(404).end('not found');
      return;
    }
    calls += 1;
    const sawToolResult = (body.messages ?? []).some((m) => m.role === 'tool');
    const offersTool = (body.tools ?? []).some((t) => t.function?.name === toolName);
    process.stderr.write(`mock: call ${calls} tools=${(body.tools ?? []).length} offers_${toolName}=${offersTool} saw_tool_result=${sawToolResult}\n`);
    const base = { id: `chatcmpl-${calls}`, object: 'chat.completion', created: Math.floor(Date.now() / 1e3), model: MODEL };
    if (!sawToolResult && offersTool) {
      return json({
        ...base,
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: toolName, arguments: toolArgs } }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    const toolOutput = (body.messages ?? []).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    return json({
      ...base,
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: `TOOL_SAW: ${toolOutput.replace(/\s+/g, ' ').slice(0, 400)}` },
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`);
});
