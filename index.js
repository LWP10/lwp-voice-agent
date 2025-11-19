const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

// Simple check route
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

// WebSocket endpoint for Twilio
const wss = new WebSocket.Server({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("Twilio connected to /media");

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      console.log("Non-JSON message:", msg.toString());
      return;
    }

    if (data.event === "start") {
      console.log("Call started:", data.start.callSid);
    } else if (data.event === "media") {
      // audio arrives here (base64)
      // later we will send this to OpenAI
    } else if (data.event === "stop") {
      console.log("Call ended");
    }
  });

  ws.on("close", () => {
    console.log("Twilio websocket closed");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
