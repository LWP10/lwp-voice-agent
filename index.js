// index.js //
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

/**
 * Simple check route
 * Opens if you visit: https://lwp-voice-agent-production.up.railway.app/
 */
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

/**
 * Test route to check OpenAI Realtime connection
 * Opens if you visit: https://<your-railway-domain>/test-realtime
 */
app.get("/test-realtime", (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.error("❌ OPENAI_API_KEY is not set in environment");
    return res.status(500).send("OPENAI_API_KEY is not set");
  }

  // Connect to OpenAI Realtime via WebSocket
  const url =
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";

  const oaWs = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime socket opened");

    // Tell the model how to behave on this session
    const sessionUpdate = {
      type: "session.update",
      session: {
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

Call flow

1) Opening and name
- Start the call with this exact intro, with short natural pauses between sentences:

  "Hi, it’s Dan from Legacy Wills and Probate."
  "You recently reached out about getting some help with a probate matter."
  "I’m here to take a few details so we can book you in for a free 30 minute, no obligation consultation."
  "First of all, can I just check your name?"

- If they give their name, repeat it back and use it naturally later in the call.
  Example: "Thanks, Sarah. Nice to speak with you."

2) Check if there is a Will
- After learning their name, ask:

  "Can I start by asking whether there is a will in place for the person who has passed away, or the person you’re calling about?"

- If they say YES:
  - Ask: "And are you the executor named in the will, or another family member?"
- If they say NO:
  - Ask: "Okay, thank you. Are you the next of kin, or another relative who’s helping with things?"

3) Estate value (rough bracket)
- Once the will / executor question is covered, ask for a rough value:

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

  "Great, [Name]. I’ve booked you in for [day/time]. The solicitor will [call you on / meet you at] [confirmed contact method]."

- End politely:

  "If anything changes before then, just let us know. Thanks for your time today, [Name], and take care."

Additional behaviour rules
- Never give detailed legal advice – you are only arranging the consultation.
- If they push for advice, say something like:
  "That’s exactly what the solicitor can help you with in the consultation. My job is just to get a few details and book that in for you."
- If they say they’re not ready or don’t want to proceed:
  "No problem at all, I really appreciate your time. If you change your mind, you’re always welcome to get back in touch."
`
        input_audio_format: "pcm16",
        output_audio_format: "pcm16"
      }
    };
    oaWs.send(JSON.stringify(sessionUpdate));

    // Ask it to generate a single intro sentence
    const createResponse = {
  type: "response.create",
  response: {
    instructions:
      "Say this intro clearly in a friendly UK male voice, with natural short pauses between sentences:" +
      " 'Hi, it’s Dan from Legacy Wills and Probate.' " +
      " (short pause) 'You recently reached out about getting some help with a probate matter.' " +
      " (short pause) 'I’m here to take a few details so we can book you in for a free 30 minute, no obligation consultation.' " +
      " (short pause) 'Fist of all, can I check your name?'"
  }
};
oaWs.send(JSON.stringify(createResponse));
  });

  oaWs.on("message", (msg) => {
    // For now we just log what the Realtime API sends back
    console.log("🔁 OpenAI event:", msg.toString());
  });

  oaWs.on("close", () => {
    console.log("❌ OpenAI Realtime socket closed");
  });

  oaWs.on("error", (err) => {
    console.error("🔥 OpenAI WS error:", err);
  });

  res.send("Started OpenAI Realtime test – check Railway logs.");
});

/**
 * WebSocket endpoint for Twilio Media Streams
 * Twilio connects here when your Function returns <Connect><Stream url="wss://.../media" /></Connect>
 */
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("📞 Twilio connected to /media");

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (err) {
      console.log("Non-JSON message from Twilio:", msg.toString());
      return;
    }

    if (data.event === "start") {
      console.log("▶️ Call started:", data.start.callSid);
    } else if (data.event === "media") {
      // This is where the raw audio arrives from Twilio (base64)
      // We'll forward this to OpenAI later.
      // For now, just log that we received a chunk.
      console.log("🎧 Received media chunk (size):", data.media.payload.length);
    } else if (data.event === "stop") {
      console.log("⏹ Call ended");
    }
  });

  ws.on("close", () => {
    console.log("🔌 Twilio websocket closed");
  });
});

// Start HTTP server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 LWP Voice Agent server running on port ${PORT}`);
});
