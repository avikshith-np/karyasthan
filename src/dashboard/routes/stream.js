import { getRecentLogs, getLogsSince, subscribeLogs } from '../logStream.js';
import { onDashboardEvent } from '../events.js';
import { registerTopic, streamHandler } from '../sse.js';

export default async function streamRoutes(app) {
  // Log lines carry a monotonic id: a reconnect replays only what it missed
  // (Last-Event-ID / ?since=logs:<id>) instead of the whole tail again, which
  // showed up as duplicates.
  registerTopic('logs', {
    subscribe: subscribeLogs,
    replay: (since) => (since != null ? getLogsSince(since, 200) : getRecentLogs(200)),
    idOf: (entry) => entry?.id,
  });
  registerTopic('decisions', {
    subscribe: (cb) => onDashboardEvent('decision', cb),
  });

  // The multiplexed stream (spec 007 R12): /api/stream?topics=logs,decisions
  app.get('/api/stream', streamHandler());
}
