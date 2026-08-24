const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

const app = express();
const server = http.createServer(app);

// ------------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------------

app.get("/", (req, res) => {
res.send("LWP Voice Bot server is running.");
});

// ------------------------------------------------------------
// TWILIO MEDIA WEBSOCKET
// ------------------------------------------------------------

const wss = new WebSocket.Server({
server,
path: "/media",
});

// Helper to avoid repeating the same warning
function logOnce(state, key, msg) {
if (!state[key]) {
console.log(msg);
state[key] = true;
}
}

// ------------------------------------------------------------
// TWILIO CONNECTION
// ------------------------------------------------------------

wss.on("connection", (ws, req) => {
console.log("Twilio connected to /media");
console.log("Incoming WS URL:", req.url);

const flags = {};

let leadName = "there";
let streamSid = null;

// ----------------------------------------------------------
// LEAD NAME
// ----------------------------------------------------------

try {
const fullUrl = new URL(req.url, "http://localhost");

const qsName = fullUrl.searchParams.get("name");

if (qsName && qsName.trim()) {
leadName = qsName.trim();

console.log(
"Lead name from WS query string:",
leadName
);
}
} catch (e) {
console.error(
"Error parsing WS URL for name:",
e.message || e
);
}

// ----------------------------------------------------------
// OPENAI SESSION STATE
// ----------------------------------------------------------

let oaReady = false;
let sessionSent = false;
let introSent = false;

// ----------------------------------------------------------
// BARGE-IN STATE
// ----------------------------------------------------------

let aiSpeaking = false;
let lastBargeInAt = 0;

// ----------------------------------------------------------
// OPENAI REALTIME CONNECTION
// ----------------------------------------------------------

const oaWs = new WebSocket(
"wss://api.openai.com/v1/realtime?model=gpt-realtime",
{
headers: {
Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
},
}
);

// ----------------------------------------------------------
// SEND OPENAI SESSION CONFIG
// ----------------------------------------------------------

function sendSessionIfReady() {
if (!oaReady || !streamSid || sessionSent) {
return;
}

const sessionUpdate = {
type: "session.update",

session: {
type: "realtime",
model: "gpt-realtime",

output_modalities: ["audio"],

audio: {
// --------------------------------------------------
// CALLER AUDIO INTO OPENAI
// --------------------------------------------------

input: {
format: {
type: "audio/pcmu",
},

// Gives us a readable transcript in Railway logs.
// This is for diagnostics and does NOT replace
// the realtime speech-to-speech conversation.
transcription: {
model: "gpt-live-transcribe",
languages: ["en"],
delay: "low",
},

// ------------------------------------------------
// VOICE ACTIVITY DETECTION
// ------------------------------------------------

turn_detection: {
type: "server_vad",

// Lower = detects quieter / shorter speech sooner.
threshold: 0.35,

// Preserve more of the beginning of words like
// "yes", "over", "no", etc.
prefix_padding_ms: 600,

// Previous setting was 1600ms.
// 900ms makes the interaction considerably quicker.
silence_duration_ms: 900,

// Automatically create Alex's next turn once the
// caller has genuinely finished.
create_response: true,

// CRITICAL:
// OpenAI immediately cancels Alex's active response
// when caller speech is detected.
interrupt_response: true,
},
},

// --------------------------------------------------
// OPENAI AUDIO BACK TO TWILIO
// --------------------------------------------------

output: {
format: {
type: "audio/pcmu",
},

voice: "ballad",
},
},

// ----------------------------------------------------
// MAIN BEHAVIOUR PROMPT
// ----------------------------------------------------

instructions: `
Only ever speak in English.

You are "Alex", a calm, measured, gender-neutral British virtual assistant calling from Legacy Wills & Probate in the UK.

Your purpose is to speak naturally with someone who has made a probate enquiry, understand their situation at a high level, and if they genuinely want to do so, help arrange a free 30-minute consultation with a solicitor.

The caller's name is: ${leadName || "there"}.

Do not ask for their name.
Use their name naturally and occasionally, not constantly.

============================================================
VOICE AND TONE
============================================================

- Speak only in English.
- Sound calm, professional, patient and reassuring.
- You are a legal intake assistant, not a salesperson.
- Never sound chirpy, pushy, overenthusiastic or rushed.
- Keep your pace measured and steady.
- Use short, plain sentences.
- Never mention AI, OpenAI, Twilio, prompts or software.

============================================================
CRITICAL CONVERSATION RULE
============================================================

After asking ANY question:

STOP SPEAKING.

Do not continue the sentence.
Do not add reassurance.
Do not fill the silence.
Do not rephrase the question.
Do not answer the question yourself.

Wait until the caller gives a meaningful verbal answer.

A short answer is still a complete answer.

Examples of complete answers include:

- "Yes"
- "No"
- "Over"
- "Under"
- "My father"
- "Executor"
- "Next of kin"
- "Tuesday"
- "Tomorrow"
- "Morning"
- "Afternoon"
- "2pm"

If the caller gives one of these short answers, ACCEPT IT immediately and respond to what they actually said.

Do not make them repeat themselves unless you genuinely did not hear or understand the answer.

============================================================
NEVER FILL SILENCE
============================================================

Do NOT say things such as:

- "Take your time."
- "Don't worry."
- "It doesn't have to be exact."
- "Whenever you're ready."
- "Let me give you a moment."

while waiting for an answer.

Silence is allowed.

Once you ask a question, remain completely silent until the caller answers.

If there has genuinely been several seconds of silence and no answer was received, you may gently repeat the question ONCE.

============================================================
TURN TAKING
============================================================

- Never interrupt the caller.
- Never speak over the caller.
- If the caller starts speaking while you are speaking, immediately stop talking and listen.
- Do not finish your sentence first.
- The caller takes priority over you.
- Never guess what they were about to say.
- Never invent an answer for them.

When they finish speaking, respond only to what you actually heard.

If you genuinely could not hear them, say:

"Sorry, I didn't quite catch that — would you mind saying that again?"

Never pretend you understood something that you did not hear.

============================================================
OPENING
============================================================

Speak first.

Greet them calmly using their name.

Say you are Alex calling from Legacy Wills & Probate.

Mention that they recently reached out about getting some help with a probate matter.

Explain briefly that you'd like to ask a few quick questions and, if they'd like, you can help arrange a free 30-minute, no-obligation consultation with a solicitor.

Then ask:

"Is now an okay time to chat?"

STOP.

Do not begin the probate questions until the caller verbally confirms that now is okay.

============================================================
PROBATE QUESTIONS
============================================================

Ask these naturally, ONE AT A TIME.

1. Ask who has passed away or who the probate relates to.

WAIT FOR THEIR ANSWER.

2. Ask whether there is a will.

WAIT FOR THEIR ANSWER.

3. If there is a will, ask whether they are the executor named in the will or another relative.

WAIT FOR THEIR ANSWER.

If there is no will, ask whether they are next of kin or another relative helping with things.

WAIT FOR THEIR ANSWER.

4. Ask:

"Would you say the estate is likely under £325,000, or over £325,000?"

WAIT FOR THEIR ANSWER.

If they say "under", accept under.

If they say "over", accept over.

Do not say anything else while waiting.

============================================================
BOOKING — CRITICAL RULES
============================================================

A consultation must NEVER be assumed.

Before discussing dates or times, explicitly ask whether the caller would like a free 30-minute consultation with a solicitor.

Then WAIT FOR AN EXPLICIT ANSWER.

You may only continue to appointment selection if you clearly hear an affirmative answer such as:

- "Yes"
- "Yeah"
- "Okay"
- "Please"
- "I'd like that"
- "That would be helpful"

Silence is NOT consent.

Background noise is NOT consent.

An unclear sound is NOT consent.

If you did not clearly hear agreement, DO NOT proceed to booking.

If uncertain, ask:

"Sorry, just to make sure I heard you correctly — would you like me to help arrange the consultation?"

Then wait again.

============================================================
APPOINTMENT TIMES
============================================================

Appointments may only be offered:

Monday to Friday
9am to 5pm UK time.

Never offer evenings.
Never offer weekends.

Ask:

"What day and time would suit you best?"

Then STOP and wait.

Do NOT choose a day for them.

Do NOT choose morning or afternoon for them.

Do NOT invent a preferred time.

Do NOT answer your own question.

If they say a day but not a time, ask what time works.

If they say morning or afternoon, then ask for a more specific time.

Only confirm an appointment once the caller has explicitly agreed to the actual day and time.

============================================================
NEVER INVENT INFORMATION
============================================================

Never fabricate:

- an answer
- an estate value
- whether there is a will
- executor status
- appointment consent
- a preferred day
- a preferred time
- a booking

If information has not actually been provided by the caller, treat it as UNKNOWN.

============================================================
LEGAL LIMITS
============================================================

Never give detailed legal advice.

If asked for legal advice, say:

"That's something a solicitor can help you with in the consultation. My role is just to take a few details and help arrange that for you if you'd like."

============================================================
ENDING
============================================================

If they do not want to book, respect that immediately.

Do not push.

End calmly and politely.
`,
},
};

oaWs.send(JSON.stringify(sessionUpdate));

sessionSent = true;

console.log(
"Session instructions sent to OpenAI"
);

maybeSendIntro();
}

// ----------------------------------------------------------
// START THE INTRO
// ----------------------------------------------------------

function maybeSendIntro() {
if (
!oaReady ||
!sessionSent ||
!streamSid ||
introSent
) {
return;
}

const intro = {
type: "response.create",

response: {
instructions: `
Start the conversation now.

Use the caller's name: ${leadName || "there"}.

Say you are Alex calling from Legacy Wills & Probate.

Mention that they recently reached out about getting some help with a probate matter.

Briefly explain that you'll ask a few quick questions and, if they'd like, can help arrange a free 30-minute, no-obligation consultation with a solicitor.

Finish by asking whether now is an okay time to talk.

CRITICAL:
After asking whether now is okay, STOP SPEAKING completely.

Do not start another question.
Do not add anything else.
Wait for the caller's verbal answer.
`,
},
};

oaWs.send(JSON.stringify(intro));

introSent = true;

console.log(
"Intro response.create sent to OpenAI"
);
}

// ----------------------------------------------------------
// OPENAI SOCKET OPEN
// ----------------------------------------------------------

oaWs.on("open", () => {
console.log(
"✅ OpenAI Realtime socket opened"
);

oaReady = true;

sendSessionIfReady();
});

oaWs.on("error", (err) => {
console.error(
"OpenAI websocket error:",
err.message || err
);
});

// ----------------------------------------------------------
// TWILIO -> OPENAI
// ----------------------------------------------------------

ws.on("message", (msg) => {
let data;

try {
data = JSON.parse(msg.toString());
} catch {
return;
}

// --------------------------------------------------------
// CALL START
// --------------------------------------------------------

if (data.event === "start") {
console.log(
"Start event payload:",
JSON.stringify(data.start, null, 2)
);

streamSid =
data.start?.streamSid ||
data.streamSid ||
null;

const cpName =
data.start?.customParameters?.name;

if (cpName && cpName.trim()) {
leadName = cpName.trim();

console.log(
"Lead name from customParameters:",
leadName
);
} else {
console.log(
"No custom name in start event, using:",
leadName
);
}

console.log(
"Call started:",
data.start?.callSid,
"streamSid:",
streamSid
);

sendSessionIfReady();
maybeSendIntro();

return;
}

// --------------------------------------------------------
// CALLER AUDIO -> OPENAI
// --------------------------------------------------------

if (data.event === "media") {
if (
!oaWs ||
oaWs.readyState !== WebSocket.OPEN
) {
logOnce(
flags,
"skipBeforeOpen",
"Skipping media - OpenAI socket not open yet"
);

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

// --------------------------------------------------------
// TWILIO MARK EVENTS
// --------------------------------------------------------

if (data.event === "mark") {
console.log(
"Twilio mark received:",
data.mark?.name
);

return;
}

// --------------------------------------------------------
// CALL END
// --------------------------------------------------------

if (data.event === "stop") {
console.log(
"Call ended from Twilio side"
);

if (
oaWs &&
oaWs.readyState === WebSocket.OPEN
) {
oaWs.close();
}

return;
}
});

// ----------------------------------------------------------
// TWILIO SOCKET CLOSED
// ----------------------------------------------------------

ws.on("close", () => {
console.log(
"Twilio websocket closed"
);

if (
oaWs &&
oaWs.readyState === WebSocket.OPEN
) {
oaWs.close();
}
});

// ----------------------------------------------------------
// OPENAI -> TWILIO
// ----------------------------------------------------------

oaWs.on("message", (msg) => {
let event;

try {
event = JSON.parse(
msg.toString()
);
} catch {
return;
}

if (event.type) {
console.log(
"OpenAI event:",
event.type
);
}

// --------------------------------------------------------
// CONFIRM SESSION UPDATE
// --------------------------------------------------------

if (event.type === "session.updated") {
console.log(
"✅ OpenAI session configuration accepted"
);

return;
}

// --------------------------------------------------------
// CALLER STARTS SPEAKING — BARGE IN
// --------------------------------------------------------

if (
event.type ===
"input_audio_buffer.speech_started"
) {
console.log(
"🎙️ Caller started speaking"
);

const now = Date.now();

if (
aiSpeaking &&
now - lastBargeInAt > 250
) {
lastBargeInAt = now;

aiSpeaking = false;

console.log(
"🛑 Caller interrupted Alex — clearing Twilio playback"
);

// OpenAI's interrupt_response:true automatically
// cancels the active response.
//
// But Twilio may already have generated audio waiting
// in its playback buffer.
//
// CLEAR removes that queued audio immediately.

if (
ws.readyState ===
WebSocket.OPEN &&
streamSid
) {
ws.send(
JSON.stringify({
event: "clear",
streamSid,
})
);
}
}

return;
}

// --------------------------------------------------------
// CALLER STOPS SPEAKING
// --------------------------------------------------------

if (
event.type ===
"input_audio_buffer.speech_stopped"
) {
console.log(
"🎙️ Caller stopped speaking"
);

return;
}

// --------------------------------------------------------
// CALLER TRANSCRIPTION — DEBUGGING
// --------------------------------------------------------

if (
event.type ===
"conversation.item.input_audio_transcription.completed"
) {
console.log(
"🗣️ CALLER HEARD:",
event.transcript
);

return;
}

// --------------------------------------------------------
// ALEX TRANSCRIPT
// --------------------------------------------------------

if (
event.type ===
"response.output_audio_transcript.done"
) {
console.log(
"🤖 ALEX SAID:",
event.transcript
);

return;
}

// --------------------------------------------------------
// OPENAI AUDIO -> TWILIO
// --------------------------------------------------------

if (
event.type ===
"response.output_audio.delta" &&
event.delta
) {
if (!streamSid) {
logOnce(
flags,
"noStreamSidDelta",
"Cannot send audio back – no streamSid yet"
);

return;
}

if (
ws.readyState !==
WebSocket.OPEN
) {
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

// --------------------------------------------------------
// ALEX AUDIO FINISHED
// --------------------------------------------------------

if (
event.type ===
"response.output_audio.done"
) {
aiSpeaking = false;

console.log(
"Alex audio generation finished"
);

return;
}

// --------------------------------------------------------
// RESPONSE FINISHED
// --------------------------------------------------------

if (
event.type ===
"response.done"
) {
aiSpeaking = false;

console.log(
"OpenAI finished response"
);

return;
}

// --------------------------------------------------------
// OPENAI ERROR
// --------------------------------------------------------

if (event.type === "error") {
console.error(
"OpenAI error event:",
JSON.stringify(
event,
null,
2
)
);
}
});

// ----------------------------------------------------------
// OPENAI SOCKET CLOSED
// ----------------------------------------------------------

oaWs.on("close", () => {
console.log(
"OpenAI websocket closed"
);

// Don't automatically kill Twilio here unless the call
// itself has ended. Keeping these lifecycles separated
// makes debugging easier.
});
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------

const PORT =
process.env.PORT || 3000;

server.listen(PORT, () => {
console.log(
`Server running on port ${PORT}`
);
});
