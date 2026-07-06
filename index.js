const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

const app = express();
const server = http.createServer(app);

app.get("/", (req, res) => {
res.send("LWP Voice Bot server is running.");
});

const wss = new WebSocket.Server({ server, path: "/media" });

function logOnce(state, key, msg) {
if (!state[key]) {
console.log(msg);
state[key] = true;
}
}

wss.on("connection", (ws, req) => {
console.log("Twilio connected to /media");
console.log("Incoming WS URL:", req.url);

const flags = {};

let leadName = "there";
let streamSid = null;

try {
const fullUrl = new URL(req.url, "http://localhost");
const qsName = fullUrl.searchParams.get("name");
if (qsName && qsName.trim()) {
leadName = qsName.trim();
console.log("Lead name from WS query string:", leadName);
}
} catch (e) {
console.error("Error parsing WS URL for name:", e.message || e);
}

let oaReady = false;
let sessionSent = false;
let introSent = false;

let aiSpeaking = false;
let lastBargeInAt = 0;

const oaWs = new WebSocket(
"wss://api.openai.com/v1/realtime?model=gpt-realtime",
{
headers: {
Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
},
}
);

function sendSessionIfReady() {
if (!oaReady || !streamSid || sessionSent) return;

const sessionUpdate = {
type: "session.update",
session: {
type: "realtime",
model: "gpt-realtime",

output_modalities: ["audio"],

audio: {
input: {
format: {
type: "audio/pcmu",
},
turn_detection: {
type: "server_vad",
threshold: 0.5,
prefix_padding_ms: 400,
silence_duration_ms: 1600,
},
},
output: {
format: {
type: "audio/pcmu",
},
voice: "ballad",
},
},

instructions: `
Only ever speak in English.

You are “Alex”, a calm, measured, gender-neutral British virtual assistant calling from Legacy Wills & Probate in the UK.

The caller’s name is: ${leadName || "there"}.
Do not ask for their name. Use their name naturally and occasionally, not constantly.

You must only ever speak in English. Never switch languages.

Sound calm, professional, patient, and reassuring.
You are a legal intake assistant, not a salesperson.
Never sound enthusiastic, chirpy, pushy, rushed, or overexcited.
Keep your pace slow and steady.
Use short, plain sentences.
Ask only one question at a time.
After asking a question, stop speaking and wait for the caller’s answer.
Never answer your own question.
Never guess what the caller was about to say.
Never interrupt or talk over the caller.

Opening:
Greet them calmly using their name.
Say you are Alex calling from Legacy Wills & Probate.
Mention they recently reached out about getting help with a probate matter.
Explain you’ll ask a few quick questions and, if they’d like, help arrange a free 30-minute, no-obligation consultation with a solicitor.
Ask if now is an okay time to talk.

Key questions:
1. Who has passed away, or who the probate relates to.
2. Whether there is a will.
3. Whether they are the executor, next of kin, or another relative.
4. Whether the estate is likely under £325,000 or over £325,000.

Never give legal advice.
If they ask for legal advice, say:
“That’s something a solicitor can help you with in the consultation. My role is just to take a few details and help arrange that for you if you’d like.”

Only offer appointments Monday to Friday, between 9am and 5pm UK time.
Never offer evenings or weekends.
Never invent a booking unless they clearly agree.
`,
},
};

oaWs.send(JSON.stringify(sessionUpdate));
sessionSent = true;
console.log("Session instructions sent to OpenAI");

maybeSendIntro();
}

function maybeSendIntro() {
if (!oaReady || !sessionSent || !streamSid || introSent) return;

const intro = {
type: "response.create",
response: {
instructions: `
Start the conversation now with a short, calm, professional greeting.

Use the caller's name: ${leadName || "there"}.
Say you are Alex calling from Legacy Wills & Probate.
Mention you understand they recently reached out about getting some help with a probate matter.
Explain you’ll ask a few quick questions and, if they’d like, help arrange a free 30-minute, no-obligation consultation with a solicitor.
Finish by asking if now is an okay time to talk.

Ask only one question, then stop and wait.
`,
},
};

oaWs.send(JSON.stringify(intro));
introSent = true;
console.log("Intro response.create sent to OpenAI");
}

oaWs.on("open", () => {
console.log("✅ OpenAI Realtime socket opened");
oaReady = true;
sendSessionIfReady();
});

oaWs.on("error", (err) => {
console.error("OpenAI websocket error:", err.message || err);
});

ws.on("message", (msg) => {
let data;
try {
data = JSON.parse(msg.toString());
} catch {
return;
}

if (data.event === "start") {
console.log("Start event payload:", JSON.stringify(data.start, null, 2));

streamSid = data.start?.streamSid || data.streamSid || null;

const cpName = data.start?.customParameters?.name;
if (cpName && cpName.trim()) {
leadName = cpName.trim();
console.log("Lead name from customParameters:", leadName);
} else {
console.log("No custom name in start event, using:", leadName);
}

console.log("Call started:", data.start?.callSid, "streamSid:", streamSid);

sendSessionIfReady();
maybeSendIntro();
return;
}

if (data.event === "media") {
if (!oaWs || oaWs.readyState !== WebSocket.OPEN) {
logOnce(flags, "skipBeforeOpen", "Skipping media - OpenAI socket not open yet");
return;
}

oaWs.send(
JSON.stringify({
type: "input_audio_buffer.append",
audio: data.media.payload,
})
);

return;
}

if (data.event === "stop") {
console.log("Call ended from Twilio side");
ws.close();
oaWs.close();
return;
}
});

ws.on("close", () => {
console.log("Twilio websocket closed");
if (oaWs && oaWs.readyState === WebSocket.OPEN) {
oaWs.close();
}
});

oaWs.on("message", (msg) => {
let event;
try {
event = JSON.parse(msg.toString());
} catch {
return;
}

if (event.type) {
console.log("OpenAI event:", event.type);
}

if (event.type === "response.done") {
console.log("OpenAI finished a response.");
aiSpeaking = false;
}

if (event.type === "response.output_audio.done") {
aiSpeaking = false;
}

if (event.type === "input_audio_buffer.speech_started") {
const now = Date.now();

if (aiSpeaking && now - lastBargeInAt > 500) {
console.log("Caller interrupted — cancelling Alex");

lastBargeInAt = now;
aiSpeaking = false;

if (oaWs && oaWs.readyState === WebSocket.OPEN) {
oaWs.send(JSON.stringify({ type: "response.cancel" }));
}
}
}

if (event.type === "response.output_audio.delta" && event.delta) {
if (!streamSid) {
logOnce(flags, "noStreamSidDelta", "Cannot send audio back – no streamSid yet");
return;
}

aiSpeaking = true;

ws.send(
JSON.stringify({
event: "media",
streamSid,
media: {
payload: event.delta,
},
})
);

return;
}

if (event.type === "error") {
console.error("OpenAI error event:", JSON.stringify(event, null, 2));
}
});

oaWs.on("close", () => {
console.log("OpenAI websocket closed");
if (ws && ws.readyState === WebSocket.OPEN) {
ws.close();
}
});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
console.log(`Server running on port ${PORT}`);
});
