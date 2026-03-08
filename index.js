const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const SYSTEM_PROMPT = `You are SpaFix AI, an expert hot tub and spa repair assistant. You help homeowners diagnose and fix their hot tubs themselves, saving them money on service calls.

Your approach:
- Ask targeted clarifying questions to narrow down the problem
- Give clear, step-by-step diagnostic and repair instructions
- Be specific about tools needed, part numbers when relevant, and safety warnings
- Use plain language — the user is a DIYer, not a technician
- Keep responses concise but complete. Use bullet points or numbered steps when helpful
- Cover all major hot tub brands: Balboa, Gecko, Sundance, Jacuzzi, Hot Spring, Cal Spa, Master Spa, Bullfrog, etc.
- If something requires a licensed electrician (e.g. panel work, 240V wiring), say so clearly
- You do NOT have the ability to view photos in the free tier

Format responses using plain text. Use **bold** for important terms. Use numbered steps for procedures.`;

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data?.error?.message || "API error" });
    }
    const text = data.content?.map((b) => b.text || "").join("") || "";
    res.json({ reply: text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("SpaFix API is running ✓"));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`SpaFix server running on port ${PORT}`));
