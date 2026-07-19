import { execSync } from 'node:child_process';

// Ensure the isolated test database exists with the current schema.
export default function setup() {
  execSync('npx prisma db push --skip-generate --accept-data-loss', {
    stdio: 'ignore',
    env: { ...process.env, DATABASE_URL: 'file:./data/test.db' },
  });
}
