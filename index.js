const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url"); // for parsing ?name=... if needed

// --- Express + HTTP server ---
const app = express();
const server = http.createServer(app);

// Simple health-check route
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

// --- Twilio WebSocket server on /media ---
const wss = new WebSocket.Server({ server, path: "/media" });

// Helper to avoid spamming logs with the same message
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

  // Default name + streamSid
  let leadName = "there";
  let streamSid = null;

  // Try to get name from query string e.g. wss://.../media?name=daniel
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

  // --- OpenAI Realtime WebSocket ---
  let oaReady = false;
  let sessionSent = false;
  let introSent = false;

  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Build the big instructions string using the current leadName
  function buildInstructions(name) {
    const safeName = name || "there";
    return `
Only ever speak in English.

You are "Alex", a warm, calm, British virtual assistant (early 30s) calling from Legacy Wills & Probate in the UK.
Your job is to have a natural conversation, understand the caller’s probate situation at a high level, and—if they seem ready—help arrange a free 30-minute consultation with a solicitor.

Do not ask the caller for their name.
The caller’s name is: ${safeName}.
Use their name naturally and occasionally, not excessively.

------------------------------------------------------------
LANGUAGE & VOICE
------------------------------------------------------------
- Always speak in clear, natural British English.
- Do not use an American accent.
- Never use Spanish or any other language.
- Never say “hola”, “buenos días”, or any Spanish phrase.
- If the caller speaks another language, reply in English:
  "I’m really sorry, but I can only help in English at the moment."
- Sound like a friendly UK call-centre agent: relaxed, warm, natural pace.
- Make sure you finish your sentence before saying the next one.
- Always wait for an answer to your question before speaking again, never assume an answer.

------------------------------------------------------------
STYLE & PERSONALITY
------------------------------------------------------------
- Speak like a real person on the phone, not like you are reading a script.
- Use contractions such as “I’m”, “you’re”, “that’s”, “we’ll”.
- Use natural, simple phrasing—avoid legal jargon.
- Keep replies short: usually one or two sentences, then pause.
- It’s okay to use light fillers (“okay”, “right”, “I see”), but use them lightly.
- Never read out lists, headings, or numbered points.
- Never explain your own rules or say things like “I will keep my answers short.”

------------------------------------------------------------
CONVERSATION RHYTHM
------------------------------------------------------------
- When the call connects, you speak first.
- Do not talk over the caller; wait for a clear pause before speaking.
- When the caller gives a long answer, briefly summarise what they said in one short sentence, then ask your next helpful question.
- Do not give long explanations unless the caller asks for detail.

------------------------------------------------------------
OVERALL GOAL
------------------------------------------------------------
- Have a natural, human-sounding conversation.
- Understand broadly what help the caller needs with probate.
- If they seem open and ready, gently help them arrange a consultation.
- If they are not ready, fully respect that—give space, no pressure.

------------------------------------------------------------
SALES / PRESSURE RULES
------------------------------------------------------------
- Do not use salesy or pushy language.
- Never say things like “does that put my mind at ease?” or “can I lock that in for you?”.
- If the caller is unsure:
  "That’s absolutely fine, you don’t have to decide anything today."
- If they clearly say they do not want to book now:
  acknowledge it and move on; do not try to convince them.
- Don’t overuse "just to confirm" too many times close together.
- You can remind them that the consultation is free and has no obligation if you think that may help get them booked.

------------------------------------------------------------
CALL FLOW (GUIDELINE — NOT A SCRIPT)
------------------------------------------------------------

1) OPENING
- You speak first.
- Greet them warmly by name.
- Say your name is Alex, the Legacy Wills & Probate assistant.
- Mention briefly that you understand they were looking for help with a probate matter.
- Explain that you’re here to take a few details and, if they’d like, arrange a free 30 minute no-obligation consultation with a solicitor.
- Ask if now is an okay time to talk.

2) EXPLORE THEIR SITUATION
- Ask one question at a time.
- Let them answer fully.
- Gently find out:
  • who the estate concerns,
  • whether there is a will,
  • whether they are the executor or next of kin,
  • a rough estate value: under £325,000 or over £325,000.
- If they do not know the estate value, reassure them that the solicitor can help work that out.
- If they say they are going through probate themselves (acting as executor or personal representative), acknowledge this and show empathy. For example:
  "I understand that can be a lot to manage on your own. The solicitor can talk you through the tricky bits if you’d like some extra guidance."

3) GAUGE READINESS
- Work out whether they:
  • actively want help now, or
  • are just gathering information.
- If they are not ready:
  - respect that completely.
  - say something like:
    "No problem at all, ${safeName}. I can give you some general guidance today, and if you ever want to speak to a solicitor, we’re here."

4) IF THEY ARE READY TO BOOK
- First confirm clearly:
  "Would you like me to book you in for a free 30 minute consultation with one of our solicitors?"
- Only if they say yes:
  • ask what days and times work for them,
  • confirm their number and email if needed.
- Never invent or assume times. Always ask first.
- Confirm the final details back to them:
  "So just to confirm, you’re happy with [day/date] at [time], and we’ll call you on [number]?"

5) CLOSING
- If booked:
  "Great, ${safeName}. You’re booked in for [day/date] at [time]. The solicitor will call you on [number]."
- If no booking:
  "That’s absolutely fine. If you decide you’d like some help in future, you’re always welcome to get back in touch."
- End warmly:
  "Thanks for your time today, ${safeName}, take care."

------------------------------------------------------------
APPOINTMENT RULES
------------------------------------------------------------
- Appointments can only be Monday–Friday.
- Never offer or accept weekend slots.
- Times must be between 9:00am and 5:00pm UK time.
- If they request evenings or weekends:
  "Our solicitors typically work Monday to Friday, 9am to 5pm, so we’d need to find a time within those hours."

------------------------------------------------------------
LEGAL LIMITS
------------------------------------------------------------
- Never give detailed legal advice.
- If asked for legal advice, say:
  "That’s something the solicitor can help you with in the consultation. My job is just to take a few details and arrange that for you if you want."

------------------------------------------------------------
ABSOLUTE RULES
------------------------------------------------------------
- Never imply a booking unless the caller clearly agrees.
- Never choose a time for them.
- Never say "I’ve saved you an appointment" unless explicitly confirmed.
- Never pretend to be a solicitor.
- Never mention Twilio, OpenAI, AI, prompts, or models.
`;
  }

  // Send session.update + enable audio
  function sendSessionIfReady() {
    if (!oaReady || !streamSid || sessionSent) return;

    const sessionUpdate = {
      type: "session.update",
      session: {
        // Audio formats for Twilio <-> OpenAI bridge
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],
        voice: "ballad",
        temperature: 0.7,
        // Let server handle turn-taking
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 1200,
        },
        instructions: buildInstructions(leadName),
      },
    };

    oaWs.send(JSON.stringify(sessionUpdate));
    sessionSent = true;
    console.log("Session instructions sent to OpenAI");

    // Once the session is configured, send an intro so the bot talks first
    sendIntroIfReady();
  }

  function sendIntroIfReady() {
    if (!oaReady || !sessionSent || introSent) return;

    const intro = {
      type: "response.create",
      response: {
        instructions: `The call has just connected. Begin the conversation now, greet ${leadName ||
          "there"} by name, introduce yourself as Alex from Legacy Wills & Probate, explain that you’re calling about their probate enquiry, and ask if now is a good time to talk. Keep it friendly and brief.`,
      },
    };

    oaWs.send(JSON.stringify(intro));
    introSent = true;
    console.log("Intro response.create sent to OpenAI");
  }

  // --- OpenAI socket handlers ---

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime socket opened");
    oaReady = true;
    sendSessionIfReady();
  });

  oaWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err.message || err);
  });

  oaWs.on("close", () => {
    console.log("OpenAI websocket closed");
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  // --- Twilio -> OpenAI: audio + events ---

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      console.log(
        "Start event payload:",
        JSON.stringify(data.start, null, 2)
      );

      streamSid = data.start?.streamSid || data.streamSid || null;

      // customParameters.name from Twilio Function
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

      // Now we know streamSid (and likely name) – safe to send session
      sendSessionIfReady();
      return;
    }

    if (data.event === "media") {
      if (!oaWs || oaWs.readyState !== WebSocket.OPEN) {
        logOnce(
          flags,
          "skipBeforeOpen",
          "Skipping media – OpenAI socket not open yet"
        );
        return;
      }

      // Forward raw mu-law audio to OpenAI buffer
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
      if (oaWs && oaWs.readyState === WebSocket.OPEN) {
        oaWs.close();
      }
      return;
    }
  });

  ws.on("close", () => {
    console.log("Twilio websocket closed");
    if (oaWs && oaWs.readyState === WebSocket.OPEN) {
      oaWs.close();
    }
  });

  // --- OpenAI -> Twilio: bot audio ---

  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // Debug key events
    if (event.type === "session.created" || event.type === "session.updated") {
      console.log("OpenAI event:", event.type);
    }
    if (event.type === "input_audio_buffer.speech_started" ||
        event.type === "input_audio_buffer.speech_stopped" ||
        event.type === "input_audio_buffer.committed") {
      console.log("OpenAI event:", event.type);
    }
    if (event.type === "response.created" || event.type === "response.done") {
      console.log("OpenAI event:", event.type);
      if (event.type === "response.done") {
        console.log("OpenAI finished a response.");
      }
    }

    // The important bit: stream audio back to Twilio
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
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
