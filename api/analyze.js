import OpenAI from "openai";

function parsePercent(value) {
  if (value == null) return null;
  if (typeof value === "number" && !Number.isNaN(value)) return Math.max(0, Math.min(100, value));
  if (typeof value === "string") {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const num = parseFloat(match[0]);
      if (!Number.isNaN(num)) return Math.max(0, Math.min(100, num));
    }
  }
  return null;
}

function parseModelOutputToStructured(text) {
  const reasons = [];
  if (!text || typeof text !== "string" || !text.trim()) {
    reasons.push("Model returned empty content.");
    return { fullness: null, stone: null, plastic: null, other: null, reasons, outputFormat: "empty" };
  }
  let parsed = null;
  let used = "json";
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    used = "regex";
    reasons.push("Output not valid JSON; attempted regex extraction.");
    const tryCoerce = {};
    const lower = text.toLowerCase();
    const grab = (key) => {
      const re = new RegExp(`${key}[^\n\r\d%]*(-?\\d+(?:\\.\\d+)?)%?`, "i");
      const m = lower.match(re);
      return m ? m[1] : null;
    };
    tryCoerce.fullness = grab("fullness|fill");
    tryCoerce.stone = grab("stone|rock");
    tryCoerce.plastic = grab("plastic");
    tryCoerce.other = grab("other|misc|remaining");
    parsed = tryCoerce;
  }
  const result = {
    fullness: parsePercent(parsed.fullness),
    stone: parsePercent(parsed.stone),
    plastic: parsePercent(parsed.plastic),
    other: parsePercent(parsed.other),
    reasons,
    outputFormat: used
  };
  if (used === "json" && (result.fullness == null || result.stone == null || result.plastic == null || result.other == null)) {
    reasons.push("JSON missing expected fields or contained non-numeric values.");
  }
  if (result.fullness == null) reasons.push("No fullness percentage could be extracted.");
  if (result.stone == null) reasons.push("No stone percentage could be extracted.");
  if (result.plastic == null) reasons.push("No plastic percentage could be extracted.");
  if (result.other == null) reasons.push("No other percentage could be extracted.");
  return result;
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "Missing OPENAI_API_KEY. Set it in project settings." });
      return;
    }

    const bodyStr = await readBody(req);
    let payload = {};
    try {
      payload = JSON.parse(bodyStr || "{}");
    } catch (_) {
      res.status(400).json({ error: "Invalid JSON body." });
      return;
    }

    let imageBase64 = payload.imageBase64 || "";
    if (typeof imageBase64 !== "string" || !imageBase64) {
      res.status(400).json({ error: "imageBase64 is required in JSON body." });
      return;
    }
    imageBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");

    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an assistant that analyzes images of a transparent box. Estimate how full the box is (as a % of total volume, there might be something floating from the top of the box, do not count these. the volunn refers to items continiously built up from the bottom of the box. Pay attention to the depth of the box as well while anyalizing.) and estimate the % of stone, plastic, and other materials inside. Respond with JSON: {fullness: %, stone: %, plastic: %, other: %}"
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }
      ]
    });

    const text = response.choices[0].message.content?.trim() || "";
    const structured = parseModelOutputToStructured(text);
    res.status(200).json({ raw: text, ...structured });
  } catch (error) {
    console.error(error);
    const status = (error && error.status) ? error.status : 500;
    const message = (error && error.error && error.error.message)
      ? error.error.message
      : (error && typeof error.message === "string")
        ? error.message
        : "Failed to analyze image.";
    res.status(status).json({ error: message });
  }
}


