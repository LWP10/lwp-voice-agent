const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

const app = express();
const server = http.createServer(app);

// Health-check route
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

// Twilio Media Stream websocket
const wss = new WebSocket.Server({ server, path: "/media" });

// small helper to avoid spammy logs
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

  // --- 1) Try to get name from WS URL query (?name=Dan) ---
  try {
    const fullUrl = new URL(req.url, "http://localhost");
    const qsName = fullUrl.searchParams.get("name");
    if (qsName && qsName.trim()) {
      leadName = qsName.trim();
      console.log("Lead name from WS query string:", leadName);
    }
  } catch (e) {
    console.error("Error parsing WS URL:", e.message || e);
  }

  // --- 2) Connect to OpenAI Realtime ---
  let oaReady = false;
  let sessionSent = false;

  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

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
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 1200,
        },
        instructions: `
Only ever speak in English.

You are “Alex”, a warm, calm, **British** virtual assistant (early 30s) calling from **Legacy Wills & Probate** in the UK.

The caller’s name is: **${leadName || "there"}**.
Do NOT ask for their name. Use that name naturally and occasionally.

GOAL
- Have a human, natural conversation.
- Understand at a high level what probate help they need.
- If they seem ready, gently arrange a free 30-minute consultation.
- If they are not ready, fully respect that and do not push.

LANGUAGE & STYLE
- Clear, natural British English; never Spanish or other languages.
- Short answers (1–2 sentences), plain English, no legal jargon.
- Use contractions: I’m, you’re, that’s, we’ll.
- Do not sound like you’re reading a script.
- Do not explain your own rules or say “I will keep my answers short”.

CALL FLOW (GUIDELINE)

1) OPENING (you speak first as soon as the call connects)
- Greet them by name and introduce yourself:
  “Hi ${leadName || "there"}, it’s Alex, the Legacy Wills and Probate assistant.”
- Briefly say you understand they recently reached out about help with a probate matter.
- Explain that you’ll ask a few quick questions to see what help they need and, if they want, arrange a free 30-minute consultation with a solicitor.
- Ask if now is an okay time to chat.

2) EXPLORE THEIR SITUATION
- Ask one question at a time and let them finish.
- Gently find out:
  - Who the estate is about.
  - Whether there is a will.
  - Whether they are the executor or next of kin.
- If they say they are going through probate themselves, acknowledge this and reassure them:
  - e.g. “I’m sorry you’re having to deal with that yourself, it can be a lot to manage. I’ll keep this as simple as I can for you, and if anything feels tricky, the solicitor can help you through it.”

3) ESTATE VALUE (BRACKET)
- Ask for a rough value:
  “Do you have a rough idea whether the total estate is under £325,000, or over £325,000?”
- If they don’t know, reassure them that it’s okay and the solicitor can work it out with them.

4) READINESS & BOOKING
- Work out whether they’re ready to speak with a solicitor now or just gathering information.
- If they ARE ready:
  - Ask: “Would you like me to book you in for a free 30-minute consultation with one of our solicitors?”
  - Only if they say yes:
    - Ask what days/times suit them.
    - Appointments Monday–Friday, 9am–5pm UK time ONLY. Never offer weekends or evenings.
    - Confirm final day/time and contact number.
- If they are NOT ready:
  - Respect that completely.
  - Say something like:
    “That’s absolutely fine, ${leadName || "there"}. I can give you some general guidance today, and if you ever want to speak to a solicitor we’re here.”

5) CLOSING
- If booked:
  “Great, ${leadName || "there"}. You’re booked in for [day/date] at [time]. The solicitor will call you on [number].”
- If not booked:
  “That’s absolutely fine. If you decide you’d like some help in future, you’re always welcome to get back in touch.”
- End warmly:
  “Thanks for your time today, ${leadName || "there"}, take care.”

LIMITS
- Never give detailed legal advice.
- If asked, say:
  “That’s something the solicitor can help you with in the consultation. My job is just to take a few details and arrange that for you if you want.”
- Never mention Twilio, OpenAI, AI, prompts, or models.
        `,
      },
    };

    oaWs.send(JSON.stringify(sessionUpdate));
    sessionSent = true;
    console.log("Session instructions sent to OpenAI");

    // ---- FIRST TURN: make the bot talk first ----
    const createResponse = {
      type: "response.create",
      response: {
        instructions: `
You are on a live phone call. The caller is ${leadName || "there"}.

Start the call politely and confidently, using your own natural wording:
- Greet them by name.
- Introduce yourself as Alex from Legacy Wills & Probate.
- Mention that they recently reached out about help with a probate matter.
- Explain that you’ll ask a few quick questions and, if they want, arrange a free 30-minute consultation with a solicitor.
- Ask if now is an okay time to talk.
        `,
      },
    };

    oaWs.send(JSON.stringify(createResponse));
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

  // ---- 3) Twilio -> OpenAI ----
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
        console.log("No custom name; keeping:", leadName);
      }

      console.log(
        "Call started:",
        data.start?.callSid,
        "streamSid:",
        streamSid
      );

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

  // ---- 4) OpenAI -> Twilio ----
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    console.log("OpenAI event:", event.type);

    if (event.type === "response.done") {
      console.log("OpenAI finished a response.");
    }

    // Handle BOTH possible audio event names, just in case
    if (
      event.type === "response.audio.delta" ||
      event.type === "response.output_audio.delta"
    ) {
      if (!streamSid) {
        logOnce(
          flags,
          "noStreamSid",
          "Cannot send audio back – no streamSid yet"
        );
        return;
      }

      if (!event.delta) {
        logOnce(flags, "noDelta", "Audio delta event had no delta field");
        return;
      }

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: event.delta, // base64 g711_ulaw from OpenAI
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
