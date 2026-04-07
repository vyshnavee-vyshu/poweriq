// server/index.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// ------------------ config ------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
if (!GROQ_API_KEY) {
  console.error('Missing GROQ_API_KEY in .env');
  process.exit(1);
}

// ------------------ helpers ------------------
async function callGroq(messages, max_tokens = 400) {
  const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.3,
      max_tokens
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq API error ${res.status}: ${t}`);
  }
  const json = await res.json();
  return json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || JSON.stringify(json);
}

// tries to fetch recent rows, robust to missing "ts"
async function fetchRecentRows(limit = 50) {
  // Try by ts first
  try {
    const { data, error } = await supabase
      .from('power_readings')
      .select('*')
      .order('ts', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  } catch (eTs) {
    // If ts column missing or any error, try created_at
    console.warn('fetchRecentRows: ts query failed:', eTs.message || eTs);
    try {
      const { data, error } = await supabase
        .from('power_readings')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    } catch (eCreated) {
      console.warn('fetchRecentRows: created_at query failed:', eCreated.message || eCreated);
      // Last fallback: order by id descending
      const { data, error } = await supabase
        .from('power_readings')
        .select('*')
        .order('id', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    }
  }
}

// ------------------ API: Save snapshot ------------------
app.post('/api/data/save', async (req, res) => {
  try {
    const { ts, AC, Fridge, Heater, Lights, Fan } = req.body;
    const row = {
      // Attempt to insert ts if present in table; if ts doesn't exist, Supabase will ignore unknown columns,
      // but if it errors we catch below and try inserting without ts.
      ...(ts ? { ts } : {}),
      ac: Number(AC ?? 0),
      fridge: Number(Fridge ?? 0),
      heater: Number(Heater ?? 0),
      lights: Number(Lights ?? 0),
      fan: Number(Fan ?? 0)
    };

    let insertResult = await supabase.from('power_readings').insert([row]);
    if (insertResult.error) {
      // fallback: try insert without ts in case column doesn't exist
      console.warn('Insert with ts failed, retrying without ts:', insertResult.error.message || insertResult.error);
      const { data, error } = await supabase.from('power_readings').insert([{
        ac: row.ac, fridge: row.fridge, heater: row.heater, lights: row.lights, fan: row.fan
      }]);
      if (error) throw error;
      return res.json({ ok: true, inserted: data });
    }
    return res.json({ ok: true, inserted: insertResult.data });
  } catch (err) {
    console.error('/api/data/save error:', err.message || err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// ------------------ API: Get insights (Groq) ------------------
app.get('/api/insights', async (req, res) => {
  try {
    const rows = await fetchRecentRows(50);
    if (!rows || rows.length === 0) {
      return res.status(200).json({ error: 'No readings found. Seed data with /api/seed or insert some snapshots.' });
    }

    // compute averages safely
    const avg = { ac: 0, fridge: 0, heater: 0, lights: 0, fan: 0 };
    let count = 0;
    rows.forEach(r => {
      // skip rows which are null
      if (r) {
        avg.ac += Number(r.ac ?? 0);
        avg.fridge += Number(r.fridge ?? 0);
        avg.heater += Number(r.heater ?? 0);
        avg.lights += Number(r.lights ?? 0);
        avg.fan += Number(r.fan ?? 0);
        count++;
      }
    });
    if (count === 0) return res.json({ error: 'No numeric readings present.' });
    Object.keys(avg).forEach(k => avg[k] = Math.round(avg[k] / count));
    const latest = rows[0];

    const system = `You are PowerIQ, an intelligent energy assistant. Provide JSON ONLY with keys: summary (short string), suggestions (array of strings), diagnostics (array of {appliance, issue}).`;
    const user = `Latest snapshot: ${JSON.stringify(latest)}\nAverages over last ${count} samples: ${JSON.stringify(avg)}\nReturn JSON only.`;

    const llmText = await callGroq([{ role: 'system', content: system }, { role: 'user', content: user }], 400)
      .catch(err => { throw new Error('Groq call failed: ' + (err.message || err)); });

    // try parse JSON
    let parsed;
    try {
      const start = llmText.indexOf('{');
      const body = start >= 0 ? llmText.slice(start) : llmText;
      parsed = JSON.parse(body);
    } catch (parseErr) {
      // return raw LLM output as fallback
      console.warn('LLM JSON parse failed, returning raw text:', parseErr.message || parseErr);
      parsed = { raw: llmText };
    }

    return res.json({ insights: parsed, debug: { rows_sample_count: rows.length, avg } });
  } catch (err) {
    console.error('/api/insights error:', err.message || err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// ------------------ API: Seed demo data (server-side, uses same Supabase keys) ------------------
// Call GET /api/seed to insert ~720 demo rows. Use only in dev.
app.get('/api/seed', async (req, res) => {
  try {
    // quick guard: optional ?confirm=true in query to prevent accidental runs
    if (req.query.confirm !== 'true') {
      return res.json({ info: 'To seed demo data call /api/seed?confirm=true' });
    }

    // generate rows every 2 hours for 60 days
    const rows = [];
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    for (let t = start.getTime(); t <= now.getTime(); t += 2 * 3600 * 1000) {
      const ts = new Date(t).toISOString();
      const ac = Math.round(800 + Math.random() * 600);      // 800-1400
      const fridge = Math.round(100 + Math.random() * 80);   // 100-180
      const heater = Math.round(200 + Math.random() * 800);  // seasonal but ok
      const lights = Math.round(60 + Math.random() * 120);   // 60-180
      const fan = Math.round(80 + Math.random() * 70);       // 80-150
      rows.push({ ts, ac, fridge, heater, lights, fan });
      // batch in groups of 200 later
    }

    // insert in batches of 200
    const batchSize = 200;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await supabase.from('power_readings').insert(batch);
      if (error) {
        console.error('Seed batch error:', error);
        return res.status(500).json({ error: 'Seed failed: ' + (error.message || JSON.stringify(error)) });
      }
    }

    return res.json({ ok: true, inserted: rows.length });
  } catch (err) {
    console.error('/api/seed error:', err.message || err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// ------------------ API: Migration SQL (to run manually in Supabase SQL editor) ------------------
app.get('/api/migration-sql', (req, res) => {
  const sql = `
-- Run this in Supabase SQL editor to add ts column if missing:
alter table if exists power_readings add column if not exists ts timestamptz default now();
update power_readings set ts = coalesce(ts, created_at) where ts is null;
create index if not exists power_ts_idx on power_readings(ts);
`;
  res.type('text/plain').send(sql);
});

// ------------------ Static serve and start ------------------
app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/poweriqq.html')));

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PowerIQ server listening on http://localhost:${port}`));
