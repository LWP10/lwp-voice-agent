// index.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);

// Simple HTTP check
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

// WebSocket endpoint for Twilio
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  console.log("Twilio connected to /media");

  // ----- Read lead name from query string -----
  const url = new URL(req.url, "http://dummy");
  const leadName = url.searchParams.get("name") || "there";
  console.log("Lead name from system:", leadName);

  // We’ll store Twilio’s streamSid so we can send audio back correctly
  let streamSid = null;

  // Flag to make sure we only send media once OpenAI is ready
  let openAiReady = false;

  // ----- OpenAI Realtime WebSocket -----
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

    // 1) Session behaviour + audio formats
    const sessionUpdate = {
      type: "session.update",
      session: {
        // Use µ-law to match Twilio
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],
        instructions: `
You are "Dan", a friendly, calm male virtual assistant calling from Legacy Wills & Probate in the UK.

The lead's name (if available) is: "${leadName}". Use this naturally in conversation.

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

Call flow

1) Opening (DO NOT ask their name – you already have it if provided)
- Start the call with this intro, with short natural pauses between sentences:

  "Hi, it’s Dan from Legacy Wills and Probate."
  "You recently reached out about getting some help with a probate matter."
  "I’m here to take a few details so we can book you in for a free 30 minute, no obligation consultation."

- If you know their name, use it early, e.g. "Hi Sarah, it’s Dan from Legacy Wills and Probate."

2) Check if there is a Will
- Ask:

  "Can I start by asking whether there is a will in place for the person who has passed away, or the person you’re calling about?"

- If they say YES:
  - Ask: "And are you the executor named in the will, or another family member?"
- If they say NO:
  - Ask: "Okay, thank you. Are you the next of kin, or another relative who’s helping with things?"

3) Estate value (rough bracket)
- Ask:

  "Just so the solicitor can give you the right guidance, do you have a rough idea of the total estate value, even if it’s only a ballpark? For example, under £100,000, between £100,000 and £325,000, or higher than that?"

- If they don’t know, say:
  "That’s absolutely fine – we can still book the appointment and the solicitor will go through that with you."

4) Move to booking the appointment
- After those key questions, always move to booking:

  "The next step is to book your free 30 minute consultation with one of our solicitors, where they can go through everything in detail with you."

- Ask for their preferred day and time and confirm contact details needed for the appointment.

5) Closing the call
- Once an appointment time is agreed, summarise:

  "Great, [Name]. I’ve booked you in for [day/time]. The solicitor will [call you on / meet you at] [confirmed contact method]."

- End politely:

  "If anything changes before then, just let us know. Thanks for your time today, [Name], and take care."

Additional behaviour rules
- Never give detailed legal advice – you are only arranging the consultation.
- If they push for advice, say:
  "That’s exactly what the solicitor can help you with in the consultation. My job is just to get a few details and book that in for you."
- If they say they’re not ready or don’t want to proceed:
  "No problem at all, I really appreciate your time. If you change your mind, you’re always welcome to get back in touch."
        `,
      },
    };
    oaWs.send(JSON.stringify(sessionUpdate));
    console.log("Session instructions sent to OpenAI");

    // 2) Ask it to generate the opening speech immediately
    const createResponse = {
      type: "response.create",
      response: {
        instructions:
          "Say your opening script now in a friendly UK male voice, then wait for the caller's response and continue naturally using your instructions.",
      },
    };
    oaWs.send(JSON.stringify(createResponse));
    console.log("Intro response.create sent to OpenAI");

    openAiReady = true;
  });

  oaWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err);
  });

  // ----- TWILIO → OPENAI: forwarding caller audio -----
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("Call started:", data.start.callSid, "streamSid:", streamSid);
    } else if (data.event === "media") {
      if (!openAiReady) {
        console.log("Skipping media - OpenAI socket not open yet");
        return;
      }
      // Twilio is sending base64-encoded µ-law audio.
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        })
      );
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } else if (data.event === "stop") {
      console.log("Call ended from Twilio side");
      ws.close();
      oaWs.close();
    }
  });

  ws.on("close", () => {
    console.log("Twilio websocket closed");
    oaWs.close();
  });

  // ----- OPENAI → TWILIO: send generated audio back -----
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // Helpful to see what’s coming back:
    // console.log("OpenAI event:", event.type);

    if (event.type === "output_audio_buffer.append") {
      if (!streamSid) return; // we don't know where to send yet

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            // event.audio is base64-encoded µ-law audio
            payload: event.audio,
          },
        })
      );
    }
  });

  oaWs.on("close", () => {
    console.log("OpenAI websocket closed");
    ws.close();
  });
});

// Start the HTTP server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
