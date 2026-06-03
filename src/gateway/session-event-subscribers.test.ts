import { describe, expect, it } from "vitest";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./session-event-subscribers.js";

describe("session event subscriber registries", () => {
  it("tracks connection-owned global session subscriptions", () => {
    const registry = createSessionEventSubscriberRegistry();

    registry.subscribe(" conn-a ");
    registry.subscribe("conn-b");
    registry.subscribe("conn-a");

    expect([...registry.getAll()].toSorted()).toEqual(["conn-a", "conn-b"]);

    registry.unsubscribe("conn-a");
    expect([...registry.getAll()]).toEqual(["conn-b"]);

    registry.unsubscribeAll("conn-b");
    expect([...registry.getAll()]).toEqual([]);
  });

  it("cleans all per-session subscriptions for a disconnected connection", () => {
    const registry = createSessionMessageSubscriberRegistry();

    registry.subscribe("conn-a", "agent:main:main");
    registry.subscribe("conn-a", "agent:main:dev");
    registry.subscribe("conn-b", "agent:main:main");

    expect([...registry.get("agent:main:main")].toSorted()).toEqual(["conn-a", "conn-b"]);
    expect([...registry.get("agent:main:dev")]).toEqual(["conn-a"]);

    registry.unsubscribeAll("conn-a");

    expect([...registry.get("agent:main:main")]).toEqual(["conn-b"]);
    expect([...registry.get("agent:main:dev")]).toEqual([]);
  });
});
