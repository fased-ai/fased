import type { IncomingMessage, ServerResponse } from "node:http";
import { Application, Follow, MemoryKvStore, createFederation, type Context } from "@fedify/fedify";

export type FedifyHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

function shouldHandleFedifyRequest(pathname: string): boolean {
  // Keep the existing FasedAgent HTTP APIs untouched.
  if (pathname.startsWith("/api/")) {
    return false;
  }
  if (pathname === "/.well-known/webfinger") {
    return true;
  }
  if (pathname === "/inbox") {
    return true;
  }
  if (pathname.startsWith("/actors/")) {
    return true;
  }
  return false;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (!req.method || req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => headers.append(key, entry));
    } else if (value != null) {
      headers.set(key, value);
    }
  }
  return headers;
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(req.url ?? "/", origin);
  const body = await readBody(req);
  const init: RequestInit = {
    method: req.method,
    headers: toHeaders(req),
    body: body ? new Uint8Array(body) : null,
  };
  return new Request(url, init);
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

export function createFedifyHandler(opts: { origin: string }): FedifyHandler {
  const federation = createFederation<void>({
    origin: opts.origin,
    kv: new MemoryKvStore(),
  });

  // Unify actors under a single dispatcher to avoid RouterError
  // Fedify requires exactly one variable: {identifier}
  federation.setActorDispatcher(
    "/actors/{identifier}",
    async (ctx: Context<void>, identifier: string) => {
      return new Application({
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        name: identifier,
        inbox: ctx.getInboxUri(identifier),
        outbox: ctx.getOutboxUri(identifier),
        followers: ctx.getFollowersUri(identifier),
        following: ctx.getFollowingUri(identifier),
      });
    },
  );

  // Inbox endpoints (stubs). Later we will enforce trust tiers here.
  federation.setInboxListeners("/actors/{identifier}/inbox", "/inbox").on(Follow, async () => {
    // TODO: accept/reject follow based on federation membership
  });

  // Outbox endpoints (stubs). Later this will expose tasks, offers, and activity.
  federation.setOutboxDispatcher("/actors/{identifier}/outbox", async () => ({
    items: [],
    nextCursor: null,
  }));

  return async (req, res) => {
    const url = new URL(req.url ?? "/", opts.origin);
    if (!shouldHandleFedifyRequest(url.pathname)) {
      return false;
    }

    const request = await toRequest(req, opts.origin);
    const response = await federation.fetch(request, {
      contextData: undefined,
      onNotFound: async () => new Response("Not Found", { status: 404 }),
      onNotAcceptable: async () =>
        new Response("Not Acceptable", {
          status: 406,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            Vary: "Accept",
          },
        }),
    });

    if (response.status === 404) {
      return false;
    }

    await sendResponse(res, response);
    return true;
  };
}
