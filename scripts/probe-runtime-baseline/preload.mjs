// Loaded with --import into the action and, through its passed-through execArgv, into the
// relaunched child. It loads the fetch machinery the action uses, then reports this process's
// peak resident set when it exits. See run.ts.
/** resourceUsage().maxRSS is in kibibytes. */
const { BINARY_BYTES } = await import(new URL('../../src/format.ts', import.meta.url).href);
const started = process.env.DEPENDENCY_REVIEW_RELAUNCHED !== undefined;
await fetch('data:,baseline').then((response) => response.text());
process.on('exit', () => {
  const maxRSS = process.resourceUsage().maxRSS * BINARY_BYTES.KiB;
  process.stderr.write(`RUNTIME_BASELINE ${JSON.stringify({ relaunched: started, maxRSS })}\n`);
});
