// ===========================
// public/app.js — Snapdrop Clone (Auto-Select Peer if Only One)
// ===========================

const WS_URL = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;
const socket = new WebSocket(WS_URL);
let myId = null;
let selectedPeerId = null;

const peersList = document.getElementById('peers');
const myIdEl = document.getElementById('myId');
const dropzone = document.getElementById('dropzone');
const chooseBtn = document.getElementById('chooseBtn');
const fileInput = document.getElementById('fileInput');
const status = document.getElementById('status');
const transfers = document.getElementById('transfers');
const fabSend = document.getElementById('fabSend');
const offlineOverlay = document.getElementById('offlineOverlay');
const retryConnect = document.getElementById('retryConnect');
const connectionStateEl = document.getElementById('connectionState');

const connections = {}; // peerId -> { pc, dc, incoming }
const CHUNK_SIZE = 64 * 1024; // 64KB

function logStatus(msg) { console.log(msg); status.textContent = msg; }

socket.addEventListener('open', () => {
  logStatus('Connected to signaling server');
  connectionStateEl && (connectionStateEl.textContent = 'Connected');
  offlineOverlay && (offlineOverlay.hidden = true);
});

socket.addEventListener('message', async (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case 'welcome':
      myId = msg.id;
      myIdEl.textContent = `You: ${myId}`;
      msg.peers.forEach(addPeerToList);
      break;
    case 'peer-joined':
      addPeerToList(msg.id);
      break;
    case 'peer-left':
      removePeerFromList(msg.id);
      closePeer(msg.id);
      if (selectedPeerId === msg.id) selectedPeerId = null;
      break;
    case 'offer':
      await handleOffer(msg.from, msg.sdp);
      break;
    case 'answer':
      await handleAnswer(msg.from, msg.sdp);
      break;
    case 'candidate':
      await handleCandidate(msg.from, msg.candidate);
      break;
    default:
      console.warn('Unknown message', msg);
  }
});
socket.addEventListener('close', () => {
  connectionStateEl && (connectionStateEl.textContent = 'Disconnected');
  offlineOverlay && (offlineOverlay.hidden = false);
});

socket.addEventListener('error', () => {
  connectionStateEl && (connectionStateEl.textContent = 'Error');
  offlineOverlay && (offlineOverlay.hidden = false);
});

window.addEventListener('online', () => { offlineOverlay && (offlineOverlay.hidden = true); });
window.addEventListener('offline', () => { offlineOverlay && (offlineOverlay.hidden = false); });


function sendSignal(to, payload) {
  socket.send(JSON.stringify({ ...payload, target: to }));
}

function addPeerToList(id) {
  if (document.getElementById('peer-' + id)) return;
  const li = document.createElement('li');
  li.id = 'peer-' + id;
  li.textContent = id;
  li.addEventListener('click', () => {
    selectedPeerId = id;
    console.log('Selected peer:', id);
  });
  peersList.appendChild(li);
}

function removePeerFromList(id) {
  const el = document.getElementById('peer-' + id);
  if (el) el.remove();
}

async function createConnection(peerId, isInitiator = false) {
  if (connections[peerId]) return connections[peerId];
  const pc = new RTCPeerConnection();
  connections[peerId] = { pc, dc: null, incoming: { buffers: [], size: 0, filename: null } };

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { type: 'candidate', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log('ConnectionState:', peerId, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(peerId);
  };

  pc.ondatachannel = (e) => setupDataChannel(peerId, e.channel);

  if (isInitiator) {
    const dc = pc.createDataChannel('file');
    setupDataChannel(peerId, dc);
  }

  return connections[peerId];
}

function setupDataChannel(peerId, dc) {
  dc.binaryType = 'arraybuffer';
  connections[peerId].dc = dc;

  dc.onopen = () => console.log('DataChannel open with', peerId);
  dc.onclose = () => console.log('DataChannel closed with', peerId);

  dc.onmessage = (ev) => {
    const conn = connections[peerId];
    if (!conn.incoming.filename) {
      try {
        const meta = JSON.parse(new TextDecoder().decode(ev.data));
        conn.incoming.filename = meta.filename || 'file';
        conn.incoming.size = meta.size || 0;
        conn.incoming.buffers = [];
        conn.incoming.received = 0;
        conn.incoming.ui = makeIncomingUI(conn.incoming.filename, conn.incoming.size);
      } catch(e) { console.error('Failed to parse metadata', e); }
      return;
    }

    conn.incoming.buffers.push(ev.data);
    conn.incoming.received += ev.data.byteLength;
    updateIncomingUI(conn.incoming.ui, conn.incoming.received, conn.incoming.size);

    if (conn.incoming.received >= conn.incoming.size) {
      const blob = new Blob(conn.incoming.buffers);
      finishIncomingUI(conn.incoming.ui, blob, conn.incoming.filename);
      conn.incoming.buffers = [];
      conn.incoming.filename = null;
      conn.incoming.size = 0;
    }
  };
}

async function handleOffer(from, sdp) {
  const { pc } = await createConnection(from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal(from, { type: 'answer', sdp: pc.localDescription });
}

async function handleAnswer(from, sdp) {
  const conn = await createConnection(from, true);
  await conn.pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleCandidate(from, candidate) {
  const conn = connections[from];
  if (!conn) return;
  try { await conn.pc.addIceCandidate(candidate); } catch(e){ console.error(e); }
}

// Helper to auto-select peer if only one
function ensureSelectedPeer() {
  if (!selectedPeerId) {
    const peerEls = peersList.querySelectorAll('li');
    if (peerEls.length === 1) {
      selectedPeerId = peerEls[0].textContent;
      console.log('Auto-selected peer:', selectedPeerId);
    } else {
      return false;
    }
  }
  return true;
}

// File input handler
fileInput.addEventListener('change', async () => {
  if (!ensureSelectedPeer()) return alert('Select a peer first!');
  const files = Array.from(fileInput.files || []);
  if (!files.length) return;

  const conn = await createConnection(selectedPeerId, true);
  const offer = await conn.pc.createOffer();
  await conn.pc.setLocalDescription(offer);
  sendSignal(selectedPeerId, { type: 'offer', sdp: conn.pc.localDescription });

  const sendFiles = () => files.forEach(f => sendFileOverDataChannel(conn, f));
  if (conn.dc.readyState === 'open') sendFiles();
  else conn.dc.onopen = sendFiles;
});
chooseBtn.addEventListener('click', () => fileInput.click());
fabSend && fabSend.addEventListener('click', () => fileInput.click());
retryConnect && retryConnect.addEventListener('click', () => location.reload());

function sendFileOverDataChannel(conn, file) {
  const dc = conn.dc;
  if (!dc || dc.readyState !== 'open') { console.error('DataChannel not open'); return; }
  const meta = JSON.stringify({ filename: file.name, size: file.size });
  dc.send(new TextEncoder().encode(meta));

  const reader = new FileReader();
  let offset = 0;
  const ui = makeOutgoingUI(file.name, file.size);
  reader.onload = (e) => {
    const buffer = e.target.result;
    function sendSlice() {
      const slice = buffer.slice(offset, offset + CHUNK_SIZE);
      dc.send(slice);
      offset += slice.byteLength;
      updateOutgoingUI(ui, offset, file.size);
      if (dc.bufferedAmount > CHUNK_SIZE * 8) setTimeout(sendSlice, 50);
      else if (offset < buffer.byteLength) setTimeout(sendSlice, 0);
    }
    sendSlice();
  };
  reader.readAsArrayBuffer(file);
}

function closePeer(peerId) {
  const conn = connections[peerId];
  if (!conn) return;
  try { conn.dc && conn.dc.close(); } catch(e){}
  try { conn.pc && conn.pc.close(); } catch(e){}
  delete connections[peerId];
}

// UI Helpers
function makeOutgoingUI(name, size) {
  const el = document.createElement('div');
  el.className = 'transfer';
  el.innerHTML = `
    <div class="row">
      <strong>Sending:</strong>
      <span class="name">${name}</span>
    </div>
    <div class="progress"><i></i></div>
  `;
  transfers.appendChild(el);
  return el;
}
function updateOutgoingUI(el, sent, total) { el.querySelector('i').style.width = Math.round((sent/total)*100)+'%'; }
function makeIncomingUI(name, size) {
  const el = document.createElement('div');
  el.className = 'transfer';
  el.innerHTML = `
    <div class="row">
      <strong>Receiving:</strong>
      <span class="name">${name}</span>
    </div>
    <div class="progress"><i></i></div>
    <div class="actions"></div>
  `;
  transfers.appendChild(el);
  return el;
}
function updateIncomingUI(el, recv, total) { el.querySelector('i').style.width = Math.round((recv/total)*100)+'%'; }
function finishIncomingUI(el, blob, filename) {
  const url = URL.createObjectURL(blob);
  const actions = el.querySelector('.actions') || el;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.textContent = 'Download';
  actions.appendChild(link);
}

// Drag & drop support
['dragenter','dragover'].forEach(ev => dropzone.addEventListener(ev, e=>{e.preventDefault(); dropzone.classList.add('drag');}));
['dragleave','drop'].forEach(ev => dropzone.addEventListener(ev, e=>{e.preventDefault(); dropzone.classList.remove('drag');}));
dropzone.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return alert('No files dropped');
  if (!ensureSelectedPeer()) return alert('Select a peer first!');

  const conn = await createConnection(selectedPeerId, true);
  const offer = await conn.pc.createOffer();
  await conn.pc.setLocalDescription(offer);
  sendSignal(selectedPeerId, { type:'offer', sdp: conn.pc.localDescription });

  const sendFiles = () => files.forEach(f => sendFileOverDataChannel(conn, f));
  if (conn.dc.readyState === 'open') sendFiles();
  else conn.dc.onopen = sendFiles;
});

console.log('App loaded and ready');