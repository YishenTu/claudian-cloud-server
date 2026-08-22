import type {
  CollabCloudEventKind,
  CollabCloudEventPayloadMap,
  CollabCloudProjectEvent,
  CollabIsoTimestamp,
} from '@claudian/collab-protocol';

export type AppendProjectEvent = {
  readonly [Kind in CollabCloudEventKind]: {
    readonly kind: Kind;
    readonly occurredAt: CollabIsoTimestamp;
    readonly payload: CollabCloudEventPayloadMap[Kind];
  };
}[CollabCloudEventKind];

export interface ReadProjectEventsOptions {
  readonly afterSequence: number;
  readonly limit: number;
}

export interface ProjectEventReplayFacts {
  readonly events: readonly CollabCloudProjectEvent[];
  readonly latestSequence: number;
  readonly retainedFromSequence: number;
}

export interface PruneProjectEventsOptions {
  readonly now: CollabIsoTimestamp;
}

export interface ProjectEventReader {
  getProjectEventSequence(): Promise<number>;
  readProjectEvents(
    options: ReadProjectEventsOptions,
  ): Promise<ProjectEventReplayFacts>;
}

export interface ProjectEventPersistence extends ProjectEventReader {
  appendProjectEvent(event: AppendProjectEvent): Promise<CollabCloudProjectEvent>;
  pruneProjectEvents(options: PruneProjectEventsOptions): Promise<number>;
}
