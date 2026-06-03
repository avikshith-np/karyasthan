import pino from 'pino';
import { config } from './config.js';
import { logSink } from '../dashboard/logStream.js';

const streams = [{ stream: process.stdout }];
if (config.dashboard.enabled) {
  streams.push({ stream: logSink });
}

export const logger = pino(
  { level: config.logLevel, name: 'karyasthan' },
  pino.multistream(streams),
);
