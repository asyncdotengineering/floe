/**
 * Node server. Uses `runServer` from `@floe/server-bootstrap`.
 */
import { runServer } from '@floe/server-bootstrap';
import faq from './floe.config.ts';

await runServer(faq);
