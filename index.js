// Vercel entry point. vercel.json rewrites send every dynamic request here as /api/index?__p=<original path>,
// so we put the original path back before handing the request to the normal Cogniva handler.
import { handle } from '../server.mjs';

export default function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const original = u.searchParams.get('__p');
  if (original && original.startsWith('/')) {
    u.searchParams.delete('__p');
    const rest = u.searchParams.toString();
    req.url = original + (rest ? '?' + rest : '');
  }
  return handle(req, res);
}
