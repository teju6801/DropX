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

// clients: Map<id, { ws, name }>
const clients = new Map();

function buildPeersArray() {
  return Array.from(clients.entries()).map(([id, info]) => ({
    id,
    name: info.name || "Unnamed Device",
  }));
}

function broadcast(data, excludeId = null) {
  for (const [cid, info] of clients.entries()) {
    if (cid === excludeId) continue;
    const ws = info.ws;
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(data));
      } catch (err) {
        console.error("Broadcast send error:", err);
      }
    }
  }
}

wss.on("connection", (ws) => {
  const id = uuidv4();
  // default name until client sends set-name
  clients.set(id, { ws, name: "Unnamed Device" });

  // send welcome with current peers
  try {
    ws.send(
      JSON.stringify({
        type: "welcome",
        id,
        peers: buildPeersArray(),
      })
    );
  } catch (err) {
    console.error("Send welcome error:", err);
  }

  // announce new peer (compatibility) and full peers update
  broadcast({ type: "peer-joined", id, name: "Unnamed Device" }, id);
  broadcast({ type: "peers-update", peers: buildPeersArray() });

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // handle name set by client
      if (data.type === "set-name") {
        const entry = clients.get(id);
        if (entry) {
          entry.name = data.name || "Unnamed Device";
        }
        // update everyone with new peers list
        broadcast({ type: "peers-update", peers: buildPeersArray() });
        return;
      }

      // forwarding signaling messages (offer/answer/candidate) to target
      if (data.target) {
        const targetInfo = clients.get(data.target);
        if (targetInfo && targetInfo.ws && targetInfo.ws.readyState === 1) {
          // include 'from' id for receiver
          targetInfo.ws.send(JSON.stringify({ ...data, from: id }));
        }
        return;
      }
    } catch (err) {
      console.error("Invalid message:", err);
    }
  });

  ws.on("close", () => {
    clients.delete(id);
    // notify others
    broadcast({ type: "peer-left", id });
    broadcast({ type: "peers-update", peers: buildPeersArray() });
  });

  ws.on("error", (err) => {
    console.error("WebSocket error for", id, err);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 DropX signaling server running on http://localhost:${PORT}`)
);
