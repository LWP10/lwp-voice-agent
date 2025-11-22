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

  const flags = {}; // for one-time logs

  // 1) Get lead name from query string (…/media?name=Dan)
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
        // IMPORTANT: Twilio audio is ulaw
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],
        voice: "alloy",
        instructions: `
You are "Dan", a friendly, calm male virtual assistant calling from Legacy Wills & Probate in the UK.

Overall goal
- Have a natural, human-sounding conversation.
- Collect a few key details about the probate situation.
- Book the caller in for a free 30-minute, no-obligation consultation with a solicitor.
- If at any point the caller seems uncomfortable, confused, or not interested, be polite and non-pushy.

Tone and style
- Warm, professional, plain English.
- Short sentences, no jargon.
- Give the caller time to answer – do not talk over them.
- Use their name a few times in the call so it feels personal.
- The caller's name is: ${leadName || "there"}.

Call flow

1) Opening (do NOT ask for their name, you already have it)
- Say this intro clearly, with short natural pauses:

  "Hi, it’s Dan from Legacy Wills and Probate."
  "You recently reached out about getting some help with a probate matter."
  "I’m here to take a few details so we can book you in for a free 30 minute, no obligation consultation."
  "Is now a good time to chat for a few minutes, ${leadName || "there"}?"

2) Check if there is a Will
- Ask:

  "Can I start by asking whether there is a will in place for the person who has passed away, or the person you’re calling about?"

- If they say YES:
  - Ask: "And are you the executor named in the will, or another family member?"

- If they say NO:
  - Ask: "Okay, thank you. Are you the next of kin, or another relative who’s helping with things?"

3) Estate value (rough bracket)
- Then ask:

  "Just so the solicitor can give you the right guidance, do you have a rough idea of the total estate value, even if it’s only a ballpark? For example, under £100,000, between £100,000 and £325,000, or higher than that?"

- If they don’t know:
  "That’s absolutely fine – we can still book the appointment and the solicitor will go through that with you."

4) Move to booking the appointment
- After these questions:

  "The next step is to book your free 30 minute consultation with one of our solicitors, where they can go through everything in detail with you."

- Ask for their preferred day and time and confirm contact details needed for the appointment.

5) Closing
- Once an appointment time is agreed, summarise:

  "Great, ${leadName || "there"}. I’ve booked you in for [day/time]. The solicitor will [call you on / meet you at] [confirmed contact method]."

- End politely:

  "If anything changes before then, just let us know. Thanks for your time today, ${leadName || "there"}, and take care."

Rules
- Never give detailed legal advice – your job is only to arrange the consultation.
- If they ask for legal advice, say:
  "That’s exactly what the solicitor can help you with in the consultation. My job is just to get a few details and book that in for you."
- If they’re not ready or don’t want to proceed:
  "No problem at all, I really appreciate your time. If you change your mind, you’re always welcome to get back in touch."
        `,
      },
    };

    oaWs.send(JSON.stringify(sessionUpdate));
    console.log("Session instructions sent to OpenAI");

    // Kick off the first spoken response
    const createResponse = {
      type: "response.create",
      response: {
        instructions: "Start the call now with your opening script.",
      },
    };
    oaWs.send(JSON.stringify(createResponse));
    console.log("Intro response.create sent to OpenAI");
  });

  oaWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err.message || err);
  });

  // 3) TWILIO → OPENAI (caller audio)
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || data.streamSid || null;
      console.log("Call started:", data.start?.callSid, "streamSid:", streamSid);
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
          audio: data.media.payload, // base64 ulaw
        })
      );
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }

    if (data.event === "stop") {
      console.log("Call ended from Twilio side");
      ws.close();
      oaWs.close();
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

    // Helpful debug
    if (event.type === "response.completed") {
      console.log("OpenAI finished a response.");
    }

    if (event.type === "output_audio_buffer.append") {
      if (!streamSid) {
        logOnce(flags, "noStreamSid", "Cannot send audio back – no streamSid yet");
        return;
      }

      // event.audio is base64 g711_ulaw
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: event.audio,
          },
        })
      );
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
