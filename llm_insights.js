require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// ===== Supabase setup =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('❌ Missing Supabase env vars');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ===== Groq setup =====
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
if (!GROQ_API_KEY) throw new Error('❌ Missing GROQ_API_KEY');

// ===== Groq call helper =====
async function callGroq(messages, max_tokens = 400) {
  const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.4,
      max_tokens
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return (
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    JSON.stringify(data)
  );
}

// ===== API: Save snapshot =====
app.post('/api/data/save', async (req, res) => {
  try {
    const { ts, AC, Fridge, Heater, Lights, Fan } = req.body;
    const row = {
      ts: ts || new Date().toISOString(),
      ac: AC || 0,
      fridge: Fridge || 0,
      heater: Heater || 0,
      lights: Lights || 0,
      fan: Fan || 0
    };

    const { error } = await supabase.from('power_readings').insert([row]);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== API: Get AI insights =====
app.get('/api/insights', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('power_readings')
      .select('*')
      .order('ts', { ascending: false })
      .limit(50);

    if (error) throw error;
    if (!data || !data.length) return res.json({ error: 'No readings found' });

    const avg = { ac: 0, fridge: 0, heater: 0, lights: 0, fan: 0 };
    for (const r of data) {
      avg.ac += r.ac || 0;
      avg.fridge += r.fridge || 0;
      avg.heater += r.heater || 0;
      avg.lights += r.lights || 0;
      avg.fan += r.fan || 0;
    }
    const n = data.length;
    Object.keys(avg).forEach(k => (avg[k] = Math.round(avg[k] / n)));
    const latest = data[0];

    const systemPrompt = `
You are PowerIQ, an AI that analyzes household power consumption.
Give clear JSON insights with structure:
{
  "summary": "short text",
  "suggestions": ["tip1","tip2","tip3"],
  "diagnostics": [{"appliance":"AC","issue":"high usage"}]
}`;

    const userPrompt = `
Latest snapshot: ${JSON.stringify(latest)}
Averages (past ${n} readings): ${JSON.stringify(avg)}
Respond in JSON only.`;

    const reply = await callGroq([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);

    let parsed;
    try {
      parsed = JSON.parse(reply.slice(reply.indexOf('{')));
    } catch {
      parsed = { raw: reply };
    }

    res.json({ insights: parsed });
  } catch (err) {
    console.error('Insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== Serve frontend =====
app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/poweriqq.html'))
);

// ===== Health check =====
app.get('/health', (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log(`🚀 PowerIQ server running on http://localhost:${port}`)
);
