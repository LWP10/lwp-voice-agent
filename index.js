const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

// Simple health check route
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

// WebSocket endpoint for Twilio Media Streams
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws, req) => {
  console.log("Twilio connected to /media");

  // (Optional) read name from query string if you ever want to use it later
  const qs = req.url.split("?")[1] || "";
  const params = new URLSearchParams(qs);
  const leadNameFromSystem = params.get("name") || null;
  console.log("Lead name from system (if any):", leadNameFromSystem);

  // Connect to OpenAI Realtime API
  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: "Bearer " + process.env.OPENAI_API_KEY,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  oaWs.on("open", () => {
    console.log("🟢 OpenAI Realtime socket opened");

    // 1) Tell the model how to behave on this session
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
  "First of all, can I just take your name?"

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
        `,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        voice: "alloy"
      }
    };

    oaWs.send(JSON.stringify(sessionUpdate));

    // 2) Kick off the first spoken response (the opening script)
    const firstResponse = {
      type: "response.create",
      response: {
        instructions: `
Follow your call flow and speak the full opening script from step 1, including asking for their name.
Do not wait for the caller to speak first. Start talking as soon as the call connects.`
      }
    };

    oaWs.send(JSON.stringify(firstResponse));
  });

  // TWILIO ➜ OPENAI: send caller audio into the model
  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.log("Non-JSON message from Twilio:", msg.toString());
      return;
    }

    if (data.event === "start") {
      console.log("Call started:", data.start.callSid);
    } else if (data.event === "media") {
      // Audio chunk from Twilio (base64-encoded)
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        })
      );
      // Tell OpenAI to process what it has so far
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.commit"
        })
      );
    } else if (data.event === "stop") {
      console.log("Call ended");
      oaWs.close();
    }
  });

  // OPENAI ➜ TWILIO: send generated audio back to caller
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // Realtime API will stream audio chunks as output_audio_buffer.append
    if (event.type === "output_audio_buffer.append") {
      ws.send(
        JSON.stringify({
          event: "media",
          media: {
            payload: event.audio
          }
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
