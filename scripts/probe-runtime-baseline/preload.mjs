// Loaded with --import into the action and, through its passed-through execArgv, into the
// relaunched child. It loads the fetch machinery the action uses, then reports this process's
// peak resident set, its start and its exit when it exits. See run.ts.
/** resourceUsage().maxRSS is in kibibytes. */
const { BINARY_BYTES } = await import(new URL('../../src/format.ts', import.meta.url).href);
const started = process.env.DEPENDENCY_REVIEW_RELAUNCHED !== undefined;
await fetch('data:,baseline').then((response) => response.text());
process.on('exit', () => {
  const maxRSS = process.resourceUsage().maxRSS * BINARY_BYTES.KiB;
  // Wall-clock milliseconds: the process start (before Node's own bootstrap) and its exit.
  const startedAt = performance.timeOrigin;
  const exitedAt = performance.timeOrigin + performance.now();
  process.stderr.write(
    `RUNTIME_BASELINE ${JSON.stringify({ relaunched: started, maxRSS, startedAt, exitedAt })}\n`,
  );
});
