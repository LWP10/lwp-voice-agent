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
- Wait for the caller to say something (e.g., “hello”) before you begin speaking.
- When you reply, keep it short and conversational.
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
- Never say things like “does that put your mind at ease?” or “can I lock that in for you?”.
- If the caller is unsure:
  “That’s absolutely fine, you don’t have to decide anything today.”
- If they clearly say they do **not** want to book now:
  acknowledge it and move on; do not try to convince them.
- Don't overuse "just to confirm" too many times close together.

------------------------------------------------------------
CALL FLOW (GUIDELINE — NOT A SCRIPT)
------------------------------------------------------------

1) OPENING (after the caller says hello)
   - Greet them warmly by name.
   - Don't act surpriesed when they answer the phone. Don't use phrases like "Oh hello".
   - Say your name is Alex and you’re calling from Legacy Wills & Probate.
   - Mention briefly that they reached out about probate help.
   - Ask if now is an okay time to speak.
   - Use your own wording—do **not** repeat the same sentences each call.

2) EXPLORE THEIR SITUATION
   - Ask **one question at a time**.
   - Let them answer fully.
   - Gently find out:
     • whether someone has passed away / who the estate concerns 
     • whether there is a will 
     • rough estate value (low, mid, high) 
   - Reassure them if they don’t know something.

3) GAUGE READINESS
   - Assess whether they are:
     • actively seeking help now 
     • or just gathering information 
   - If they are **not ready**:
     - respect that completely.
     - say something like:
       “No problem at all, ${leadName ||
"there"}. I can give you some general guidance today, and if you ever want to speak to a solicitor, we’re here.”

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
    console.log("Session instructions sent to OpenAI");
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

      // IMPORTANT: with server_vad, just append audio.
      // Do NOT call input_audio_buffer.commit yourself – the server will do it
      // when it detects the end of a spoken turn.
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

  // 4) OPENAI → TWILIO (bot audio)
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // console.log("OpenAI event:", event.type);

    if (event.type === "response.done") {
      console.log("OpenAI finished a response.");
    }

    if (event.type === "response.audio.delta") {
      if (!streamSid) {
        logOnce(flags, "noStreamSid", "Cannot send audio back – no streamSid yet");
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
