import { spawn } from 'node:child_process';

const child = spawn('npm', ['run', 'dev'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db',
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