// server.js — Updated for File Sending App
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// Map of connected clients
const clients = new Map();

// Generate random 7-character ID
function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

wss.on("connection", (ws) => {
  const id = makeId();
  clients.set(id, ws);
  console.log(`Client connected: ${id} (total: ${clients.size})`);

  // Send welcome with peers
  const peers = Array.from(clients.keys()).filter(k => k !== id);
  ws.send(JSON.stringify({ type: "welcome", id, peers }));

  // Notify others about new peer
  const joinMsg = JSON.stringify({ type: "peer-joined", id });
  for (const [k, clientWs] of clients) {
    if (k !== id && clientWs.readyState === 1) clientWs.send(joinMsg);
  }

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.target && clients.has(msg.target)) {
        const targetWs = clients.get(msg.target);
        if (targetWs.readyState === 1) {
          targetWs.send(JSON.stringify({ ...msg, from: id }));
        }
      } else {
        console.log("Unhandled message from", id, msg);
      }
    } catch (e) {
      console.error("Invalid message from", id, e);
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    console.log(`Client disconnected: ${id} (total: ${clients.size})`);
    const leftMsg = JSON.stringify({ type: "peer-left", id });
    for (const [k, clientWs] of clients) {
      if (clientWs.readyState === 1) clientWs.send(leftMsg);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
