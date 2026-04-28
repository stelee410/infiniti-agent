type Handler<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Handler<unknown>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Handler<unknown>);
    return () => set!.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const h of set) (h as Handler<Events[K]>)(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
