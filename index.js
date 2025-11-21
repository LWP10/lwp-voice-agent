// index.js

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
        instructions:
          "You are a friendly UK male phone agent for Legacy Wills & Probate. " +
          "You speak clearly, keep answers short, and sound professional.",
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
          "Introduce yourself as Dan from Legacy Wills & Probate in one short sentence."
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
