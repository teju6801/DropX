import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, "public")));

const clients = new Map();

wss.on("connection", (ws) => {
  const id = uuidv4();
  const peers = Array.from(clients.keys());
  clients.set(id, ws);

  ws.send(JSON.stringify({ type: "welcome", id, peers }));
  broadcast({ type: "peer-joined", id }, id);

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.target && clients.has(data.target)) {
        const target = clients.get(data.target);
        target.send(JSON.stringify({ ...data, from: id }));
      }
    } catch (err) {
      console.error("Invalid message:", err);
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    broadcast({ type: "peer-left", id });
  });
});

function broadcast(data, excludeId = null) {
  for (const [cid, ws] of clients.entries()) {
    if (cid !== excludeId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 DropX signaling server running on http://localhost:${PORT}`)
);
