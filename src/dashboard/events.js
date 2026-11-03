import { EventEmitter } from 'events';

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emitDashboardEvent(name, payload) {
  try { bus.emit(name, { ts: Date.now(), ...payload }); } catch {}
}

export function onDashboardEvent(name, handler) {
  bus.on(name, handler);
  return () => bus.off(name, handler);
}
