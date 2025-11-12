// ===========================
// DropX — P2P File Sharing (with device names)
// ===========================

const WS_URL =
  (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host;
const socket = new WebSocket(WS_URL);
let myId = null;
let selectedPeerId = null;

const peersList = document.getElementById("peers");
const myIdEl = document.getElementById("myId");
const dropzone = document.getElementById("dropzone");
const chooseBtn = document.getElementById("chooseBtn");
const fileInput = document.getElementById("fileInput");
const status = document.getElementById("status");
const transfers = document.getElementById("transfers");
const connectionStateEl = document.getElementById("connectionState");
const offlineOverlay = document.getElementById("offlineOverlay");
const retryConnect = document.getElementById("retryConnect");

const connections = {};
const CHUNK_SIZE = 64 * 1024; // 64KB

// map of peerId -> name (for quick lookup)
const peerNames = {};

// device name (saved in localStorage)
let deviceName = localStorage.getItem("dropx-device-name");
if (!deviceName) {
  // ask once
  try {
    const ans = prompt("Enter a name for this device (e.g. 'Tejas Laptop'):", "My Device");
    deviceName = (ans && ans.trim()) || `Device-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem("dropx-device-name", deviceName);
  } catch (e) {
    deviceName = `Device-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem("dropx-device-name", deviceName);
  }
}

function logStatus(msg) {
  console.log(msg);
  if (status) status.textContent = msg;
}

// ===========================
// WebSocket signaling (with names)
// ===========================
socket.addEventListener("open", () => {
  logStatus("Connected to signaling server");
  if (connectionStateEl) connectionStateEl.textContent = "Connected";
  if (offlineOverlay) offlineOverlay.hidden = true;

  // send our chosen name to server
  socket.send(JSON.stringify({ type: "set-name", name: deviceName }));
});

socket.addEventListener("message", async (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case "welcome":
      myId = msg.id;
      if (myIdEl) myIdEl.textContent = `You: ${deviceName}`;
      // populate peers (msg.peers is array of {id,name})
      if (Array.isArray(msg.peers)) {
        peersList.innerHTML = "";
        msg.peers
          .filter((p) => p.id !== myId)
          .forEach((p) => addPeerToList(p.id, p.name));
      }
      break;

    case "peers-update":
      // full rebuild
      peersList.innerHTML = "";
      if (Array.isArray(msg.peers)) {
        msg.peers
          .filter((p) => p.id !== myId)
          .forEach((p) => addPeerToList(p.id, p.name));
      }
      break;

    case "peer-joined":
      // compatibility: may receive {id, name}
      addPeerToList(msg.id, msg.name || "Unnamed Device");
      break;

    case "peer-left":
      removePeerFromList(msg.id);
      closePeer(msg.id);
      if (selectedPeerId === msg.id) selectedPeerId = null;
      break;

    case "offer":
      await handleOffer(msg.from, msg.sdp);
      break;
    case "answer":
      await handleAnswer(msg.from, msg.sdp);
      break;
    case "candidate":
      await handleCandidate(msg.from, msg.candidate);
      break;
    default:
      console.warn("Unknown message", msg);
  }
});

socket.addEventListener("close", () => {
  if (connectionStateEl) connectionStateEl.textContent = "Disconnected";
  if (offlineOverlay) offlineOverlay.hidden = false;
});
socket.addEventListener("error", () => {
  if (connectionStateEl) connectionStateEl.textContent = "Error";
  if (offlineOverlay) offlineOverlay.hidden = false;
});
window.addEventListener("online", () => {
  if (offlineOverlay) offlineOverlay.hidden = true;
});
window.addEventListener("offline", () => {
  if (offlineOverlay) offlineOverlay.hidden = false;
});

function sendSignal(to, payload) {
  socket.send(JSON.stringify({ ...payload, target: to }));
}

// ===========================
// Peers UI (show friendly names)
// ===========================
function shortId(id) {
  return id ? id.slice(0, 6) : "";
}

function emojiForName(name) {
  if (!name) return "🖥️";
  const lower = name.toLowerCase();
  if (/phone|android|ios|mobile|samsung|iphone/i.test(lower)) return "📱";
  if (/mac|macbook|apple|ios/i.test(lower)) return "💻";
  if (/windows|pc|desktop|workstation/i.test(lower)) return "🖥️";
  return "💻";
}

function addPeerToList(id, name = "Unnamed Device") {
  if (document.getElementById("peer-" + id)) {
    // update name if changed
    const existing = document.getElementById("peer-" + id);
    if (existing) existing.dataset.name = name;
    peerNames[id] = name;
    existing && (existing.querySelector(".peer-name").textContent = name);
    return;
  }

  peerNames[id] = name;

  const li = document.createElement("li");
  li.id = "peer-" + id;
  li.dataset.name = name;
  li.className =
    "cursor-pointer hover:text-indigo-600 border-b border-gray-200 py-2 flex items-center justify-between";
  const emoji = emojiForName(name);
  li.innerHTML = `
    <div class="flex items-center gap-3">
      <div class="text-xl">${emoji}</div>
      <div>
        <div class="peer-name font-medium text-gray-800">${name}</div>
        <div class="text-xs text-gray-400">#${shortId(id)}</div>
      </div>
    </div>
    <div class="text-sm text-gray-500 select-none">Connect</div>
  `;

  li.addEventListener("click", () => {
    selectedPeerId = id;
    // highlight selection visually
    document.querySelectorAll("#peers li").forEach(n => n.classList.remove("bg-indigo-50"));
    li.classList.add("bg-indigo-50");
    // show simple status
    alert(`Selected peer: ${name} (${shortId(id)})`);
  });

  peersList.appendChild(li);
}

function removePeerFromList(id) {
  const el = document.getElementById("peer-" + id);
  if (el) el.remove();
  delete peerNames[id];
}

// ===========================
// WebRTC connection (unchanged logic)
// ===========================
async function createConnection(peerId, isInitiator = false) {
  if (connections[peerId]) return connections[peerId];
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: "turn:openrelay.metered.ca:443",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ],
  });

  connections[peerId] = {
    pc,
    dc: null,
    incoming: { buffers: [], size: 0, filename: null, received: 0, ui: null, progressEl: null },
  };

  pc.onicecandidate = (e) => {
    if (e.candidate)
      sendSignal(peerId, { type: "candidate", candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      closePeer(peerId);
    }
  };

  pc.ondatachannel = (e) => setupDataChannel(peerId, e.channel);

  if (isInitiator) {
    const dc = pc.createDataChannel("file");
    setupDataChannel(peerId, dc);
  }

  return connections[peerId];
}

function setupDataChannel(peerId, dc) {
  dc.binaryType = "arraybuffer";
  connections[peerId].dc = dc;

  dc.onopen = () => {
    console.log("DataChannel open with", peerId);
    if (connectionStateEl)
      connectionStateEl.textContent = `Connected with ${peerNames[peerId] || shortId(peerId)}`;
  };

  dc.onmessage = (ev) => {
    const conn = connections[peerId];

    // 1️⃣ Metadata first
    if (!conn.incoming.filename) {
      try {
        const meta = JSON.parse(new TextDecoder().decode(ev.data));
        conn.incoming.filename = meta.filename || "file";
        conn.incoming.size = meta.size || 0;
        conn.incoming.buffers = [];
        conn.incoming.received = 0;

        // create receiver UI (download area)
        conn.incoming.ui = makeIncomingUI(
          conn.incoming.filename,
          conn.incoming.size
        );

        // also create an Active Transfer entry (so it appears in Active Transfers page)
        if (window.DropXUI && window.DropXUI.addTransfer) {
          const progressEl = window.DropXUI.addTransfer(conn.incoming.filename);
          conn.incoming.progressEl = progressEl;
        }

        console.log("Receiving:", conn.incoming.filename, conn.incoming.size);
      } catch (e) {
        console.error("Failed to parse metadata", e);
      }
      return;
    }

    // 2️⃣ EOF message
    if (typeof ev.data === "string" && ev.data === "EOF") {
      console.log("EOF received");
      const blob = new Blob(conn.incoming.buffers);
      finishIncomingUI(conn.incoming.ui, blob, conn.incoming.filename);

      // update and remove active transfer UI
      if (conn.incoming.progressEl && window.DropXUI && window.DropXUI.updateProgress) {
        window.DropXUI.updateProgress(conn.incoming.progressEl, conn.incoming.size, conn.incoming.size);
      }
      if (window.DropXUI && window.DropXUI.addHistory)
        window.DropXUI.addHistory(conn.incoming.filename, "received");

      // remove active transfer card after short delay
      if (conn.incoming.progressEl) {
        const parent = conn.incoming.progressEl.parentElement;
        setTimeout(() => {
          try { if (parent && parent.parentElement) parent.parentElement.remove(); } catch {}
        }, 1200);
      }

      conn.incoming = { buffers: [], size: 0, filename: null, received: 0, ui: null, progressEl: null };
      return;
    }

    // 3️⃣ Binary chunks
    conn.incoming.buffers.push(ev.data);
    conn.incoming.received += ev.data.byteLength;

    // update both receiver UI and active transfers UI (if present)
    updateIncomingUI(
      conn.incoming.ui,
      conn.incoming.received,
      conn.incoming.size
    );
    if (conn.incoming.progressEl && window.DropXUI && window.DropXUI.updateProgress) {
      window.DropXUI.updateProgress(conn.incoming.progressEl, conn.incoming.received, conn.incoming.size);
    }

    // 4️⃣ If complete (for safety)
    if (
      conn.incoming.size > 0 &&
      conn.incoming.received >= conn.incoming.size
    ) {
      const blob = new Blob(conn.incoming.buffers);
      console.log("File complete:", conn.incoming.filename);
      finishIncomingUI(conn.incoming.ui, blob, conn.incoming.filename);

      if (window.DropXUI && window.DropXUI.addHistory)
        window.DropXUI.addHistory(conn.incoming.filename, "received");

      if (conn.incoming.progressEl) {
        const parent = conn.incoming.progressEl.parentElement;
        setTimeout(() => {
          try { if (parent && parent.parentElement) parent.parentElement.remove(); } catch {}
        }, 1200);
      }

      conn.incoming = { buffers: [], size: 0, filename: null, received: 0, ui: null, progressEl: null };
    }
  };
}

// ===========================
// WebRTC handlers
// ===========================
async function handleOffer(from, sdp) {
  const { pc } = await createConnection(from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal(from, { type: "answer", sdp: pc.localDescription });
}

async function handleAnswer(from, sdp) {
  const conn = await createConnection(from, true);
  await conn.pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleCandidate(from, candidate) {
  const conn = connections[from];
  if (!conn) return;
  try {
    await conn.pc.addIceCandidate(candidate);
  } catch (e) {
    console.error(e);
  }
}

// ===========================
// Sending files
// ===========================
function ensureSelectedPeer() {
  if (!selectedPeerId) {
    alert("Select a peer first!");
    return false;
  }
  return true;
}

function sendFileToPeer(file) {
  if (!ensureSelectedPeer()) return;
  createConnection(selectedPeerId, true).then((conn) => {
    const send = () => sendFileOverDataChannel(conn, file);
    if (conn.dc.readyState === "open") send();
    else conn.dc.onopen = send;

    if (conn.pc.signalingState === "stable" && !conn.pc.localDescription) {
      conn.pc.createOffer().then((offer) => {
        conn.pc.setLocalDescription(offer);
        sendSignal(selectedPeerId, { type: "offer", sdp: offer });
      });
    }
  });
}

fileInput.addEventListener("change", () =>
  Array.from(fileInput.files).forEach(sendFileToPeer)
);
chooseBtn.addEventListener("click", () => fileInput.click());
retryConnect && retryConnect.addEventListener("click", () => location.reload());

dropzone.addEventListener("dragover", (e) => e.preventDefault());
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  Array.from(e.dataTransfer.files).forEach(sendFileToPeer);
});

function sendFileOverDataChannel(conn, file) {
  const dc = conn.dc;
  if (!dc || dc.readyState !== "open") {
    console.error("DataChannel not open");
    return;
  }

  const meta = JSON.stringify({ filename: file.name, size: file.size });
  dc.send(new TextEncoder().encode(meta));

  const reader = new FileReader();
  let offset = 0;

  // create an active transfer entry in UI (if available)
  const progressEl = window.DropXUI && window.DropXUI.addTransfer
    ? window.DropXUI.addTransfer(file.name)
    : null;

  // record progressEl on the connection so we can remove it later if needed
  conn.sending = conn.sending || {};
  conn.sending[file.name] = { progressEl };

  reader.onload = (e) => {
    const buffer = e.target.result;
    const total = buffer.byteLength;

    function sendSlice() {
      const slice = buffer.slice(offset, offset + CHUNK_SIZE);
      dc.send(slice);
      offset += slice.byteLength;

      if (progressEl && window.DropXUI)
        window.DropXUI.updateProgress(progressEl, offset, total);

      if (offset < total) {
        if (dc.bufferedAmount > CHUNK_SIZE * 8) setTimeout(sendSlice, 50);
        else setTimeout(sendSlice, 0);
      } else {
        // ✅ Signal file completed
        dc.send("EOF");

        // Mark finished in history and clean up the active transfer UI
        if (window.DropXUI && window.DropXUI.addHistory)
          window.DropXUI.addHistory(file.name, "sent");

        // remove active transfer card after short delay
        if (progressEl) {
          const parent = progressEl.parentElement;
          setTimeout(() => {
            try { if (parent && parent.parentElement) parent.parentElement.remove(); } catch {}
          }, 1200);
        }

        // cleanup sending record
        if (conn.sending && conn.sending[file.name]) {
          delete conn.sending[file.name];
        }
      }
    }

    sendSlice();
  };
  reader.readAsArrayBuffer(file);
}

// ===========================
// Helpers
// ===========================
function closePeer(peerId) {
  const conn = connections[peerId];
  if (!conn) return;
  try {
    conn.dc && conn.dc.close();
  } catch {}
  try {
    conn.pc && conn.pc.close();
  } catch {}
  delete connections[peerId];
  delete peerNames[peerId];
}

// ===========================
// UI (Receiver side)
// ===========================
function makeIncomingUI(name, size) {
  const el = document.createElement("div");
  el.className =
    "transfer bg-gray-50 p-3 rounded-lg shadow-sm mb-2 border border-gray-200";
  el.innerHTML = `
    <div class="row font-medium text-gray-800 mb-1">Receiving: ${name}</div>
    <div class="w-full bg-gray-300 h-2 rounded overflow-hidden">
      <div class="progress h-2 bg-green-500 w-0 transition-all duration-100"></div>
    </div>
  `;
  transfers.appendChild(el);
  return el;
}

function updateIncomingUI(el, recv, total) {
  try {
    const bar = el.querySelector(".progress");
    const pct = Math.round((recv / total) * 100);
    if (bar) bar.style.width = pct + "%";
  } catch (err) {
    console.error("updateIncomingUI error:", err);
  }
}

function finishIncomingUI(el, blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.textContent = "Download " + filename;
  link.className =
    "block mt-2 text-indigo-600 font-semibold hover:underline";

  el.appendChild(link);

  if (window.DropXUI && window.DropXUI.addHistory)
    window.DropXUI.addHistory(filename, "received");

  // navigate to history tab so user sees it
  const historyLink = document.querySelector(
    '.nav-link[data-section="history"]'
  );
  if (historyLink) historyLink.click();
}

console.log("✅ DropX loaded and ready for transfers");
