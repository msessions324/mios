// netlify/functions/core.js
// CORE backend — the only piece of MIOS that runs server-side.
// Holds GROQ_API_KEY safely (never sent to the browser) and gives the model
// real tool access to Marcus Industries' live feeds and MI-Pulse hardware.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const LAT = 37.6775, LON = -113.0619;
const BBOX = { lamin: 36.88, lamax: 38.48, lomin: -114.06, lomax: -112.06 };

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather conditions for Cedar City, UT.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_storm_alerts",
      description: "Active NWS storm/weather alerts for Cedar City, UT.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_flights",
      description: "Aircraft currently within 65 nautical miles of Cedar City Regional Airport (KCDC).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_iss",
      description: "The ISS's current position, altitude, velocity, and distance from Cedar City.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_longshot",
      description: "Latest telemetry from Marcus's Longshot MI-02 hardware — temperature, pressure, GPS, signal strength.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "control_lights",
      description: "Control the MI-Pulse LED strip under Marcus's desk.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["on", "off", "color", "rainbow", "flash"] },
          color_hex: { type: "string", description: "6-digit hex, no #, e.g. ff0000. Used by color and flash modes." },
          flash_seconds: { type: "number", description: "Flash duration in seconds, flash mode only. Default 3." },
        },
        required: ["mode"],
      },
    },
  },
];

async function safeFetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function executeTool(name, args, creds) {
  try {
    if (name === "get_weather") {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FDenver`;
      const json = await safeFetch(url);
      return JSON.stringify(json.current);
    }
    if (name === "get_storm_alerts") {
      const url = `https://api.weather.gov/alerts/active?point=${LAT},${LON}`;
      const json = await safeFetch(url, { headers: { Accept: "application/geo+json" } });
      const alerts = (json.features || []).map(f => ({ event: f.properties.event, severity: f.properties.severity, expires: f.properties.expires }));
      return JSON.stringify(alerts.length ? alerts : "No active alerts.");
    }
    if (name === "get_flights") {
      const url = `https://opensky-network.org/api/states/all?lamin=${BBOX.lamin}&lomin=${BBOX.lomin}&lamax=${BBOX.lamax}&lomax=${BBOX.lomax}`;
      const json = await safeFetch(url);
      const flights = (json.states || []).filter(s => s[5] != null && s[6] != null && !s[8]).slice(0, 10).map(s => ({ callsign: (s[1]||"").trim(), altitude_ft: s[7] ? Math.round(s[7]*3.28084) : null }));
      return JSON.stringify(flights.length ? flights : "No aircraft currently in range.");
    }
    if (name === "get_iss") {
      const json = await safeFetch("https://api.wheretheiss.at/v1/satellites/25544");
      return JSON.stringify({ lat: json.latitude, lon: json.longitude, altitude_km: json.altitude, velocity_kmh: json.velocity, visibility: json.visibility });
    }
    if (name === "get_longshot") {
      if (!creds.aioUsername || !creds.aioKey) return "Longshot credentials not configured in MIOS Settings.";
      const feeds = ["longshot-temp", "longshot-pressure", "longshot-lat", "longshot-lon", "longshot-rssi"];
      const results = await Promise.all(feeds.map(f => safeFetch(`https://io.adafruit.com/api/v2/${creds.aioUsername}/feeds/${f}/data/last?x-aio-key=${creds.aioKey}`)));
      return JSON.stringify({
        temp_c: parseFloat(results[0].value),
        pressure_hpa: parseFloat(results[1].value),
        lat: parseFloat(results[2].value),
        lon: parseFloat(results[3].value),
        rssi_dbm: parseFloat(results[4].value),
        last_updated: results[0].created_at,
      });
    }
    if (name === "control_lights") {
      if (!creds.aioUsername || !creds.aioKey) return "Light control credentials not configured in MIOS Settings.";
      let cmd;
      if (args.mode === "on") cmd = "on";
      else if (args.mode === "off") cmd = "off";
      else if (args.mode === "rainbow") cmd = "rainbow";
      else if (args.mode === "color") cmd = `color:${(args.color_hex || "ffffff").replace("#", "")}`;
      else if (args.mode === "flash") cmd = `flash:${(args.color_hex || "ffffff").replace("#", "")}:${args.flash_seconds || 3}`;
      else return "Unknown light mode.";
      const res = await fetch(`https://io.adafruit.com/api/v2/${creds.aioUsername}/feeds/mi-pulse-cmd/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO-Key": creds.aioKey },
        body: JSON.stringify({ value: cmd }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return `Command sent: ${cmd}`;
    }
    return "Unknown tool.";
  } catch (e) {
    return `Error running ${name}: ${e.message}`;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "GROQ_API_KEY isn't set on the server yet — add it in Netlify's environment variables." }) };
  }

  let body;
  try { body = JSON.parse(event.body); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Bad request body." }) };
  }
  const { messages, aioUsername, aioKey } = body;
  if (!messages || !Array.isArray(messages)) {
    return { statusCode: 400, body: JSON.stringify({ error: "messages array required." }) };
  }

  const systemPrompt = {
    role: "system",
    content:
      "You are CORE, the AI layer of Marcus Industries — Marcus's personal engineering command system based in Cedar City, Utah. You have real tools that read live hardware and sensor data, and can control physical LED hardware on his desk. Be direct, dry-witted, and genuinely useful — like a sharp lab assistant, not a customer service bot. Keep responses concise. When you take an action, briefly confirm what you did. If a tool errors, say plainly what went wrong instead of guessing.",
  };

  let convo = [systemPrompt, ...messages];
  const creds = { aioUsername, aioKey };

  try {
    for (let round = 0; round < 4; round++) {
      const res = await fetch(GROQ_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MODEL, messages: convo, tools: TOOLS, tool_choice: "auto" }),
      });
      if (!res.ok) {
        const errText = await res.text();
        return { statusCode: 502, body: JSON.stringify({ error: "Groq error: " + errText }) };
      }
      const data = await res.json();
      const msg = data.choices[0].message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        convo.push(msg);
        for (const tc of msg.tool_calls) {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          const result = await executeTool(tc.function.name, args, creds);
          convo.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
        continue;
      }

      return { statusCode: 200, body: JSON.stringify({ reply: msg.content }) };
    }
    return { statusCode: 200, body: JSON.stringify({ reply: "I made a few tool calls but didn't wrap up cleanly — try asking again." }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
