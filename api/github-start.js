import { handle } from "../server.mjs";

export default async function githubStart(req, res) {
  const query = req.url.includes("?")
    ? req.url.substring(req.url.indexOf("?"))
    : "";

  req.url = "/auth/github" + query;

  return handle(req, res);
}
