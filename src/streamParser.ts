/**
 * Pure NDJSON stream parser for the Claude CLI's --output-format stream-json.
 *
 * Surface event shapes we care about (others are ignored):
 *   {type: "system", subtype: "init", ...}
 *   {type: "stream_event", event: {type: "content_block_delta",
 *      delta: {type: "text_delta", text: "..."}}}
 *   {type: "stream_event", event: {type: "message_stop"}}
 *   {type: "result", ...}
 *
 * The parser is stateless across feeds in everything except buffering
 * a partial trailing line.
 */

export type ParsedEvent =
  | { kind: 'init'; raw: any }
  | { kind: 'text'; text: string }
  | { kind: 'stop' }
  | { kind: 'result'; raw: any }
  | { kind: 'error'; message: string; raw?: any }
  | { kind: 'unknown'; raw: any };

export class StreamParser {
  private buffer = '';

  feed(chunk: string): ParsedEvent[] {
    this.buffer += chunk;
    const events: ParsedEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      events.push(this.parseLine(line));
    }
    return events;
  }

  /** Flush any remaining buffered content (typically nothing). */
  flush(): ParsedEvent[] {
    const tail = this.buffer.trim();
    this.buffer = '';
    return tail ? [this.parseLine(tail)] : [];
  }

  private parseLine(line: string): ParsedEvent {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      return { kind: 'unknown', raw: line };
    }
    return classify(obj);
  }
}

export function classify(obj: any): ParsedEvent {
  if (!obj || typeof obj !== 'object') return { kind: 'unknown', raw: obj };

  const t = obj.type;

  if (t === 'system' && obj.subtype === 'init') {
    return { kind: 'init', raw: obj };
  }

  if (t === 'result') {
    if (obj.is_error || obj.subtype === 'error_max_turns' || obj.subtype === 'error_during_execution') {
      return { kind: 'error', message: obj.error || obj.subtype || 'CLI returned error', raw: obj };
    }
    return { kind: 'result', raw: obj };
  }

  if (t === 'stream_event' && obj.event && typeof obj.event === 'object') {
    const ev = obj.event;
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
      return { kind: 'text', text: ev.delta.text };
    }
    if (ev.type === 'message_stop') {
      return { kind: 'stop' };
    }
    return { kind: 'unknown', raw: obj };
  }

  // Top-level `assistant` envelopes carry the full message for CLI clients
  // that don't enable partial messages. Because we always pass
  // --include-partial-messages, we already accumulated the same text from
  // content_block_delta events — emitting it again would double-count.
  // Treat it as informational and return 'unknown' so callers can ignore it.
  if (t === 'assistant') {
    return { kind: 'unknown', raw: obj };
  }

  return { kind: 'unknown', raw: obj };
}
