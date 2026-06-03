// Standalone smoke test for the dashboard. Boots startDashboard() with a fake
// socket and without Baileys. Delete after Phase 1 verification.
import bcrypt from 'bcryptjs';

// Set env BEFORE importing config/server
process.env.DASHBOARD_ENABLED = 'true';
process.env.DASHBOARD_HOST = '127.0.0.1';
process.env.DASHBOARD_PORT = '7071';
process.env.DASHBOARD_USER = 'admin';
process.env.DASHBOARD_PASS_HASH = await bcrypt.hash('test', 10);
process.env.DASHBOARD_COOKIE_SECRET = 'smoke-test-cookie-secret-abcdef';
process.env.DASHBOARD_ALLOW_CIDRS = '127.0.0.1/32,::1/128';
process.env.DASHBOARD_READONLY = 'true';

const { startDashboard } = await import('../src/dashboard/server.js');
const { logger } = await import('../src/utils/logger.js');

const fakeSock = { user: null };

const app = await startDashboard({ getSock: () => fakeSock });
if (!app) {
  console.error('Dashboard failed to start');
  process.exit(1);
}

logger.info('Smoke harness: dashboard started, triggering fake log line');
logger.warn({ foo: 'bar' }, 'Fake warn for log stream test');

// Keep alive for 10min then exit cleanly. Kill with pkill -f smoke-dashboard.
setTimeout(async () => {
  await app.close();
  process.exit(0);
}, 600_000);
