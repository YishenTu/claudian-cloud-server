import {
  isCollabProjectId,
  type CollabProjectId,
} from '@claudian-collab/protocol';

export type ProjectEventWakeListener = () => void;

export class ProjectEventWakeup {
  readonly #listeners = new Map<CollabProjectId, Set<ProjectEventWakeListener>>();
  #closed = false;

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
  }

  notify(projectId: CollabProjectId): void {
    if (this.#closed || !isCollabProjectId(projectId)) return;
    for (const listener of this.#listeners.get(projectId) ?? []) {
      try {
        listener();
      } catch {
        // A committed event must still wake every other subscriber.
      }
    }
  }

  subscribe(
    projectId: CollabProjectId,
    listener: ProjectEventWakeListener,
  ): () => void {
    if (this.#closed) throw new Error('project-event-wakeup.closed');
    if (!isCollabProjectId(projectId)) {
      throw new TypeError('project-event-wakeup.project-invalid');
    }
    let listeners = this.#listeners.get(projectId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(projectId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(projectId);
    };
  }
}
