const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

const app = express();
const server = http.createServer(app);

// Health check
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

// Twilio Media Stream websocket
const wss = new WebSocket.Server({ server, path: "/media" });

// helper to avoid spammy logs
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

  // 1) Try to read name from URL query (?name=daniel) – not essential but nice
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

  // OpenAI socket state
  let oaReady = false;
  let sessionSent = false;

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
Only ever speak in **English**.

You are **“Alex”**, a warm, calm, gender-neutral **British** virtual assistant (early 30s) calling from **Legacy Wills & Probate** in the UK.
Your job is to have a natural conversation, understand the caller’s probate situation at a high level, and—if they seem ready—help arrange a free 30-minute consultation with a solicitor.

Do **not** ask for their name.
The caller’s name is: **${leadName || "there"}**.
Use their name naturally and occasionally, not excessively.

[... keep all your long instructions here unchanged ...]
        `,
      },
    };

    oaWs.send(JSON.stringify(sessionUpdate));
    sessionSent = true;
    console.log("Session instructions sent to OpenAI");
  }

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime socket opened");
    oaReady = true;
    sendSessionIfReady();
  });

  oaWs.on("error", (err) => {
    console.error("OpenAI websocket error:", err.message || err);
  });

  // 3) TWILIO → OPENAI
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
          audio: data.media.payload, // base64 g711_ulaw from Twilio
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

  // 4) OPENAI → TWILIO  (THIS IS THE IMPORTANT BIT)
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    // log type to help us debug
    if (event.type) {
      console.log("OpenAI event:", event.type);
    }

    if (event.type === "response.done") {
      console.log("OpenAI finished a response.");
    }

    // new-style audio events
    if (event.type === "response.audio.delta" && event.delta) {
      if (!streamSid) {
        logOnce(
          flags,
          "noStreamSid",
          "Cannot send audio back – no streamSid yet"
        );
        return;
      }

      console.log("Sending audio chunk (response.audio.delta) to Twilio");
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

    // older-style audio events (just in case)
    if (event.type === "output_audio_buffer.append" && event.audio) {
      if (!streamSid) {
        logOnce(
          flags,
          "noStreamSidOld",
          "Cannot send audio back – no streamSid yet (old event)"
        );
        return;
      }

      console.log("Sending audio chunk (output_audio_buffer.append) to Twilio");
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            payload: event.audio, // base64 g711_ulaw
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

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
