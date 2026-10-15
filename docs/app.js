const DERP_MAP_URL = "https://tailcat.dev/derpmap.json";
const DB_NAME = "tailtalk-local";
const DB_VERSION = 1;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 4000;
const HEARTBEAT_INTERVAL_MS = 12000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const elements = {
  profileName: document.querySelector("#profile-name"),
  ownAddress: document.querySelector("#own-address"),
  listenerState: document.querySelector("#listener-state"),
  copyOwnAddress: document.querySelector("#copy-own-address"),
  contactList: document.querySelector("#contact-list"),
  contactCount: document.querySelector("#contact-count"),
  globalStatus: document.querySelector("#global-status"),
  welcomePanel: document.querySelector("#welcome-panel"),
  conversationPanel: document.querySelector("#conversation-panel"),
  conversationAvatar: document.querySelector("#conversation-avatar"),
  conversationName: document.querySelector("#conversation-name"),
  peerState: document.querySelector("#peer-state"),
  peerAddressShort: document.querySelector("#peer-address-short"),
  copyPeerAddress: document.querySelector("#copy-peer-address"),
  reconnectButton: document.querySelector("#reconnect-button"),
  messageList: document.querySelector("#message-list"),
  messageScroll: document.querySelector("#message-scroll"),
  messageForm: document.querySelector("#message-form"),
  messageInput: document.querySelector("#message-input"),
  messageLimit: document.querySelector("#message-limit"),
  sendButton: document.querySelector("#send-button"),
  connectDialog: document.querySelector("#connect-dialog"),
  connectForm: document.querySelector("#connect-form"),
  connectName: document.querySelector("#connect-name"),
  connectAddress: document.querySelector("#connect-address"),
  toast: document.querySelector("#toast"),
  resetDialog: document.querySelector("#reset-dialog"),
};

const state = {
  database: null,
  contacts: new Map(),
  messages: [],
  activeAddress: null,
  identity: null,
  listener: null,
  channels: new Map(),
  dialing: new Set(),
  displayName: "You",
  runtimeReady: false,
  resetting: false,
  releaseIdentityLock: null,
  toastTimer: null,
};

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("settings")) database.createObjectStore("settings", { keyPath: "key" });
      if (!database.objectStoreNames.contains("contacts")) database.createObjectStore("contacts", { keyPath: "address" });
      if (!database.objectStoreNames.contains("messages")) {
        const messages = database.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("byAddress", "address", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Close another Tailtalk tab to update local storage."));
  });
}

function acquireIdentityLock() {
  if (!navigator.locks?.request) return Promise.reject(new Error("This browser does not support identity locking. Use one Tailtalk tab at a time."));
  return new Promise((resolve, reject) => {
    const request = navigator.locks.request("tailtalk-identity", { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) {
        reject(new Error("This Tailtalk identity is already active in another tab. Close that tab before connecting here."));
        return;
      }
      resolve();
      await new Promise((release) => { state.releaseIdentityLock = release; });
    });
    request.catch(reject);
  });
}

function readRecord(storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = state.database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readAll(storeName) {
  return new Promise((resolve, reject) => {
    const transaction = state.database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readMessages(address) {
  return new Promise((resolve, reject) => {
    const transaction = state.database.transaction("messages", "readonly");
    const index = transaction.objectStore("messages").index("byAddress");
    const request = index.getAll(IDBKeyRange.only(address));
    request.onsuccess = () => resolve(request.result.sort((a, b) => a.at - b.at));
    request.onerror = () => reject(request.error);
  });
}

function writeRecord(storeName, record) {
  return new Promise((resolve, reject) => {
    const transaction = state.database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Local save failed."));
  });
}

function deleteAllLocalData() {
  return new Promise((resolve, reject) => {
    const transaction = state.database.transaction(["settings", "contacts", "messages"], "readwrite");
    transaction.objectStore("settings").clear();
    transaction.objectStore("contacts").clear();
    transaction.objectStore("messages").clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Could not clear local data."));
  });
}

function setGlobalStatus(text, status = "ready") {
  elements.globalStatus.textContent = text;
  elements.globalStatus.dataset.state = status;
}

function setListenerState(text, status) {
  elements.listenerState.lastChild.textContent = ` ${text.toUpperCase()}`;
  elements.listenerState.dataset.state = status;
}

function toast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.visible = "true";
  state.toastTimer = setTimeout(() => { elements.toast.dataset.visible = "false"; }, 3200);
}

function isTailcatAddress(address) {
  return typeof address === "string" && address.startsWith("tc") && address.length <= 2048;
}

function contactTitle(contact) {
  return contact.label || contact.remoteName || "New contact";
}

function initials(name) {
  return (name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("") || "?").toUpperCase();
}

function shortAddress(address) {
  return address.length > 25 ? `${address.slice(0, 12)}…${address.slice(-8)}` : address;
}

function timeLabel(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function updateContact(address, patch = {}) {
  if (!isTailcatAddress(address)) return Promise.resolve(null);
  const existing = state.contacts.get(address) || {
    address,
    label: "",
    remoteName: "",
    preview: "",
    updatedAt: Date.now(),
    unread: 0,
  };
  const contact = { ...existing, ...patch, address, updatedAt: patch.updatedAt || Date.now() };
  state.contacts.set(address, contact);
  renderContacts();
  return writeRecord("contacts", contact).then(() => contact);
}

function renderContacts() {
  const contacts = [...state.contacts.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  elements.contactCount.textContent = String(contacts.length).padStart(2, "0");
  elements.contactList.replaceChildren();
  if (contacts.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-contact-list";
    empty.textContent = "Your conversations will gather here.";
    elements.contactList.append(empty);
    return;
  }
  for (const contact of contacts) {
    const item = document.createElement("li");
    item.className = "contact-item";
    const button = document.createElement("button");
    button.className = "contact-button";
    button.type = "button";
    button.dataset.address = contact.address;
    button.setAttribute("aria-current", String(contact.address === state.activeAddress));
    const avatar = document.createElement("span");
    avatar.className = "contact-avatar";
    avatar.dataset.color = String(Math.abs(hashCode(contact.address)) % 4);
    avatar.textContent = initials(contactTitle(contact));
    const presence = document.createElement("i");
    presence.dataset.online = String(state.channels.has(contact.address));
    avatar.append(presence);
    const copy = document.createElement("span");
    copy.className = "contact-copy";
    const name = document.createElement("span");
    name.className = "contact-name";
    name.textContent = contactTitle(contact);
    const preview = document.createElement("span");
    preview.className = "contact-preview";
    preview.textContent = contact.preview || shortAddress(contact.address);
    copy.append(name, preview);
    const time = document.createElement("span");
    time.className = "contact-time";
    time.textContent = timeLabel(contact.updatedAt);
    button.append(avatar, copy, time);
    button.addEventListener("click", () => { void selectContact(contact.address, true); });
    item.append(button);
    elements.contactList.append(item);
  }
}

function hashCode(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return hash;
}

function renderMessages() {
  elements.messageList.replaceChildren();
  if (state.messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-messages";
    empty.textContent = state.channels.has(state.activeAddress) ? "This is the beginning." : "Connect to start this conversation.";
    elements.messageList.append(empty);
    return;
  }
  let lastDay = "";
  for (const message of state.messages) {
    const date = new Date(message.at);
    const day = date.toDateString();
    if (day !== lastDay) {
      const divider = document.createElement("div");
      divider.className = "message-divider";
      divider.textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
      elements.messageList.append(divider);
      lastDay = day;
    }
    const row = document.createElement("article");
    row.className = "message-row";
    row.dataset.from = message.from;
    const author = document.createElement("span");
    author.className = "message-author";
    author.textContent = message.from === "self" ? "You" : contactTitle(state.contacts.get(state.activeAddress) || { remoteName: "Peer" });
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = message.text;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const time = document.createElement("time");
    time.dateTime = date.toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    meta.append(time);
    if (message.from === "self" && message.status) {
      const status = document.createElement("span");
      status.className = "message-status";
      status.dataset.status = message.status;
      status.textContent = message.status === "delivered" ? "· Delivered" : message.status === "failed" ? "· Not sent" : "· Sent";
      meta.append(status);
    }
    row.append(author, bubble, meta);
    elements.messageList.append(row);
  }
  elements.messageScroll.scrollTop = elements.messageScroll.scrollHeight;
}

function renderConversation() {
  const contact = state.contacts.get(state.activeAddress);
  const selected = Boolean(contact);
  elements.welcomePanel.hidden = selected;
  elements.conversationPanel.hidden = !selected;
  if (!selected) return;
  const connected = state.channels.has(contact.address);
  const dialing = state.dialing.has(contact.address);
  const name = contactTitle(contact);
  elements.conversationAvatar.textContent = initials(name);
  elements.conversationName.textContent = name;
  elements.peerState.textContent = connected ? "CONNECTED" : dialing ? "CONNECTING" : "OFFLINE";
  elements.peerState.dataset.online = String(connected);
  elements.peerAddressShort.textContent = shortAddress(contact.address);
  elements.peerAddressShort.title = contact.address;
  elements.copyPeerAddress.disabled = false;
  elements.reconnectButton.disabled = connected || dialing || !state.runtimeReady;
  elements.reconnectButton.textContent = dialing ? "Connecting…" : connected ? "Connected" : "Connect";
  elements.messageInput.disabled = !connected;
  elements.sendButton.disabled = !connected;
  elements.messageInput.placeholder = connected ? "Write a message…" : "Connect to send a message";
  elements.messageLimit.textContent = `${elements.messageInput.value.length} / ${MAX_MESSAGE_LENGTH}`;
  renderMessages();
}

async function selectContact(address, reconnect) {
  if (!state.contacts.has(address)) return;
  state.activeAddress = address;
  await writeRecord("settings", { key: "lastConversation", address });
  const contact = state.contacts.get(address);
  if (contact.unread) await updateContact(address, { unread: 0 });
  state.messages = await readMessages(address);
  for (const message of state.messages) {
    if (message.from === "self" && message.status === "sent") {
      message.status = "unconfirmed";
      await writeRecord("messages", message);
    }
  }
  renderContacts();
  renderConversation();
  if (reconnect && state.runtimeReady && !state.channels.has(address)) void connectToContact(address);
}

async function saveMessage(message) {
  await writeRecord("messages", message);
  if (message.address === state.activeAddress) {
    state.messages.push(message);
    renderMessages();
  }
  const contact = state.contacts.get(message.address);
  if (contact) {
    await updateContact(message.address, {
      preview: message.text.replace(/\s+/g, " ").slice(0, 80),
      updatedAt: message.at,
      unread: message.from === "peer" && message.address !== state.activeAddress ? (contact.unread || 0) + 1 : contact.unread || 0,
    });
  }
  return message;
}

function sendPacket(channel, packet) {
  const frame = encoder.encode(`${JSON.stringify(packet)}\n`);
  if (frame.byteLength > MAX_FRAME_BYTES) return Promise.reject(new Error("Message is too large."));
  channel.writeQueue = channel.writeQueue.then(() => channel.connection.write(frame));
  return channel.writeQueue;
}

function attachChannel(connection, address = null, direction = "incoming") {
  const channel = { connection, address, direction, writeQueue: Promise.resolve(), closed: false, lastPongAt: Date.now() };
  if (address) state.channels.set(address, channel);
  channel.heartbeat = setInterval(() => {
    if (channel.closed || document.visibilityState === "hidden") return;
    if (Date.now() - channel.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      closeChannel(channel, new Error("Peer stopped responding."));
      return;
    }
    void sendPacket(channel, { type: "ping" }).catch((error) => closeChannel(channel, error));
  }, HEARTBEAT_INTERVAL_MS);
  void sendPacket(channel, {
    type: "hello",
    address: state.identity.address,
    name: state.displayName,
    version: 1,
  }).catch((error) => closeChannel(channel, error));
  void readChannel(channel);
  renderContacts();
  renderConversation();
  return channel;
}

async function readChannel(channel) {
  let buffered = new Uint8Array(0);
  try {
    while (!channel.closed) {
      const chunk = await channel.connection.read();
      if (chunk === null) break;
      const combined = new Uint8Array(buffered.byteLength + chunk.byteLength);
      combined.set(buffered);
      combined.set(chunk, buffered.byteLength);
      let start = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 10) continue;
        const line = combined.subarray(start, index);
        if (line.byteLength > MAX_FRAME_BYTES) throw new Error("Peer sent an oversized frame.");
        if (line.byteLength > 0) await receivePacket(channel, JSON.parse(decoder.decode(line)));
        start = index + 1;
      }
      buffered = combined.slice(start);
      if (buffered.byteLength > MAX_FRAME_BYTES) throw new Error("Peer sent an oversized frame.");
    }
    if (buffered.byteLength !== 0) throw new Error("Peer closed with an incomplete message.");
    closeChannel(channel);
  } catch (error) {
    closeChannel(channel, error);
  }
}

async function receivePacket(channel, packet) {
  if (!packet || typeof packet !== "object") throw new Error("Invalid message from peer.");
  channel.lastPongAt = Date.now();
  if (packet.type === "ping") {
    await sendPacket(channel, { type: "pong" });
    return;
  }
  if (packet.type === "pong") return;
  if (packet.type === "hello") {
    const remoteAddress = channel.direction === "outgoing" ? channel.address : packet.address;
    if (!isTailcatAddress(remoteAddress)) throw new Error("Peer did not provide a Tailcat address.");
    const previous = state.channels.get(remoteAddress);
    if (previous && previous !== channel) closeChannel(previous);
    channel.address = remoteAddress;
    state.channels.set(remoteAddress, channel);
    const contact = state.contacts.get(remoteAddress);
    await updateContact(remoteAddress, {
      remoteName: typeof packet.name === "string" ? packet.name.slice(0, 32) : "",
      label: contact?.label || "",
      unread: contact?.unread || 0,
    });
    if (!state.activeAddress) await selectContact(remoteAddress, false);
    renderConversation();
    renderContacts();
    return;
  }
  if (!channel.address || !state.contacts.has(channel.address)) throw new Error("Peer sent data before identifying itself.");
  if (packet.type === "message") {
    if (typeof packet.id !== "string" || typeof packet.text !== "string" || packet.text.length > MAX_MESSAGE_LENGTH) {
      throw new Error("Peer sent an invalid message.");
    }
    const existing = await readRecord("messages", packet.id);
    if (!existing) {
      await saveMessage({
        id: packet.id,
        address: channel.address,
        from: "peer",
        text: packet.text,
        at: Number.isFinite(packet.at) && Math.abs(packet.at) < 8.64e15 ? packet.at : Date.now(),
        status: "received",
      });
    }
    await sendPacket(channel, { type: "ack", id: packet.id });
    return;
  }
  if (packet.type === "ack" && typeof packet.id === "string") {
    const message = await readRecord("messages", packet.id);
    if (message?.address === channel.address && message.from === "self") {
      message.status = "delivered";
      await writeRecord("messages", message);
      if (channel.address === state.activeAddress) {
        state.messages = state.messages.map((item) => item.id === message.id ? message : item);
        renderMessages();
      }
    }
    return;
  }
  throw new Error("Peer sent an unsupported message type.");
}

function closeChannel(channel, error = null) {
  if (channel.closed) return;
  channel.closed = true;
  clearInterval(channel.heartbeat);
  if (channel.address && state.channels.get(channel.address) === channel) state.channels.delete(channel.address);
  channel.connection.close();
  if (channel.address && !state.resetting) void markUnconfirmed(channel.address);
  renderContacts();
  renderConversation();
  if (error && channel.address) toast(`Connection ended: ${error.message}`);
}

async function markUnconfirmed(address) {
  const messages = await readMessages(address);
  for (const message of messages) {
    if (message.from === "self" && message.status === "sent") {
      message.status = "unconfirmed";
      await writeRecord("messages", message);
    }
  }
  if (address === state.activeAddress) {
    state.messages = messages;
    renderMessages();
  }
}

async function connectToContact(address) {
  if (!state.runtimeReady || state.channels.has(address) || state.dialing.has(address)) return;
  state.dialing.add(address);
  renderConversation();
  renderContacts();
  try {
    const connection = await tailcatDial({ addr: address, derpMapURL: DERP_MAP_URL });
    attachChannel(connection, address, "outgoing");
  } catch (error) {
    toast(`Could not connect: ${error.message}`);
  } finally {
    state.dialing.delete(address);
    renderConversation();
    renderContacts();
  }
}

async function sendMessage() {
  const address = state.activeAddress;
  const channel = state.channels.get(address);
  const text = elements.messageInput.value.trim();
  if (!channel || !text || text.length > MAX_MESSAGE_LENGTH) return;
  const message = {
    id: crypto.randomUUID(),
    address,
    from: "self",
    text,
    at: Date.now(),
    status: "sent",
  };
  elements.messageInput.value = "";
  elements.messageLimit.textContent = `0 / ${MAX_MESSAGE_LENGTH}`;
  await saveMessage(message);
  try {
    await sendPacket(channel, { type: "message", id: message.id, text, at: message.at });
  } catch (error) {
    message.status = "failed";
    await writeRecord("messages", message);
    state.messages = state.messages.map((item) => item.id === message.id ? message : item);
    renderMessages();
    closeChannel(channel, error);
  }
}

async function bootWasm() {
  if (typeof Go !== "function") throw new Error("The Go WebAssembly runtime did not load.");
  const go = new Go();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  globalThis.onTailcatReady = resolveReady;
  const response = await fetch("./main.wasm.gz");
  if (!response.ok || !response.body) throw new Error(`Could not load the Tailcat build (${response.status}).`);
  if (typeof DecompressionStream !== "function") throw new Error("This browser cannot decompress the Tailcat build.");
  const wasmStream = response.body.pipeThrough(new DecompressionStream("gzip"));
  const wasmResponse = new Response(wasmStream, { headers: { "Content-Type": "application/wasm" } });
  const { instance } = await WebAssembly.instantiateStreaming(wasmResponse, go.importObject);
  void go.run(instance).catch(rejectReady);
  await ready;
  delete globalThis.onTailcatReady;
}

async function startApp() {
  try {
    state.database = await openDatabase();
    const profile = await readRecord("settings", "profile");
    state.displayName = profile?.name || "You";
    elements.profileName.value = state.displayName;
    const identity = await readRecord("settings", "identity");
    state.identity = identity || { privateKeyJSON: "", address: "" };
    const lastConversation = await readRecord("settings", "lastConversation");
    const contacts = await readAll("contacts");
    state.contacts = new Map(contacts.map((contact) => [contact.address, contact]));
    renderContacts();
    setGlobalStatus("Loading Tailcat", "loading");
    await acquireIdentityLock();
    await bootWasm();
    state.listener = await tailcatListen({
      derpMapURL: DERP_MAP_URL,
      privateKey: state.identity.privateKeyJSON,
      onConnection: (connection) => attachChannel(connection),
    });
    state.identity = {
      key: "identity",
      address: state.listener.addr,
      privateKeyJSON: state.listener.privateKeyJSON,
    };
    await writeRecord("settings", state.identity);
    elements.ownAddress.textContent = state.identity.address;
    elements.copyOwnAddress.disabled = false;
    setListenerState("Listening", "ready");
    state.runtimeReady = true;
    setGlobalStatus("Listening over DERP", "ready");
    if (lastConversation?.address && state.contacts.has(lastConversation.address)) {
      await selectContact(lastConversation.address, false);
    } else {
      renderConversation();
    }
  } catch (error) {
    setListenerState("Unavailable", "error");
    setGlobalStatus("Tailcat unavailable", "error");
    elements.ownAddress.textContent = error.message;
    toast(error.message);
      state.listener?.close();
      state.listener = null;
      state.releaseIdentityLock?.();
      state.releaseIdentityLock = null;
  }
}

function openConnectDialog() {
  elements.connectName.value = "";
  elements.connectAddress.value = "";
  elements.connectDialog.showModal();
  elements.connectName.focus();
}

document.querySelectorAll("[data-open-connect]").forEach((button) => button.addEventListener("click", openConnectDialog));
document.querySelector("#new-chat-button").addEventListener("click", openConnectDialog);
document.querySelector("#top-new-chat").addEventListener("click", openConnectDialog);
document.querySelector("#close-dialog").addEventListener("click", () => elements.connectDialog.close());
document.querySelector("#cancel-connect").addEventListener("click", () => elements.connectDialog.close());
elements.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const address = elements.connectAddress.value.trim();
  if (!isTailcatAddress(address)) {
    toast("Enter a valid Tailcat address beginning with tc.");
    return;
  }
  const label = elements.connectName.value.trim().slice(0, 32);
  await updateContact(address, { label, remoteName: "", preview: "", unread: 0 });
  elements.connectDialog.close();
  await selectContact(address, false);
  void connectToContact(address);
});

elements.reconnectButton.addEventListener("click", () => {
  if (state.activeAddress) void connectToContact(state.activeAddress);
});
elements.copyOwnAddress.addEventListener("click", async () => {
  if (!state.identity?.address) return;
  try {
    await navigator.clipboard.writeText(state.identity.address);
    toast("Your invite is copied.");
  } catch {
    toast("Clipboard access is unavailable in this browser.");
  }
});
elements.copyPeerAddress.addEventListener("click", async () => {
  const address = state.activeAddress;
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    toast("Tailcat address copied.");
  } catch {
    toast("Clipboard access is unavailable in this browser.");
  }
});
elements.profileName.addEventListener("change", async () => {
  state.displayName = elements.profileName.value.trim().slice(0, 32) || "You";
  elements.profileName.value = state.displayName;
  await writeRecord("settings", { key: "profile", name: state.displayName });
  toast("Display name saved on this browser.");
});
elements.messageInput.addEventListener("input", () => {
  elements.messageLimit.textContent = `${elements.messageInput.value.length} / ${MAX_MESSAGE_LENGTH}`;
});
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.messageForm.requestSubmit();
  }
});
elements.messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendMessage();
});

document.querySelector("#clear-local-data").addEventListener("click", () => elements.resetDialog.showModal());
document.querySelector("#close-reset-dialog").addEventListener("click", () => elements.resetDialog.close());
document.querySelector("#cancel-reset").addEventListener("click", () => elements.resetDialog.close());
document.querySelector("#reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.resetDialog.close();
  state.resetting = true;
  for (const channel of state.channels.values()) channel.connection.close();
  state.channels.clear();
  state.listener?.close();
  state.releaseIdentityLock?.();
  await deleteAllLocalData();
  location.reload();
});

window.addEventListener("beforeunload", () => {
  for (const channel of state.channels.values()) channel.connection.close();
  state.listener?.close();
  state.releaseIdentityLock?.();
});

void startApp();