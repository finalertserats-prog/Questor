import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachInterviewSocket } from './realtime/socket.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { getLlm } from './providers/llm/index.js';

const app = createApp();
const httpServer = createServer(app);
attachInterviewSocket(httpServer);

httpServer.listen(config.port, () => {
  const llm = getLlm();
  logger.info(`🎙️  Questor server listening on http://localhost:${config.port}`);
  logger.info(`    LLM: ${llm.name}${llm.enabled ? ' (remote)' : ' (built-in heuristic — no key needed)'}  |  STT: ${config.stt.provider}  |  TTS: ${config.tts.provider}`);
  logger.info(`    Web origin: ${config.webOrigin}`);
});

process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'Unhandled rejection'));
