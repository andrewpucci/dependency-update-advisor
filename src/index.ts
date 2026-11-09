import { runStartup } from './startup.js';

process.exitCode = await runStartup((line) => process.stderr.write(`${line}\n`));
