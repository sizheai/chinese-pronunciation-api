const { app } = require("@azure/functions");
const SpeechSDK = require("microsoft-cognitiveservices-speech-sdk");

/**
 * Robust WAV parser:
 * - Validates RIFF/WAVE
 * - Locates "fmt " chunk and "data" chunk
 * - Extracts audio format/channels/sampleRate/bitsPerSample
 * - Provides dataOffset/dataSize and pcmBytes
 */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    throw new Error("Invalid WAV buffer.");
  }

  const chunkId = buf.toString("ascii", 0, 4);
  const format = buf.toString("ascii", 8, 12);
  if (chunkId !== "RIFF" || format !== "WAVE") {
    throw new Error("Invalid WAV: expected RIFF/WAVE.");
  }

  let offset = 12; // start of first subchunk
  let fmt = null;
  let data = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;

    if (payloadOffset + size > buf.length) {
      break; // corrupt/short file
    }

    if (id === "fmt ") {
      // PCM fmt chunk is at least 16 bytes
      if (size < 16) throw new Error("Invalid WAV fmt chunk.");
      const audioFormat = buf.readUInt16LE(payloadOffset + 0); // 1=PCM
      const numChannels = buf.readUInt16LE(payloadOffset + 2);
      const sampleRate = buf.readUInt32LE(payloadOffset + 4);
      const bitsPerSample = buf.readUInt16LE(payloadOffset + 14);

      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    }

    if (id === "data") {
      data = { dataOffset: payloadOffset, dataSize: size };
    }

    // chunks are word-aligned (pad to even)
    offset = payloadOffset + size + (size % 2);
  }

  if (!fmt) throw new Error("WAV missing fmt chunk.");
  if (!data) throw new Error("WAV missing data chunk.");

  const pcmBytes = data.dataSize;
  return {
    ...fmt,
    ...data,
    pcmBytes,
  };
}

/**
 * Reads body safely even if client sends UTF-16.
 * 1) Try UTF-8 decode
 * 2) If JSON parse fails, try UTF-16LE decode
 */
async function readJsonBody(request) {
  const ab = await request.arrayBuffer();
  const buf = Buffer.from(ab);

  // Try UTF-8 first (correct for JSON)
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (_) {
    // Try UTF-16LE fallback (PowerShell sometimes sends this)
    try {
      return JSON.parse(buf.toString("utf16le"));
    } catch (e2) {
      throw new Error(
        "Invalid JSON body (could not decode as UTF-8 or UTF-16LE)."
      );
    }
  }
}

app.http("assess", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const body = await readJsonBody(request);
      const { audioBase64, referenceText, locale } = body || {};

      if (!audioBase64) {
        return {
          status: 400,
          jsonBody: { error: "audioBase64 (string) is required." },
        };
      }
      if (!referenceText) {
        return {
          status: 400,
          jsonBody: { error: "referenceText (string) is required." },
        };
      }
      if (!locale) {
        return {
          status: 400,
          jsonBody: { error: "locale (string) is required." },
        };
      }

      const speechKey = process.env.SPEECH_KEY || process.env.AZURE_SPEECH_KEY;
      const speechRegion =
        process.env.SPEECH_REGION || process.env.AZURE_SPEECH_REGION;

      if (!speechKey || !speechRegion) {
        return {
          status: 500,
          jsonBody: {
            error: "Missing SPEECH_KEY or SPEECH_REGION in environment.",
          },
        };
      }

      const wavBuffer = Buffer.from(audioBase64, "base64");
      const header = parseWav(wavBuffer);

      // Validate: PCM, mono, 16-bit
      if (header.audioFormat !== 1) {
        return {
          status: 400,
          jsonBody: {
            error: `audioFormat=${header.audioFormat}. Expected PCM (1).`,
          },
        };
      }
      if (header.numChannels !== 1) {
        return {
          status: 400,
          jsonBody: {
            error: `channels=${header.numChannels}. Expected mono (1).`,
          },
        };
      }
      if (header.bitsPerSample !== 16) {
        return {
          status: 400,
          jsonBody: {
            error: `bitsPerSample=${header.bitsPerSample}. Expected 16.`,
          },
        };
      }

      // IMPORTANT: slice using true dataOffset, not 44
      const pcm = wavBuffer.subarray(
        header.dataOffset,
        header.dataOffset + header.dataSize
      );

      const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
        speechKey,
        speechRegion
      );
      speechConfig.speechRecognitionLanguage = locale;

      const streamFormat = SpeechSDK.AudioStreamFormat.getWaveFormatPCM(
        header.sampleRate,
        16,
        1
      );

      const pushStream =
        SpeechSDK.AudioInputStream.createPushStream(streamFormat);
      pushStream.write(pcm);
      pushStream.close();

      const audioConfig = SpeechSDK.AudioConfig.fromStreamInput(pushStream);

      const pronConfig = new SpeechSDK.PronunciationAssessmentConfig(
        referenceText,
        SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
        SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
        true
      );

      const recognizer = new SpeechSDK.SpeechRecognizer(
        speechConfig,
        audioConfig
      );
      pronConfig.applyTo(recognizer);

      const result = await new Promise((resolve, reject) => {
        recognizer.recognizeOnceAsync(resolve, reject);
      });

      const pa = SpeechSDK.PronunciationAssessmentResult.fromResult(result);

      // Raw JSON (optional)
      let rawJson = null;
      try {
        const raw = result.properties.getProperty(
          SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult
        );
        rawJson = raw ? JSON.parse(raw) : null;
      } catch (_) {}

      recognizer.close();

      return {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        jsonBody: {
          locale,
          referenceText,
          recognizedText: result.text || "",
          scores: {
            accuracyScore: pa.accuracyScore ?? 0,
            pronunciationScore: pa.pronunciationScore ?? 0,
            completenessScore: pa.completenessScore ?? 0,
            fluencyScore: pa.fluencyScore ?? 0,
            prosodyScore: pa.prosodyScore ?? null,
          },
          audioInfo: header,
          raw: rawJson,
        },
      };
    } catch (err) {
      context.log("assess error:", err);
      return { status: 500, jsonBody: { error: err.message || String(err) } };
    }
  },
});
