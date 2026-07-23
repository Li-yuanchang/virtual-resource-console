import type { HostNode, ProviderType, ResourceCapacitySummary, VmInventorySummary, VmNode } from "./types.js";

interface InventoryEventBase {
  type: "vm.patch" | "vm.upsert" | "vm.delete" | "host.patch" | "summary.patch";
  connectionId?: string;
  providerType: ProviderType;
  hostId?: string;
  eventSeq: number;
  updatedAt: string;
}

export type InventoryEvent =
  | (InventoryEventBase & {
      type: "vm.patch";
      vmId: string;
      patch: Partial<VmNode>;
    })
  | (InventoryEventBase & {
      type: "vm.upsert";
      vm: VmNode;
    })
  | (InventoryEventBase & {
      type: "vm.delete";
      vmId: string;
    })
  | (InventoryEventBase & {
      type: "host.patch";
      patch: Partial<HostNode>;
    })
  | (InventoryEventBase & {
      type: "summary.patch";
      summary: VmInventorySummary;
      resourceCapacity?: ResourceCapacitySummary;
    });

type InventoryEventInput =
  | Omit<Extract<InventoryEvent, { type: "vm.patch" }>, "eventSeq" | "updatedAt">
  | Omit<Extract<InventoryEvent, { type: "vm.upsert" }>, "eventSeq" | "updatedAt">
  | Omit<Extract<InventoryEvent, { type: "vm.delete" }>, "eventSeq" | "updatedAt">
  | Omit<Extract<InventoryEvent, { type: "host.patch" }>, "eventSeq" | "updatedAt">
  | Omit<Extract<InventoryEvent, { type: "summary.patch" }>, "eventSeq" | "updatedAt">;
type InventoryEventListener = (event: InventoryEvent) => void;

const listeners = new Set<InventoryEventListener>();
const recentEvents: InventoryEvent[] = [];
const maxRecentEvents = 200;
let eventSeq = 0;

export function publishInventoryEvent(input: InventoryEventInput): InventoryEvent {
  const event = {
    ...input,
    eventSeq: ++eventSeq,
    updatedAt: new Date().toISOString(),
  } as InventoryEvent;
  recentEvents.push(event);
  if (recentEvents.length > maxRecentEvents) recentEvents.shift();
  for (const listener of listeners) listener(event);
  return event;
}

export function subscribeInventoryEvents(listener: InventoryEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listInventoryEventsAfter(lastEventId: number | undefined): InventoryEvent[] {
  if (lastEventId == null) return recentEvents.slice(-1);
  return recentEvents.filter((event) => event.eventSeq > lastEventId);
}
