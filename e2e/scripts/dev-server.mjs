import { spawn } from 'node:child_process';

// Built-in AI and speech unless a run asks otherwise. A developer's server/.env
// may name paid providers, and server-side speech keeps the room "speaking"
// long after the suite's browser-speech stub has finished, so the portal spec
// passed in CI and failed on a configured machine. Values set here win because
// dotenv never overrides a variable that is already present.
const builtInProviders = process.env.E2E_REAL_PROVIDERS === '1'
  ? {}
  : { LLM_PROVIDER: 'heuristic', STT_PROVIDER: 'webspeech', TTS_PROVIDER: 'webspeech' };

const child = spawn('npm', ['run', 'dev'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...builtInProviders,
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db',
    // Signup fails closed without someone to approve it. The console email
    // provider only logs the notice, so a placeholder address is enough here.
    SIGNUP_APPROVER_EMAIL: process.env.SIGNUP_APPROVER_EMAIL ?? 'approver@questor.local',
    // The seeded admin is the platform owner here, so the catalog review spec
    // can reach /catalog-review. Unset, nobody could (it fails closed).
    PLATFORM_OPERATOR_EMAILS: process.env.PLATFORM_OPERATOR_EMAILS ?? 'demo@questor.local',
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER ?? 'console',
    // The question library is dark in production; the suite needs its read API
    // and the owner's screen mounted. The worker stays off: nothing is spent.
    LIBRARY_ENABLED: process.env.LIBRARY_ENABLED ?? 'true',
  },
  shell: true,
  stdio: 'inherit',
});

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('exit', () => stop('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});