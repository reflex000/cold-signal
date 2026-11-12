// Tiny typed event bus.
export type Handler<T> = (payload: T) => void;

export class Bus<M extends Record<string, any>> {
  private map = new Map<keyof M, Set<Handler<any>>>();
  on<K extends keyof M>(type: K, fn: Handler<M[K]>): () => void {
    let s = this.map.get(type);
    if (!s) this.map.set(type, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const s = this.map.get(type);
    if (s) for (const fn of [...s]) fn(payload);
  }
  clear(): void {
    this.map.clear();
  }
}
