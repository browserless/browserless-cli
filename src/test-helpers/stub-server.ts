import http from 'node:http';
import { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface StubResponse {
  status: number;
  body: string;
  contentType?: string;
}

export type StubHandler = (req: RecordedRequest) => StubResponse;

export interface StubServer {
  url: string;
  recorded: RecordedRequest[];
  /** Replace the response handler at any time. */
  respond: (handler: StubHandler) => void;
  /**
   * Convenience: respond with a fixed status + body for all subsequent
   * requests until `reset()` is called or another handler is installed.
   * Tests typically set one response then make one request — call
   * `reset()` (or close + restart the stub) if you need different
   * responses on different requests within the same test.
   */
  setResponse: (status: number, body: string, contentType?: string) => void;
  /** Reset recorded requests. */
  reset: () => void;
  close: () => Promise<void>;
}

const defaultHandler: StubHandler = () => ({
  status: 200,
  body: '{}',
});

/**
 * Spin up an in-process HTTP server that captures every request and lets
 * the test set a handler. Used by api/* specs as a stand-in for the real
 * Browserless server. Listens on a random port (`0`) on 127.0.0.1 so
 * tests can run in parallel without colliding.
 */
export const startStubServer = async (): Promise<StubServer> => {
  const recorded: RecordedRequest[] = [];
  let handler: StubHandler = defaultHandler;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const recordedReq: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      body: Buffer.concat(chunks).toString('utf-8'),
      headers: req.headers,
    };
    recorded.push(recordedReq);
    const response = handler(recordedReq);
    res.statusCode = response.status;
    res.setHeader('Content-Type', response.contentType ?? 'application/json');
    res.end(response.body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    recorded,
    respond: (h) => {
      handler = h;
    },
    setResponse: (status, body, contentType) => {
      handler = () => ({ status, body, contentType });
    },
    reset: () => {
      recorded.length = 0;
      handler = defaultHandler;
    },
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
