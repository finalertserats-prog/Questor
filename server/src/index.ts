import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachInterviewSocket } from './realtime/socket.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getLlm } from './providers/llm/index.js';
import { preflight } from './preflight.js';

import { startRetentionSweep } from './services/dataRights.js';

preflight();
startRetentionSweep();

const app = createApp();
const httpServer = createServer(app);
attachInterviewSocket(httpServer);

httpServer.listen(config.port, config.bindHost, () => {
  const llm = getLlm();
  logger.info(`🎙️  Questor server listening on http://${config.bindHost}:${config.port}`);
  if (config.bindHost === '0.0.0.0' && config.nodeEnv === 'production') {
    logger.warn(
      'BIND_HOST=0.0.0.0 in production: the app port is reachable directly from the network, ' +
      'bypassing the reverse proxy and its TLS. Anything sent to it — including session cookies ' +
      'and interview transcripts — travels unencrypted. Bind to 127.0.0.1 unless nothing fronts this.',
    );
  }
  logger.info(`    LLM: ${llm.name}${llm.enabled ? ' (remote)' : ' (built-in heuristic — no key needed)'}  |  STT: ${config.stt.provider}  |  TTS: ${config.tts.provider}`);
  logger.info(`    Web origin: ${config.webOrigin}`);
});

process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'Unhandled rejection'));
