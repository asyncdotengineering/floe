/**
 * Node server for support-bot. Uses `runServer` from
 * `@floe/server-bootstrap`.
 */
import { runServer } from '@floe/server-bootstrap';
import supportAssistant from './floe.config.ts';

await runServer(supportAssistant);
