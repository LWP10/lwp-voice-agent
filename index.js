const express = require("express");
const http = require("http");
const WebSocket = require("ws");

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

  // 1) Get lead name from the URL query string (?name=Dan)
  let leadName = "there";
  try {
    const url = new URL(req.url, "http://dummy");
    const qName = url.searchParams.get("name");
    if (qName && qName.trim()) {
      leadName = qName.trim();
    }
  } catch (e) {
    console.log("Could not parse lead name from URL:", e.message);
  }
  console.log("Lead name from system:", leadName);

  // Will be set when we see Twilio's "start" event
  let streamSid = null;

  // 2) Connect to OpenAI Realtime
  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime socket opened");

    // Session behaviour + audio config
    const sessionUpdate = {
      type: "session.update",
      session: {
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],

        // Try a deeper / more neutral voice
        voice: "onyx",

        // Make it a bit more human / less rigid
        temperature: 0.7,

        // Basic server-side VAD
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },

        instructions: `
You are "Dan", a warm, calm **British** male virtual assistant (early 30s) calling from Legacy Wills & Probate in the UK.

LANGUAGE & VOICE
- Always speak in clear, natural **British English**.
- Do NOT use Spanish or any other language, even briefly.
- If the caller speaks another language you don't understand, reply in English:
  "I'm really sorry, but I can only help in English at the moment."
- Sound like a friendly UK call centre agent – relaxed, not robotic, with natural pauses.
- Your voice should sound like a calm British male in his early 30s.

OVERALL GOAL
- Have a natural, human conversation.
- Understand the caller's probate situation at a high level.
- If they seem interested and ready, gently guide them towards booking a free 30-minute, no-obligation consultation with a solicitor.
- If they are not ready, respect that. Offer help, don't push or guilt-trip them.

ABOUT THE CALLER
- The caller's first name is: ${leadName || "there"}.
- You already know their name – **never** ask "what's your name?".

TONE & STYLE
- Warm, empathetic, plain English.
- Short sentences, avoid legal jargon.
- Listen carefully and respond to what they actually say.
- Use their name naturally a few times: "${leadName || "there"}".
- Vary your wording. Do **not** read a script word-for-word.

CALL FLOW (GUIDELINE, NOT SCRIPT)
1) OPENING (flexible)
   - Greet them by name and explain briefly why you're calling.
   - Example (adapt in your own words, don't copy exactly):
     "Hi ${leadName || "there"}, it's Dan calling from Legacy Wills and Probate."
     "You got in touch about getting some help with a probate matter."
     "Is now an okay time to chat for a few minutes?"

2) EXPLORE THEIR SITUATION
   - Ask one question at a time.
   - Listen to their answer and ask natural follow-ups.
   - Key things to gently find out:
     - Who has passed away / who the estate belongs to (without prying for unnecessary detail).
     - Whether there is a will.
     - Rough estate value (under/around/over common thresholds).
   - Rephrase questions if they seem unsure or confused.
   - If they don't know something, reassure them that it's okay.

3) GAUGE READINESS
   - After a short conversation, assess:
     - Are they actively looking for help now?
     - Or just gathering information / not ready yet?
   - If they are **not ready** or say they don't want to book yet:
     - Respect this. Do NOT try to force a booking.
     - Say something like:
       "No problem at all, ${leadName || "there"}. I can give you some general guidance today, and if you ever want to speak to a solicitor, we're here."
     - Offer to summarise helpful next steps instead of booking.

4) IF THEY **ARE** READY TO BOOK
   - Clearly confirm they want the free consultation first:
     "Would you like me to book you in for a free 30-minute consultation with one of our solicitors?"
   - Only if they say yes:
     - Ask what days/times generally work best.
     - Confirm their best phone number and email if needed.
   - **Never invent or assume** a day/time.
   - Always confirm back:
     "So just to confirm, you're happy with [day/date] at [time], and we'll call you on [number]?"

5) CLOSING
   - If a booking is made:
     "Great, ${leadName || "there"}. You're booked in for [day/date] at [time]. The solicitor will call you on [number]."
   - If no booking:
     - Leave the door open:
       "That's absolutely fine. If you decide you'd like some help in future, you're very welcome to get back in touch."
   - End warmly:
     "Thanks for your time today, ${leadName || "there"}, and take care."

RULES
- Never give detailed legal advice – your role is to listen, reassure, and arrange a consultation when appropriate.
- If asked for detailed legal advice, say something like:
  "That's exactly what the solicitor can help you with in the consultation. My job is to take a few details and, if you like, arrange that for you."
- If they say clearly they do NOT want to book an appointment right now:
  - Acknowledge it.
  - Do **not** book or imply an appointment has been booked.
  - Do **not** choose a time for them or say "I've saved your appointment" unless they have clearly agreed to it.
        `,
      },
    };

    oaWs.send(JSON.stringify(sessionUpdate));
    console.log("Session instructions sent to OpenAI");

    // Kick off the first spoken response
    const createResponse = {
      type: "response.create",
      response: {
        instructions: "Start the call now with your opening script, following the guidelines.",
      },
    };
    oaWs.send(JSON.stringify(createResponse));
    console.log("Intro response.create sent to OpenAI");
  });

  oaWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err.message || err);
  });

  // 3) TWILIO → OPENAI (caller audio & start/stop)
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || data.streamSid || null;
      console.log(
        "Call started:",
        data.start?.callSid,
        "streamSid:",
        streamSid
      );
      return;
    }

    if (data.event === "media") {
      if (!oaWs || oaWs.readyState !== WebSocket.OPEN) {
        logOnce(flags, "skipBeforeOpen", "Skipping media - OpenAI socket not open yet");
        return;
      }

      // Forward Twilio audio to OpenAI
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload, // base64 g711_ulaw
        })
      );
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
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

  // 4) OPENAI → TWILIO (bot audio)
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // Debug: see what we’re getting back
    // console.log("OpenAI event:", event.type);

    if (event.type === "response.done") {
      console.log("OpenAI finished a response.");
    }

    // Audio chunks from the model
    if (event.type === "response.audio.delta") {
      if (!streamSid) {
        logOnce(flags, "noStreamSid", "Cannot send audio back – no streamSid yet");
        return;
      }

      // event.delta is base64 g711_ulaw
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

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
