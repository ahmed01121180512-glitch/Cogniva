import { handle } from "../server.mjs";

export default async function githubCallback(req, res) {
  const query = req.url.includes("?")
    ? req.url.substring(req.url.indexOf("?"))
    : "";

  req.url = "/auth/github/callback" + query;

  return handle(req, res);
}
