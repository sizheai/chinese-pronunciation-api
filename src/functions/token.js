const { app } = require("@azure/functions");
const https = require("https");

app.http("token", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  route: "token",
  handler: async (request, context) => {
    const key = process.env.SPEECH_KEY;
    const region = process.env.SPEECH_REGION || "canadacentral";

    if (!key) {
      return {
        status: 500,
        jsonBody: { error: "Missing SPEECH_KEY in local.settings.json" },
      };
    }

    const options = {
      hostname: `${region}.api.cognitive.microsoft.com`,
      path: "/sts/v1.0/issueToken",
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Length": 0,
      },
    };

    try {
      const token = await new Promise((resolve, reject) => {
        const r = https.request(options, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
            else
              reject(
                new Error(`Token request failed: ${res.statusCode} ${data}`)
              );
          });
        });
        r.on("error", reject);
        r.end();
      });

      return { status: 200, jsonBody: { token, region } };
    } catch (e) {
      context.error(e);
      return { status: 500, jsonBody: { error: e.message } };
    }
  },
});
