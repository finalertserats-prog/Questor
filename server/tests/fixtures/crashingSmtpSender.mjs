// A sender child that dies as soon as it is asked to do anything. Stands in
// for a crash inside the real one (tests/emailSmtpChild.test.ts).
process.on('message', () => {
  process.exit(3);
});
