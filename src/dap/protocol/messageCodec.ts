import type { DebugProtocol } from "@vscode/debugprotocol";

const TWO_CRLF = "\r\n\r\n";
const CONTENT_LENGTH = "Content-Length";

/**
 * Incrementally parses the DAP wire format from a raw byte stream.
 *
 * The wire format frames each JSON message with an HTTP-like header:
 *
 * ```
 * Content-Length: <byteLength>\r\n
 * \r\n
 * <json-body>
 * ```
 *
 * Bytes may arrive split across arbitrary chunk boundaries, so this parser
 * buffers input and only invokes {@link append}'s callback once a full
 * message body has been received. A single chunk may also contain several
 * complete messages.
 */
export class MessageParser {
  private rawData: Buffer = Buffer.alloc(0);
  private contentLength = -1;

  /**
   * Feed a chunk of bytes; yields every complete {@link DebugProtocol.ProtocolMessage}
   * decoded from the accumulated buffer.
   *
   * @throws SyntaxError if a completed body is not valid JSON.
   */
  append(chunk: Buffer): DebugProtocol.ProtocolMessage[] {
    this.rawData = this.rawData.length === 0 ? chunk : Buffer.concat([this.rawData, chunk]);
    const messages: DebugProtocol.ProtocolMessage[] = [];

    for (;;) {
      if (this.contentLength >= 0) {
        // We know how many body bytes to expect; wait until they're all here.
        if (this.rawData.length >= this.contentLength) {
          const body = this.rawData.toString("utf8", 0, this.contentLength);
          this.rawData = this.rawData.subarray(this.contentLength);
          this.contentLength = -1;
          if (body.length > 0) {
            messages.push(JSON.parse(body) as DebugProtocol.ProtocolMessage);
          }
          continue; // there may be more complete messages buffered
        }
      } else {
        const headerEnd = this.rawData.indexOf(TWO_CRLF);
        if (headerEnd !== -1) {
          const header = this.rawData.toString("utf8", 0, headerEnd);
          this.contentLength = MessageParser.parseContentLength(header);
          this.rawData = this.rawData.subarray(headerEnd + TWO_CRLF.length);
          continue;
        }
      }
      break;
    }

    return messages;
  }

  /** Drop any buffered bytes (e.g. after the connection closes). */
  reset(): void {
    this.rawData = Buffer.alloc(0);
    this.contentLength = -1;
  }

  private static parseContentLength(header: string): number {
    for (const line of header.split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator === -1) {
        continue;
      }
      const key = line.slice(0, separator).trim();
      if (key.toLowerCase() === CONTENT_LENGTH.toLowerCase()) {
        const value = Number.parseInt(line.slice(separator + 1).trim(), 10);
        if (Number.isNaN(value)) {
          throw new Error(`Invalid Content-Length header: '${line}'`);
        }
        return value;
      }
    }
    throw new Error(`Content-Length header not found in: '${header}'`);
  }
}

/** Serialize a protocol message into a length-prefixed wire buffer. */
export function encodeMessage(message: DebugProtocol.ProtocolMessage): Buffer {
  const json = JSON.stringify(message);
  const contentLength = Buffer.byteLength(json, "utf8");
  return Buffer.from(`${CONTENT_LENGTH}: ${contentLength}${TWO_CRLF}${json}`, "utf8");
}
