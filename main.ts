// Fanoos e Ilm — Voice Bridge
// Tiny HTTPS service: app sends text + voice, bridge synthesises with
// Microsoft Edge TTS (server-side WebSocket) and returns an MP3.
// Plain HTTPS GET/POST works in any phone browser/WebView, unlike the
// direct browser WebSocket to Edge TTS which never connects on the
// user's phone.
//
// No secrets, no API keys (Edge TTS "read aloud" endpoint needs none).
//
// Endpoints:
//   GET  /?text=<urdu text>&voice=<voice|seat>
//   POST /  JSON body: {"text": "...", "voice": "..."}
// Voices (allowlist ONLY):
//   ur-PK-UzmaNeural  (seat "girl")
//   ur-PK-AsadNeural  (seat "man")
//   ur-IN-GulNeural   (seat "child", spoken at rate -10%)
// Response: audio/mpeg (MP3, 24 kHz, 48 kbit/s, mono)

import { MsEdgeTTS, OUTPUT_FORMAT } from "npm:msedge-tts@2.1.1";
import { HttpsProxyAgent } from "npm:https-proxy-agent@7.0.6";
import type { Agent } from "node:http";

const MAX_TEXT_CHARS = 600;
const SYNTH_TIMEOUT_MS = 45_000;

interface VoiceSpec {
  voice: string;
  rate?: string;
}

const VOICES: Record<string, VoiceSpec> = {
  "ur-PK-UzmaNeural": { voice: "ur-PK-UzmaNeural" }, // girl
  "ur-PK-AsadNeural": { voice: "ur-PK-AsadNeural" }, // man
  "ur-IN-GulNeural": { voice: "ur-IN-GulNeural", rate: "-10%" }, // child seat
};

// Friendly seat names the app may send instead of the Edge voice name.
const SEAT_ALIASES: Record<string, string> = {
  girl: "ur-PK-UzmaNeural",
  man: "ur-PK-AsadNeural",
  child: "ur-IN-GulNeural",
};

function resolveVoice(raw: string | null | undefined): VoiceSpec | null {
  if (!raw) return null;
  const name = SEAT_ALIASES[raw] ?? raw;
  return VOICES[name] ?? null;
}

// If an egress proxy is configured in the environment (local dev VM),
// route the Edge WebSocket through it. On Deno Deploy there is no such
// variable and the connection goes direct.
function proxyAgent(): Agent | undefined {
  const url = Deno.env.get("HTTPS_PROXY") ?? Deno.env.get("https_proxy") ??
    Deno.env.get("ALL_PROXY") ?? Deno.env.get("all_proxy");
  if (!url) return undefined;
  try {
    return new HttpsProxyAgent(url) as unknown as Agent;
  } catch {
    return undefined;
  }
}

async function synthesise(
  spec: VoiceSpec,
  text: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const agent = proxyAgent();
  const tts = new MsEdgeTTS(agent ? { agent } : undefined);
  try {
    await tts.setMetadata(
      spec.voice,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
    );
    const { audioStream } = spec.rate
      ? tts.toStream(text, { rate: spec.rate })
      : tts.toStream(text);

    const chunks: Uint8Array[] = [];
    let total = 0;
    const collect = (async () => {
      for await (const chunk of audioStream) {
        const u8 = chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk as ArrayBufferLike);
        chunks.push(u8);
        total += u8.length;
      }
    })();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("synthesis timed out")),
        SYNTH_TIMEOUT_MS,
      )
    );
    await Promise.race([collect, timeout]);

    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    if (out.length === 0) throw new Error("empty audio from TTS");
    return out;
  } finally {
    try {
      tts.close();
    } catch {
      // already closed
    }
  }
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  let text: string | null = null;
  let voiceRaw: string | null = null;

  if (req.method === "GET") {
    const url = new URL(req.url);
    text = url.searchParams.get("text");
    voiceRaw = url.searchParams.get("voice");
    if (!text && !voiceRaw) {
      return new Response(
        "Fanoos voice bridge is running. Use GET ?text=...&voice=... or POST JSON {text, voice}.",
        { status: 200, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
  } else if (req.method === "POST") {
    try {
      const body = await req.json();
      text = typeof body?.text === "string" ? body.text : null;
      voiceRaw = typeof body?.voice === "string" ? body.voice : null;
    } catch {
      return jsonError(400, "invalid JSON body");
    }
  } else {
    return jsonError(405, "method not allowed");
  }

  text = text?.trim() ?? "";
  if (!text) return jsonError(400, "missing text");
  if (text.length > MAX_TEXT_CHARS) {
    return jsonError(413, `text too long (max ${MAX_TEXT_CHARS} chars)`);
  }
  const spec = resolveVoice(voiceRaw);
  if (!spec) {
    return jsonError(
      400,
      "unknown voice (allowed: ur-PK-UzmaNeural, ur-PK-AsadNeural, ur-IN-GulNeural, or seats girl/man/child)",
    );
  }

  try {
    const mp3 = await synthesise(spec, text);
    return new Response(mp3, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "audio/mpeg",
        "Content-Length": String(mp3.length),
        // Same text+voice always yields equivalent speech — let the app
        // and any CDN cache it.
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    console.error("synthesis failed:", err);
    return jsonError(502, "speech synthesis failed");
  }
}

const port = Number(Deno.env.get("PORT") ?? 8000);
Deno.serve({ port }, handle);
