// Runs the addon on your own computer (Node 18+). The addon itself lives in addon.js.
//
//   node server.js        then open http://127.0.0.1:7000/
//

import http from "node:http";
import { handle } from "./addon.js";

const PORT = Number(process.env.PORT) || 7000;
const HOST = process.env.HOST || "127.0.0.1";

const server = http.createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host || `${HOST}:${PORT}`}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.log(`Port ${PORT} is already in use: the addon is probably already running at http://${HOST}:${PORT}/`);
  console.log(`To stop that copy: kill $(lsof -ti tcp:${PORT})   or use another port: PORT=7001 node server.js`);
  process.exit(1);
});

server.listen(PORT, HOST, () =>
  console.log(`Dual Subtitles addon running. Configure at http://${HOST}:${PORT}/`));
