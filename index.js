const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url"); // <--- added

// --- Express + HTTP server ---
const app = express();
const server = http.createServer(app);

// Simple check route
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

// --- Twilio WebSocket server (/media) ---
const wss = new WebSocket.Server({ server, path: "/media" });

// Small helper so we don’t spam logs
function logOnce(state, key, msg) {
  if (!state[key]) {
    console.log(msg);
    state[key] = true;
  }
}

wss.on("connection", (ws, req) => {
  console.log("Twilio connected to /media");
  console.log("Incoming WS URL:", req.url);

  const flags = {}; // for one-time logs

  // Name + stream will be populated from:
  // - query string (?name=daniel) if present
  // - Twilio "start" event customParameters (can override)
  let leadName = "there";
  let streamSid = null;

  // Try to get name from the WebSocket URL query string first
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

  // Track OpenAI socket state so we only send session.update once
  let oaReady = false;
  let sessionSent = false;

  // 1) Connect to OpenAI Realtime
  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Helper to send session.update (and the opening response) once we know:
  // - OpenAI socket is open
  // - Twilio stream has started (so we have leadName + streamSid)
  function sendSessionIfReady() {
    if (!oaReady || !streamSid || sessionSent) return;

    const sessionUpdate = {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],

        voice: "ballad",
        temperature: 0.7,

        // Let the server decide when you've finished speaking
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          // Wait ~1.2s of silence before starting a reply
          silence_duration_ms: 1200,
        },

        instructions: `
Only ever speak in **English**.

You are **“Alex”**, a warm, calm, gender-neutral **British** virtual assistant (early 30s) calling from **Legacy Wills & Probate** in the UK.
Your job is to have a natural conversation, understand the caller’s probate situation at a high level, and—if they seem ready—help arrange a free 30-minute consultation with a solicitor.

Do **not** ask for their name.
The caller’s name is: **${leadName || "there"}**.
Use their name naturally and occasionally, not excessively.

------------------------------------------------------------
LANGUAGE & VOICE
------------------------------------------------------------
- Always speak in clear, natural **British English**.
- You do **not** use an American accent.
- Never use Spanish or any other language.
- Never say “hola”, “buenos días”, or any Spanish phrase.
- If the caller speaks another language, reply in English:
  “I’m really sorry, but I can only help in English at the moment.”
- Sound like a friendly UK call-centre agent: relaxed, warm, natural pace.
- Never talk about your own accent unless the caller explicitly asks.
- Make sure you finish your sentence before saying the next one.
- Always wait for an answer to your question before speaking again, never assume an answer.

------------------------------------------------------------
STYLE & PERSONALITY
------------------------------------------------------------
- Speak like a real person on the phone, not like you are reading a script.
- Use contractions such as “I’m”, “you’re”, “that’s”, “we’ll”.
- Use natural, simple phrasing—avoid legal jargon.
- Keep replies short: usually **one or two sentences**, then pause.
- It’s okay to use light fillers (“okay”, “right”, “I see”), but use them lightly.
- Never read out lists, headings, or numbered points.
- Never explain your own rules or say things like “I will keep my answers short.”

------------------------------------------------------------
CONVERSATION RHYTHM
------------------------------------------------------------
- Let the caller say “hello” or speak first, then respond naturally.
- Do not interrupt the caller; wait for a clear pause before speaking.
- When the caller gives a long answer, briefly summarise what they said in one short sentence, then ask your next helpful question.
- Do not give long explanations unless the caller asks for detail.

------------------------------------------------------------
OVERALL GOAL
------------------------------------------------------------
- Have a natural, human-sounding conversation.
- Understand broadly what help the caller needs with probate.
- If they seem open and ready, **gently** help them arrange a consultation.
- If they are **not ready**, fully respect that—give space, no pressure.

------------------------------------------------------------
SALES / PRESSURE RULES
------------------------------------------------------------
- Do **not** use salesy or pushy language.
- Never say things like “does that put my mind at ease?” or “can I lock that in for you?”.
- If the caller is unsure:
  “That’s absolutely fine, you don’t have to decide anything today.”
- If they clearly say they do **not** want to book now:
  acknowledge it and move on; do not try to convince them.
- Don't overuse "just to confirm" too many times close together.
- You can remind them that the consultation is free and has no obligation if you think that may help get them booked.

------------------------------------------------------------
CALL FLOW (GUIDELINE — NOT A SCRIPT)
------------------------------------------------------------

1) OPENING
  - When the caller has said hello or you hear them on the line, greet them warmly by name.
  - Say your name is Alex, the Legacy Wills & Probate Assistant.
  - Mention briefly that you understand they are looking for help with a probate matter.
  - Mention you’re here to ask a few details to arrange a free 30 minute consultation with one of our solicitors.
  - Ask if now is an okay time to speak.
  - Use your own wording—do **not** repeat the same sentences each call.

2) EXPLORE THEIR SITUATION
  - Ask **one question at a time**.
  - Let them answer fully.
  - Gently find out:
    • whether someone has passed away / who the estate concerns
    • whether there is a will in place
    • whether they are the executor or next of kin
    • a rough estate value (for example, **under £325,000 or over £325,000**)
  - Reassure them if they don’t know something.

  - If the caller says they are handling probate themselves:
    • Respond with empathy and reassurance, for example:
      “I completely understand, handling probate yourself can be a lot to deal with, especially if it’s the first time.”
      “If anything becomes tricky or stressful, our solicitors can guide you through the more complex parts and make sure everything is done correctly.”
    • Do NOT tell them they cannot do it themselves.
    • Position the consultation as extra support if things get complicated, not as pressure to hand everything over.

3) GAUGE READINESS
  - Assess whether they are:
    • actively seeking help now
    • or just gathering information
  - If they are **not ready**:
    - respect that completely.
    - say something like:
      “No problem at all, ${leadName || "there"}. I can give you some general guidance today, and if you ever want to speak to a solicitor, we’re here.”

4) IF THEY ARE READY TO BOOK
  - First confirm clearly:
    “Would you like me to book you in for a free 30-minute consultation with one of our solicitors?”
  - Only if they say **yes**:
    • ask what days/times work for them
    • confirm their number and email if needed
  - Never invent or assume times. Always ask first.
  - Confirm the final details back to them:
    “So just to confirm, you’re happy with [day/date] at [time], and we’ll call you on [number]?”

5) CLOSING
  - If booked:
    “Great, ${leadName || "there"}. You’re booked in for [day/date] at [time]. The solicitor will call you on [number].”
  - If no booking:
    “That’s absolutely fine. If you decide you’d like some help in future, you’re always welcome to get back in touch.”
  - End warmly:
    “Thanks for your time today, ${leadName || "there"}, take care.”

------------------------------------------------------------
APPOINTMENT RULES
------------------------------------------------------------
- Appointments can only be Monday–Friday.
- Never offer or accept weekend slots.
- Times must be between **9:00am and 5:00pm UK time**.
- If they request evenings or weekends:
  “Our solicitors typically work Monday to Friday, 9am to 5pm, so we’d need to find a time within those hours.”

------------------------------------------------------------
LEGAL LIMITS
------------------------------------------------------------
- Never give detailed legal advice.
- If asked for legal advice, say:
  “That’s something the solicitor can help you with in the consultation. My job is just to take a few details and arrange that for you if you want.”

------------------------------------------------------------
ABSOLUTE RULES
------------------------------------------------------------
- Never imply a booking unless the caller clearly agrees.
- Never choose a time for them.
- Never say “I’ve saved you an appointment” unless explicitly confirmed.
- Never pretend to be a solicitor.
- Never mention Twilio, OpenAI, AI, prompts, or models.
        `,
      },
    };

    oaWs.send(JSON.stringify(sessionUpdate));
    sessionSent = true;
    console.log("Session instructions sent to OpenAI");

    // 🔊 Make Alex talk first using response.create
    const introResponse = {
      type: "response.create",
      response: {
        instructions: `
Start speaking as soon as the caller answers. Do not wait for them to speak first.

Open the call in a warm, natural way, for example:

"Hi ${leadName || "there"}, it’s Alex calling from Legacy Wills and Probate."
"You recently reached out about getting some help with a probate matter."
"I’m just going to take a few quick details so we can look at arranging a free 30 minute, no-obligation consultation with one of our solicitors."
"Is now an okay time to have a quick chat?"

Then follow your call flow from the instructions: explore their situation, ask about whether there is a will, whether they are executor or next of kin, ask if the estate is under or over £325,000, and if they seem ready, gently discuss booking a consultation.
        `,
      },
    };

    oaWs.send(JSON.stringify(introResponse));
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

  // 2) TWILIO → OPENAI (caller audio & start/stop)
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }

    if (data.event === "start") {
      console.log(
        "Start event payload:",
        JSON.stringify(data.start, null, 2)
      );

      streamSid = data.start?.streamSid || data.streamSid || null;

      // Get the name from customParameters (set in Twilio Function)
      const cpName = data.start?.customParameters?.name;
      if (cpName && cpName.trim()) {
        leadName = cpName.trim();
        console.log("Lead name from customParameters:", leadName);
      } else {
        console.log("No custom name in start event, using:", leadName);
      }

      console.log(
        "Call started:",
        data.start?.callSid,
        "streamSid:",
        streamSid
      );

      // Now that we (should) know the name and streamSid, send session update if OpenAI is ready
      sendSessionIfReady();
      return;
    }

    if (data.event === "media") {
      if (!oaWs || oaWs.readyState !== WebSocket.OPEN) {
        logOnce(
          flags,
          "skipBeforeOpen",
          "Skipping media - OpenAI socket not open yet"
        );
        return;
      }

      // With server_vad, just append audio. Server commits when it detects end-of-turn.
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload, // base64 g711_ulaw
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

  // 3) OPENAI → TWILIO (bot audio)
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (event.type === "response.done") {
      console.log("OpenAI finished a response.");
    }

    if (event.type === "response.audio.delta") {
      if (!streamSid) {
        logOnce(
          flags,
          "noStreamSid",
          "Cannot send audio back – no streamSid yet"
        );
        return;
      }

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: event.delta, // base64 g711_ulaw
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

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
