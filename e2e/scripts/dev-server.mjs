import { spawn } from 'node:child_process';

const child = spawn('npm', ['run', 'dev'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db',
    // Signup fails closed without someone to approve it. The console email
    // provider only logs the notice, so a placeholder address is enough here.
    SIGNUP_APPROVER_EMAIL: process.env.SIGNUP_APPROVER_EMAIL ?? 'approver@questor.local',
    EMAIL_PROVIDER: process.env.EMAIL_PROVIDER ?? 'console',
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