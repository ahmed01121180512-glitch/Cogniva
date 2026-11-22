// Vercel Node.js Function entrypoint. All requests are handled by Cogniva's existing server handler.
import { handle } from '../server.mjs';

export default function cogniva(req, res) {
  return handle(req, res);
}
