export type RawSseFrame = {
  id?: string;
  event: string;
  data: string;
  retry?: number;
};

export type SsePushResult = {
  frames: RawSseFrame[];
  oversize: boolean;
};

/**
 * Incremental SSE decoder. Handles UTF-8 split across chunks, CRLF or LF frame
 * boundaries, comments, multi-line data, and an explicit frame-size cap. An
 * oversized frame is dropped and reported; the decoder keeps reading so one bad
 * frame cannot kill the stream.
 */
export class SseDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  private buffer = '';
  private discarding = false;
  private oversizedFrames = 0;

  constructor(private readonly maxFrameBytes = 1024 * 1024) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024) {
      throw new Error('maxFrameBytes must be an integer >= 1024');
    }
  }

  push(chunk: Uint8Array): SsePushResult {
    return this.consume(this.decoder.decode(chunk, { stream: true }));
  }

  finish(): SsePushResult {
    const tail = this.decoder.decode();
    const result = this.consume(tail);
    if (this.buffer.trim() && !this.discarding) {
      const frame = parseRawFrame(this.buffer);
      this.buffer = '';
      if (frame) result.frames.push(frame);
    }
    this.buffer = '';
    this.discarding = false;
    return result;
  }

  get oversizedCount(): number {
    return this.oversizedFrames;
  }

  private consume(text: string): SsePushResult {
    this.buffer += text;
    const frames: RawSseFrame[] = [];
    let oversize = false;
    for (;;) {
      const boundary = this.buffer.search(/\r?\n\r?\n/);
      if (boundary === -1) {
        if (!this.discarding && this.buffer.length > this.maxFrameBytes) {
          this.buffer = '';
          this.discarding = true;
          this.oversizedFrames += 1;
          oversize = true;
        }
        break;
      }
      const raw = this.buffer.slice(0, boundary);
      const separatorLength = this.buffer.startsWith('\r\n\r\n', boundary) ? 4 : 2;
      this.buffer = this.buffer.slice(boundary + separatorLength);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (raw.length > this.maxFrameBytes) {
        this.oversizedFrames += 1;
        oversize = true;
        continue;
      }
      const frame = parseRawFrame(raw);
      if (frame) frames.push(frame);
    }
    return { frames, oversize };
  }
}

export function parseRawFrame(raw: string): RawSseFrame | null {
  let event = 'message';
  let id: string | undefined;
  let retry: number | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'retry') {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) retry = parsed;
    }
  }
  if (dataLines.length === 0 && id === undefined && event === 'message' && retry === undefined) return null;
  return {
    event,
    data: dataLines.join('\n'),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

export function parseSseJson(raw: RawSseFrame): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!raw.data) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.data) };
  } catch {
    return { ok: false, message: `event ${raw.event} carried non-JSON data (${raw.data.length} chars)` };
  }
}
