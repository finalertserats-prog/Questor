import { wipe, createDemoData } from './demoData.js';
import { config } from '../config.js';
import { prisma } from '../db.js';

async function main() {
  console.log('Seeding Questor demo data…');
  await wipe();
  const ids = await createDemoData();
  console.log('\n✅ Demo data created.\n');
  console.log('  Recruiter login:');
  console.log(`    URL:      ${config.webOrigin}`);
  console.log(`    Email:    ${ids.email}`);
  console.log(`    Password: ${ids.password}`);
  console.log('\n  Sample role: Senior Data Engineer (scorecard approved)');
  console.log('  Sample candidate: Priya Sharma (resume parsed, fit scored)');
  console.log('  Interview session ready (state ACCEPTED).');
  console.log(`\n  Candidate portal (share this link): ${config.webOrigin}/portal/${ids.token}`);
  console.log('\n  Run a full headless interview + assessment with:  npm run test:e2e -w server\n');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
