const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { URL } = require("url");

// NEW: for recording download + Whisper + summary
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);

// Allow Twilio form posts (RecordingStatusCallback)
app.use(express.urlencoded({ extended: false }));

// Simple health-check route
app.get("/", (req, res) => {
  res.send("LWP Voice Bot server is running.");
});

///////////////////////////////////////////////////////////////////////////////
// 🔥 NEW: Twilio Recording Status Callback -> Whisper transcription -> summary
///////////////////////////////////////////////////////////////////////////////

// Zapier's Twilio API call must include, e.g.:
//
// &Record=true
// &RecordingStatusCallback=https://YOUR-RAILWAY-URL/twilio/recording-complete
// &RecordingStatusCallbackMethod=POST
//
app.post("/twilio/recording-complete", async (req, res) => {
  console.log("Recording callback body:", req.body);

  const { RecordingSid, RecordingUrl, CallSid, From, To } = req.body;

  if (!RecordingSid || !RecordingUrl) {
    console.log("Missing RecordingSid or RecordingUrl");
    return res.status(400).send("Missing required fields");
  }

  try {
    // 1) Download MP3 from Twilio
    const audioUrl = `${RecordingUrl}.mp3`;
    console.log("Downloading recording:", audioUrl);

    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuth = process.env.TWILIO_AUTH_TOKEN;

    const audioResp = await axios.get(audioUrl, {
      responseType: "arraybuffer",
      auth: {
        username: twilioSid,
        password: twilioAuth,
      },
    });

    const tempPath = path.join("/tmp", `${RecordingSid}.mp3`);
    fs.writeFileSync(tempPath, audioResp.data);
    console.log("Saved MP3 to:", tempPath);

    // 2) Transcribe with Whisper / GPT-4o Transcribe
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const transcription = await client.audio.transcriptions.create({
      // use a transcription-capable model available to your project
      // e.g. "gpt-4o-mini-transcribe", "gpt-4o-transcribe", or "whisper-1"
      model: "gpt-4o-mini-transcribe",
      file: fs.createReadStream(tempPath),
    });

    const transcriptText = transcription.text;
    console.log("Transcript length:", transcriptText.length);

    // 3) Summarise the call
    const summaryResp = await client.responses.create({
      model: "gpt-4.1-mini",
      input: `
You are summarising a recorded probate / estate planning call.

Transcript:
"""${transcriptText}"""

Please provide:
- A short 3–5 sentence overview of the situation.
- Bullet points for key facts: who passed away, executor/next of kin, rough estate size (under or over £325k), whether there's a will, and urgency.
- Bullet points for recommended next steps for the solicitor.
- Date and time of consultation (if booked)
      `,
    });

    const summary = summaryResp.output[0].content[0].text;
    console.log("Call summary:\n", summary);

// Send summary + transcript to Zapier / email / Sheets
    await axios.post(process.env.ZAPIER_HOOK_URL, {
  callSid: CallSid,
  from: From,
  to: To,
  transcript: transcriptText,   // full text (if you want it)
  summary,                      // your short version
});
    
    res.status(200).send("OK");
  } catch (err) {
    console.error("Error handling recording callback:", err.message || err);
    res.status(500).send("Error");
  }
});

///////////////////////////////////////////////////////////////
// Twilio WebSocket server at /media  (your existing voice agent)
///////////////////////////////////////////////////////////////

const wss = new WebSocket.Server({ server, path: "/media" });

// Helper to avoid spamming the same log line
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

  // Lead name + stream info
  let leadName = "there"; // default if we don't know name
  let streamSid = null;

  // Try to read name from WS URL query string (?name=Daniel)
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

  // --- OpenAI Realtime socket state ---
  let oaReady = false;
  let sessionSent = false;
  let introSent = false;

  // 1) Connect to OpenAI Realtime API
  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Send session.update when:
  // - OpenAI socket is open
  // - We have a streamSid (Twilio start event)
  function sendSessionIfReady() {
    if (!oaReady || !streamSid || sessionSent) return;

    const sessionUpdate = {
      type: "session.update",
      session: {
        // Audio in/out config MUST match Twilio (g711_ulaw)
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["audio", "text"],

        voice: "ballad",
        temperature: 0.7,

        // Let the server detect when caller finished speaking
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 1200,
        },

        // === MAIN BEHAVIOUR PROMPT ===
        instructions: `
Only ever speak in **English**.

You are **“Alex”**, a warm, calm, gender-neutral **British** virtual assistant (early 30s) calling from **Legacy Wills & Probate** in the UK.
Your job is to have a natural conversation, understand the caller’s probate situation at a high level, and—if they seem ready—help arrange a free 30-minute consultation with a solicitor.

The caller’s name is: **${leadName || "there"}**.
Do **not** ask for their name. Use their name naturally and occasionally, not constantly.

------------------------------------------------------------
LANGUAGE & VOICE
------------------------------------------------------------
- Always speak in clear, natural **British English**.
- Never use Spanish or any other language.
- Sound like a friendly UK call-centre agent: relaxed, warm, natural pace.
- Keep responses short: one or two sentences, then pause.
- Never mention prompts, AI, Twilio, or OpenAI.

------------------------------------------------------------
STYLE & RHYTHM
------------------------------------------------------------
- Talk like a real person, not like you’re reading a script.
- Use contractions: “I’m”, “you’re”, “that’s”.
- One question at a time, then wait for the answer.
- Never talk over the caller; wait for a clear pause.
- Briefly summarise long answers in one short sentence, then move on.

------------------------------------------------------------
OVERALL GOAL
------------------------------------------------------------
- Understand who the estate concerns and what help they need.
- Check roughly whether there is a will.
- Check roughly whether the estate looks **under £325,000** or **over £325,000**.
- If they seem ready, gently help them book a free 30-minute consultation.
- If they are not ready, fully respect that—no pressure.

------------------------------------------------------------
OPENING
------------------------------------------------------------
- You speak **first**, as soon as the call connects.
- Greet them warmly using their name, e.g. “Hi ${leadName || "there"}, it’s Alex calling from Legacy Wills & Probate.”
- Mention briefly that you’re calling because they recently reached out about getting some help with a probate matter.
- Explain that you’ll ask a few quick questions and, if they’d like, arrange a free 30-minute, no-obligation consultation with a solicitor.
- Ask if now is an okay time to talk.

------------------------------------------------------------
KEY QUESTIONS (GUIDELINE)
------------------------------------------------------------
1) Check broadly what’s going on:
   - Who has passed away, or who the probate relates to.
   - Whether they are the executor, next of kin, or another relative.
   - Be sensitive and respectful.

2) Will / executor:
   - Ask if there is a will.
   - If YES: ask if they are the executor or another family member.
   - If NO: ask if they are the next of kin or another relative helping with things.

3) Estate value (under / over £325k):
   - Ask: “Just so the solicitor can give you the right guidance, would you say the estate is likely under £325,000, or over £325,000?”
   - If they don’t know, reassure them that it’s okay and the solicitor can go through the details later.

------------------------------------------------------------
IF THE CALLER SAYS THEY’RE HANDLING PROBATE THEMSELVES
------------------------------------------------------------
- Acknowledge their effort and stress:
  - “That sounds like a lot to deal with, you’re doing really well handling it yourself.”
- Make it clear you’re there to support, not judge.
- If things sound complex or they say it’s getting tricky:
  - “If it starts to feel too much or complicated, that’s exactly what our solicitors can help you with in the free consultation.”

------------------------------------------------------------
BOOKING RULES
------------------------------------------------------------
- Only offer appointments **Monday–Friday, between 9am and 5pm UK time**.
- Never offer evenings or weekends.
- Ask what days/times work best for them.
- Confirm the agreed slot back clearly:
  - Day, date, time, and that a solicitor will call them on their number.
- Never invent a time or imply a booking unless they clearly agree.

------------------------------------------------------------
LEGAL LIMITS
------------------------------------------------------------
- Never give detailed legal advice.
- If they ask for legal advice, say:
  “That’s something a solicitor can help you with in the consultation. My role is just to take a few details and help arrange that for you if you’d like.”

------------------------------------------------------------
IF THEY’RE NOT READY TO BOOK
------------------------------------------------------------
- Respect that completely, do not push.
- Say something like:
  “No problem at all, ${leadName || "there"}. If you’d prefer to wait, that’s absolutely fine. If you ever want some help or a second opinion, you’re always welcome to get back in touch.”
- Always end warmly and politely.
        `,
      },
    };

    oaWs.send(JSON.stringify(sessionUpdate));
    sessionSent = true;
    console.log("Session instructions sent to OpenAI");

    // We may now be able to send the intro
    maybeSendIntro();
  }

  // Send a single intro so the bot talks first
  function maybeSendIntro() {
    if (!oaReady || !sessionSent || !streamSid || introSent) return;

    const intro = {
      type: "response.create",
      response: {
        instructions: `
Start the conversation now with a short, friendly greeting.

- Use the caller's name: ${leadName || "there"}.
- Say you are Alex calling from Legacy Wills & Probate.
- Mention you understand they recently reached out about getting some help with a probate matter.
- Explain you’ll ask a few quick questions and, if they’d like, arrange a free 30-minute, no-obligation consultation with a solicitor.
- Finish by asking if now is an okay time to talk.
        `,
      },
    };

    oaWs.send(JSON.stringify(intro));
    introSent = true;
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

  // 2) TWILIO → OPENAI (caller audio & call lifecycle)
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

      // Name from customParameters (sent by Twilio Function)
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

      // Now we can send session.update (and possibly intro)
      sendSessionIfReady();
      maybeSendIntro();
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

      // Send the audio chunk into OpenAI's input buffer
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

  // 3) OPENAI → TWILIO (bot audio back to caller)
  oaWs.on("message", (msg) => {
    let event;
    try {
      event = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (event.type) {
      console.log("OpenAI event:", event.type);
    }

    if (event.type === "response.done") {
      console.log("OpenAI finished a response.");
    }

    // Newer-style audio chunks
    if (event.type === "response.audio.delta" && event.delta) {
      if (!streamSid) {
        logOnce(
          flags,
          "noStreamSidDelta",
          "Cannot send audio back – no streamSid yet (delta)"
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

    // Older-style append events (safety net)
    if (event.type === "output_audio_buffer.append" && event.audio) {
      if (!streamSid) {
        logOnce(
          flags,
          "noStreamSidAppend",
          "Cannot send audio back – no streamSid yet (append)"
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

// Start HTTP server (Railway will set PORT)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
