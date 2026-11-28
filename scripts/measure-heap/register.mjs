// Registers the heap probe's module hooks; run.ts passes it to each measurement with --import.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
