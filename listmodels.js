const res = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
);
const data = await res.json();
if (!res.ok) { console.log(data); process.exit(1); }
for (const m of data.models) {
  if (m.supportedGenerationMethods?.includes("generateContent")) {
    console.log(m.name.replace("models/", ""));
  }
}