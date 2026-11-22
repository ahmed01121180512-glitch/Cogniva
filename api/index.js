// Vercel entry point: every dynamic request (/api/*, /auth/*, /app) is rewritten here (see vercel.json) and handled by the same code as `node server.mjs`.
import { handle } from '../server.mjs';
export default handle;
