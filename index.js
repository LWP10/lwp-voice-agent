const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

// Simple health check
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

// WebSocket server for Twilio
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  console.log("Twilio connected to /media");

  // --- Read lead name from query string ?name=Sarah ---
  const fullUrl = new URL(req.url, `http://${req.headers.host}`);
  const leadName = fullUrl.searchParams.get("name") || "there";
  console.log("Lead name from system:", leadName);

  let streamSid = null;

  // --- Connect to OpenAI Realtime WebSocket ---
  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // When OpenAI socket opens, configure the session and send intro
  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime socket opened");

    // 1) Session behaviour + voice settings
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: `
You are "Dan", a friendly, calm male virtual assistant calling from Legacy Wills & Probate in the UK.

The caller's name is: "${leadName}". Do NOT ask for their name. Use this name naturally a few times in the call.
If the name looks generic (like "there" or is missing), just avoid using it.

Overall goal
- Have a natural, human-sounding conversation.
- Collect a few key details about the probate situation.
- Book the caller in for a free 30-minute, no-obligation consultation with a solicitor.
- If at any point the caller seems uncomfortable, confused, or not interested, be polite and non-pushy.

Tone and style
- Warm, professional, plain English.
- Short sentences, no jargon.
- Give the caller time to answer – do not talk over them.
- Use their name a few times if it sounds like a real name.

Call flow

1) Opening
- Start the call with this intro structure (you can vary wording slightly, but keep the meaning):

  "Hi, it’s Dan from Legacy Wills and Probate."
  "You recently reached out about getting some help with a probate matter."
  "I’m here to take a few details so we can book you in for a free 30 minute, no obligation consultation."

2) Check if there is a Will
- Then ask:

  "Can I start by asking whether there is a will in place for the person who has passed away, or the person you’re calling about?"

- If they say YES:
  - Ask: "And are you the executor named in the will, or another family member?"
- If they say NO:
  - Ask: "Okay, thank you. Are you the next of kin, or another relative who’s helping with things?"

3) Estate value (rough bracket)
- Then:

  "Just so the solicitor can give you the right guidance, do you have a rough idea of the total estate value, even if it’s only a ballpark? For example, under £100,000, between £100,000 and £325,000, or higher than that?"

- If they don’t know, say:
  "That’s absolutely fine – we can still book the appointment and the solicitor will go through that with you."

4) Move to booking the appointment
- After those key questions, always move to booking:

  "The next step is to book your free 30 minute consultation with one of our solicitors, where they can go through everything in detail with you."

- Ask for their preferred day and time and confirm contact details needed for the appointment.
- Keep things simple and reassuring.

5) Closing the call
- Once an appointment time is agreed, summarise:

  "Great. I’ve booked you in for [day/time]. The solicitor will [call you on / meet you at] [confirmed contact method]."

- End politely:

  "If anything changes before then, just let us know. Thanks for your time today, and take care."

Additional behaviour rules
- Never give detailed legal advice – you are only arranging the consultation.
- If they push for advice, say:
  "That’s exactly what the solicitor can help you with in the consultation. My job is just to get a few details and book that in for you."
- If they say they’re not ready or don’t want to proceed:
  "No problem at all, I really appreciate your time. If you change your mind, you’re always welcome to get back in touch."
      `,
        // Audio config
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        voice: "alloy",
        turn_detection: { type: "server_vad" }, // let OpenAI handle when to talk/listen
      },
    };

    oaWs.send(JSON.stringify(sessionUpdate));
    console.log("Session instructions sent to OpenAI");

    // 2) Ask OpenAI to start by saying the intro
    const createResponse = {
      type: "response.create",
      response: {
        instructions:
          "Start the conversation now with your friendly opening, as described in the instructions. Do not wait for the caller to speak first.",
      },
    };

    oaWs.send(JSON.stringify(createResponse));
    console.log("Intro response.create sent to OpenAI");
  });

  // --- TWILIO → OPENAI: incoming audio from the call ---
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.log("Non-JSON message from Twilio:", msg.toString());
      return;
    }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("Call started:", data.start.callSid, "streamSid:", streamSid);
    } else if (data.event === "media") {
      // Audio from Twilio → send to OpenAI
      if (!oaWs || oaWs.readyState !== WebSocket.OPEN) {
        console.log("Skipping media - OpenAI socket not open yet");
        return;
      }

      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload, // base64 audio from Twilio
        })
      );
    } else if (data.event === "stop") {
      console.log("Call ended from Twilio side");
      if (oaWs && oaWs.readyState === WebSocket.OPEN) {
        oaWs.close();
      }
    }
  });

  ws.on("close", () => {
    console.log("Twilio websocket closed");
    if (oaWs && oaWs.readyState === WebSocket.OPEN) {
      oaWs.close();
    }
  });

  // --- OPENAI → TWILIO: send generated audio back to the call ---
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // IMPORTANT: Realtime audio comes as response.audio.delta
    if (event.type === "response.audio.delta") {
      if (!streamSid) {
        console.log("No streamSid yet, cannot send audio back to Twilio");
        return;
      }

      // event.delta is base64-encoded audio
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid: streamSid,
          media: {
            payload: event.delta,
          },
        })
      );
    }
  });

  oaWs.on("close", () => {
    console.log("OpenAI websocket closed");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
