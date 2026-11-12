# Adapter contract fixtures

Shapes recorded from the pinned Codewhale 0.10.2 (ff466b2ed0bf) runtime during
P01/P03. Message text and workspace paths are normalized; field names, types,
and the snake_case wire form are preserved.

- `runtime-info.json` — `GET /v1/runtime/info` (capability flags, identity).
- `effective-config.json` — `GET /v1/config` (route, posture defaults).
- `thread.json` — `POST /v1/threads` / `GET /v1/threads/{id}` thread record.
- `turn-lookup.json` — `GET /v1/threads/{id}/turn-operations/{key}` turn record.
- `thread-usage-known.json` / `thread-usage-unknown.json` — priced and unpriced
  `GET /v1/threads/{id}/usage` totals. Unknown cost is never zero.
- `history.json` — `GET /v1/threads/{id}/history` projection (system prompt
  omitted on purpose; Mona never stores it).
- `events.jsonl` — durable event frames (snake_case) as received over SSE.
- `providers.json` — `GET /v1/providers` current route.

These are test data. The adapter tests parse them; the renderer never imports
them.
