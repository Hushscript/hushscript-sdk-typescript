import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { Hushscript } from "../src/client";
import { NetworkError, OutcomeUnknownError } from "../src/errors";
import { TEST_TIMEOUT_SECONDS, TOKEN, fakeClock } from "./helpers";

/** What the server saw: one entry per fully read request. */
interface Seen {
  method: string;
  path: string;
  connection: number;
  /** Whether the connection had already carried an answered request. */
  reused: boolean;
  bodyBytes: number;
}

interface Probe {
  baseUrl: string;
  seen: Seen[];
  /** Connections that have carried an answered request. */
  warmConnections: () => number;
  close: () => Promise<void>;
}

/**
 * How many times undici sends a GET that a reused connection dropped after the whole request
 * arrived. It does not replay it (Node 24 and 26), so the mutating cases below could not be
 * replayed by accident either; the probe is live because the server counts every request line on any
 * connection, so a replay would show up as a second entry, as a request on a new connection does.
 */
const GET_SENDS = 1;
const CARDS = JSON.stringify({ default_id: null, methods: [] });
const HEADER_END = Buffer.from("\r\n\r\n");

function answer(socket: Socket, body: string): void {
  socket.write(
    `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nkeep-alive: timeout=30\r\n\r\n${body}`,
  );
}

/** The body length of the request in `buffer` after its header, or null when more bytes are needed. */
function bodyLength(head: string, rest: Buffer): { length: number; consumed: number } | null {
  const chunked = /^transfer-encoding:\s*chunked/im.test(head);
  if (!chunked) {
    const declared = /^content-length:\s*(\d+)/im.exec(head);
    const length = declared === null ? 0 : Number(declared[1]);
    return rest.length >= length ? { length, consumed: length } : null;
  }
  let offset = 0;
  let total = 0;
  for (;;) {
    const lineEnd = rest.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const size = Number.parseInt(rest.subarray(offset, lineEnd).toString("ascii"), 16);
    if (size === 0) {
      return rest.length >= lineEnd + 4 ? { length: total, consumed: lineEnd + 4 } : null;
    }
    if (rest.length < lineEnd + 2 + size + 2) return null;
    total += size;
    offset = lineEnd + 2 + size + 2;
  }
}

/**
 * A raw TCP server. The warm-up and the card list are answered on a keep-alive connection. Any
 * other request is read in full, recorded, and then the connection is closed without a reply:
 * what a server does when it drops a pooled connection under a request that already arrived.
 */
async function probeServer(close: "end" | "destroy"): Promise<Probe> {
  const seen: Seen[] = [];
  const sockets = new Set<Socket>();
  const warmed = new Set<number>();
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    const id = connections;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let served = 0;
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const split = buffer.indexOf(HEADER_END);
        if (split === -1) return;
        const head = buffer.subarray(0, split).toString("latin1");
        const rest = buffer.subarray(split + HEADER_END.length);
        const body = bodyLength(head, rest);
        if (body === null) return;
        buffer = Buffer.from(rest.subarray(body.consumed));
        const [method = "", target = ""] = (head.split("\r\n")[0] ?? "").split(" ");
        const path = target.split("?")[0] ?? "";
        const entry = { method, path, connection: id, reused: served > 0, bodyBytes: body.length };
        if (path === "/warm") {
          served += 1;
          warmed.add(id);
          answer(socket, "{}");
        } else if (path === "/v1/billing/cards") {
          seen.push(entry);
          served += 1;
          answer(socket, CARDS);
        } else {
          seen.push(entry);
          if (close === "end") socket.end();
          else socket.destroy();
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    seen,
    warmConnections: () => warmed.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

const open: Probe[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((probe) => probe.close()));
});

async function started(close: "end" | "destroy"): Promise<Probe> {
  const probe = await probeServer(close);
  open.push(probe);
  // The global fetch pools these connections, and the SDK's requests go through the same pool.
  // Concurrent requests make the pool open several, so whichever one the next request takes has
  // already carried an answer.
  await Promise.all(
    Array.from({ length: 4 }, async () => (await fetch(`${probe.baseUrl}/warm`)).text()),
  );
  expect(probe.warmConnections()).toBeGreaterThan(1);
  return probe;
}

function client(baseUrl: string): Hushscript {
  // No SDK retries, so every request the server sees was sent by the transport.
  return new Hushscript({
    token: TOKEN,
    baseUrl,
    clock: fakeClock(),
    timeout: TEST_TIMEOUT_SECONDS,
    maxRetries: 0,
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

interface Case {
  name: string;
  method: string;
  path: string;
  error: typeof NetworkError | typeof OutcomeUnknownError;
  body: number;
  run: (hs: Hushscript, baseUrl: string) => Promise<unknown>;
}

const CASES: Case[] = [
  {
    name: "agent claim",
    method: "POST",
    path: "/v1/agent/accounts/su_1/claim",
    error: OutcomeUnknownError,
    body: JSON.stringify({ claim_secret: "cs" }).length,
    run: (_hs, baseUrl) => Hushscript.agent.claim("su_1", "cs", { baseUrl }),
  },
  {
    name: "token rotate",
    method: "POST",
    path: "/v1/agent/credentials/rotate",
    error: OutcomeUnknownError,
    body: 0,
    run: (hs) => hs.agent.rotateToken(),
  },
  {
    name: "org mutation (POST)",
    method: "POST",
    path: "/v1/org/custody",
    error: NetworkError,
    body: JSON.stringify({ a: 1 }).length,
    run: (hs) => hs.api.POST("/v1/org/custody", { body: { a: 1 } as never }),
  },
  {
    name: "org mutation (PATCH)",
    method: "PATCH",
    path: "/v1/org/members/u1",
    error: NetworkError,
    body: JSON.stringify({ a: 1 }).length,
    run: (hs) =>
      hs.api.PATCH("/v1/org/members/{user_id}", {
        params: { path: { user_id: "u1" } },
        body: { a: 1 } as never,
      }),
  },
  {
    name: "unkeyed upload create",
    method: "POST",
    path: "/v1/uploads",
    error: NetworkError,
    body: JSON.stringify({ size_bytes: 10, duration_seconds: 20 }).length,
    run: (hs) =>
      hs.api.POST("/v1/uploads", { body: { size_bytes: 10, duration_seconds: 20 } as never }),
  },
  {
    name: "purchase",
    method: "POST",
    path: "/v1/billing/purchase",
    error: NetworkError,
    body: 0,
    run: (hs) =>
      hs.api.POST("/v1/billing/purchase", {
        body: { pack: "45min", idempotency_key: "k-0123456789abcdef" } as never,
      }),
  },
  {
    name: "DELETE",
    method: "DELETE",
    path: "/v1/org/transcripts/tr_1/hold",
    error: NetworkError,
    body: 0,
    run: (hs) =>
      hs.api.DELETE("/v1/org/transcripts/{id}/hold", { params: { path: { id: "tr_1" } } }),
  },
];

describe("R54: a request that reached a dropped, reused connection is sent exactly once", () => {
  for (const close of ["end", "destroy"] as const) {
    describe(`the server closes with socket.${close}() after reading the whole request`, () => {
      for (const probeCase of CASES) {
        it(`${probeCase.name} is sent once and fails with ${probeCase.error.name}`, async () => {
          const probe = await started(close);
          const error = await failure(probeCase.run(client(probe.baseUrl), probe.baseUrl));
          await delay(50);
          const sends = probe.seen.filter(
            (entry) => entry.method === probeCase.method && entry.path === probeCase.path,
          );
          expect(sends).toHaveLength(1);
          // The probe is live: the request arrived on a connection that had already been used.
          expect(sends[0]?.reused).toBe(true);
          if (probeCase.body > 0) expect(sends[0]?.bodyBytes).toBe(probeCase.body);
          expect(error).toBeInstanceOf(probeCase.error);
          if (probeCase.error === NetworkError) {
            expect(error).not.toBeInstanceOf(OutcomeUnknownError);
          }
        });
      }

      it("shows what undici does with a GET on the same dropped connection (control)", async () => {
        const probe = await started(close);
        const error = await failure(
          client(probe.baseUrl).api.GET("/v1/jobs/{id}", {
            params: { path: { id: "j1" } },
          }),
        );
        await delay(50);
        const sends = probe.seen.filter((entry) => entry.path === "/v1/jobs/j1");
        expect(sends[0]?.reused).toBe(true);
        expect(error).toBeInstanceOf(NetworkError);
        // Recorded as observed: how many times the GET reached the server.
        expect(sends.length).toBe(GET_SENDS);
      });
    });
  }
});
