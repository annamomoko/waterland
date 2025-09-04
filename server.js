import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });
const apiKey = process.env.OPENAI_API_KEY;
const client = apiKey ? new OpenAI({ apiKey }) : null;

app.use(express.static(".")); // Serve index.html

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
    // not strict JSON; try to coerce with regex
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

app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!client) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY. Set it in .env or environment." });
    }
    const imageBase64 = fs.readFileSync(req.file.path, { encoding: "base64" });
    const response = await client.chat.completions.create({
      model: "gpt-5", // or gpt-4o for more accuracy
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
    res.json({ raw: text, ...structured });
  } catch (error) {
    console.error(error);
    const status = (error && error.status) ? error.status : 500;
    const message = (error && error.error && error.error.message)
      ? error.error.message
      : (error && typeof error.message === "string")
        ? error.message
        : "Failed to analyze image.";
    res.status(status).json({ error: message });
  } finally {
    try {
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (_) {
      // ignore cleanup errors
    }
  }
});

app.listen(3000, () => console.log("Server running at http://localhost:3000"));
