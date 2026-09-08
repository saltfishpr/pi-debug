import type { DebugProtocol } from "@vscode/debugprotocol";
import { DapProtocolError } from "./errors.js";

/**
 * Layer 1 — Codec.
 *
 * Pure, I/O-free encoding/decoding of the DAP wire format:
 *
 *   Content-Length: <N>\r\n\r\n<json-utf8-body>
 *
 * Kept independent from any transport so it can be exhaustively unit-tested
 * with plain strings and arbitrary byte-chunk boundaries.
 */

const CRLF = "\r\n";
const HEADER_SEPARATOR = "\r\n\r\n";
const CONTENT_LENGTH = "content-length";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Byte buffer agnostic to the backing ArrayBuffer kind. */
type Bytes = Uint8Array<ArrayBufferLike>;

/** Serialize a protocol message into a length-prefixed UTF-8 frame. */
export function encodeMessage(message: DebugProtocol.ProtocolMessage): Uint8Array {
  const json = JSON.stringify(message);
  const body = encoder.encode(json);
  const header = encoder.encode(`Content-Length: ${body.length}${HEADER_SEPARATOR}`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header, 0);
  frame.set(body, header.length);
  return frame;
}

/**
 * Incremental decoder. Feed it arbitrarily-chunked bytes; it yields zero or
 * more complete messages per `push()`. Buffers partial frames internally.
 */
export class MessageDecoder {
  private buffer: Bytes = new Uint8Array(0);
  private contentLength = -1;

  push(chunk: Bytes): DebugProtocol.ProtocolMessage[] {
    this.buffer = concat(this.buffer, chunk);
    const messages: DebugProtocol.ProtocolMessage[] = [];

    for (;;) {
      if (this.contentLength < 0) {
        const headerEnd = indexOf(this.buffer, HEADER_SEPARATOR);
        if (headerEnd < 0) {
          break; // header incomplete
        }
        this.contentLength = this.parseContentLength(this.buffer.subarray(0, headerEnd));
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }

      if (this.buffer.length < this.contentLength) {
        break; // body incomplete
      }

      const body = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;

      if (body.length > 0) {
        messages.push(this.parseBody(body));
      }
    }

    return messages;
  }

  private parseContentLength(header: Bytes): number {
    const text = decoder.decode(header);
    for (const line of text.split(CRLF)) {
      const colon = line.indexOf(":");
      if (colon < 0) {
        continue;
      }
      if (line.slice(0, colon).trim().toLowerCase() === CONTENT_LENGTH) {
        const value = Number(line.slice(colon + 1).trim());
        if (!Number.isInteger(value) || value < 0) {
          throw new DapProtocolError(`Invalid Content-Length header: '${line}'.`);
        }
        return value;
      }
    }
    throw new DapProtocolError(`Missing Content-Length header in '${text}'.`);
  }

  private parseBody(body: Bytes): DebugProtocol.ProtocolMessage {
    const json = decoder.decode(body);
    try {
      return JSON.parse(json) as DebugProtocol.ProtocolMessage;
    } catch (err) {
      throw new DapProtocolError(`Failed to parse message body as JSON: ${(err as Error).message}`);
    }
  }
}

function concat(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) {
    return b;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Find the byte offset of an ASCII needle within a buffer, or -1. */
function indexOf(haystack: Bytes, needle: string): number {
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (haystack[i] !== first) {
      continue;
    }
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}
