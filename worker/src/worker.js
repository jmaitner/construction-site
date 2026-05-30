export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/submit-lead') {
      return cors(await handleSubmit(request, env), env);
    }
    return cors(new Response('Not found', { status: 404 }), env);
  }
};

function cors(response, env) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', env.ALLOWED_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers });
}

async function handleSubmit(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  if (body.website_url) return json({ ok: true }); // honeypot

  const { contact, consentToContact } = body;
  if (!contact?.name || !contact?.email || !contact?.phone) return json({ error: 'Missing contact fields' }, 422);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) return json({ error: 'Invalid email' }, 422);
  if (!consentToContact) return json({ error: 'Consent required' }, 422);

  let quote;
  try { quote = await generateQuote(buildContext(body), env); }
  catch (err) { console.error('Claude error:', err); quote = fallbackQuote(body); }

  let saved = true;
  try { await appendToSheets(body, quote, env); }
  catch (err) { saved = false; console.error('Sheets error:', err); }

  // Always return the quote to the customer — we never want to lose the moment,
  // even if the back-office save hiccups. `saved` flags capture status for monitoring.
  return json({
    ok: true,
    saved,
    quote: {
      estimatedLow: quote.estimatedLow,
      estimatedHigh: quote.estimatedHigh,
      quoteConfidence: quote.quoteConfidence,
      projectSummary: quote.projectSummary,
      customerFriendlySummary: quote.customerFriendlySummary,
      assumptions: Array.isArray(quote.assumptions) ? quote.assumptions.slice(0, 5) : [],
    },
  });
}

async function generateQuote(context, env) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 1500,
      system: `You are a quoting assistant for Grandson's Construction, a premium deck and outdoor living contractor in West Michigan. Analyze project intake forms and produce structured preliminary estimates.

Pricing guidelines:
- Pressure-treated deck: $15–25/sq ft installed
- Cedar deck: $22–35/sq ft
- Composite (Trex etc): $30–50/sq ft
- PVC/premium composite: $45–70/sq ft
- Height surcharges: 1-3 ft +10%, 3-6 ft +25%, 6+ ft/second-story +40-60%
- Wood railing: $40-60/linear ft. Aluminum: $60-90. Cable: $90-130
- Stairs per set: $800–2,500 depending on height and material
- Pergola: $5,000–20,000 depending on size
- Demo/removal of old deck: $500–2,000
- Sloped yard or limited access: +10-20%
- Lighting package: $500–2,000
- Under-deck drainage: $2,000–5,000

Return ONLY valid JSON, no markdown fences.`,
      messages: [{
        role: 'user',
        content: `Generate a preliminary quote for this project:\n\n${context}\n\nReturn this exact JSON schema:
{
  "leadScore": <0-100>,
  "quoteConfidence": "<low|medium|high>",
  "estimatedLow": <integer dollars>,
  "estimatedHigh": <integer dollars>,
  "projectSummary": "<1-2 sentence project summary>",
  "customerFriendlySummary": "<2-3 sentences to the homeowner explaining the range and key factors>",
  "assumptions": ["<assumption>"],
  "priceDrivers": ["<factor driving cost>"],
  "missingInformation": ["<info that would help accuracy>"],
  "manualReviewRequired": <true|false>,
  "manualReviewReasons": ["<reason>"],
  "customerEmailBody": "<full warm professional email to homeowner, 150-250 words, includes estimate range, signed from Richard>",
  "contractorInternalSummary": "<2-3 honest sentences for Richard, internal only>",
  "contractorFollowUpScript": "<suggested opening line for Richard's follow-up call>"
}`
      }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return JSON.parse(data.content[0].text.trim());
}

async function appendToSheets(body, quote, env) {
  const serviceKey = JSON.parse(env.GOOGLE_SERVICE_KEY_JSON);
  const token = await getGoogleToken(serviceKey);

  const { contact, projectType, projectSize, deckHeight, materialPreference,
          railing, stairs, siteCondition, addOns, timeline, budget,
          location, projectNotes, submittedAt } = body;

  const row = [
    submittedAt,
    contact.name,
    contact.email,
    contact.phone,
    [location?.address, location?.city, location?.state, location?.zip].filter(Boolean).join(', '),
    list(projectType),
    projectSize?.sizeRange || '',
    projectSize?.length ? `${projectSize.length} × ${projectSize.width || '?'} ft` : '',
    deckHeight || '',
    materialPreference || '',
    railing || '',
    stairs || '',
    list(siteCondition),
    list(addOns),
    timeline || '',
    budget || '',
    projectNotes || '',
    quote.leadScore,
    quote.quoteConfidence,
    quote.estimatedLow,
    quote.estimatedHigh,
    quote.projectSummary || '',
    list(quote.assumptions),
    list(quote.missingInformation),
    quote.manualReviewRequired ? 'Yes' : 'No',
    list(quote.manualReviewReasons),
    quote.customerFriendlySummary || '',
    quote.customerEmailBody || '',
    quote.contractorInternalSummary || '',
    quote.contractorFollowUpScript || '',
    'New',
  ];

  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.GOOGLE_SHEETS_ID}/values/Leads!A:A:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    }
  );
  if (!resp.ok) throw new Error(`Sheets ${resp.status}: ${await resp.text()}`);
}

async function getGoogleToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sigInput = `${header}.${payload}`;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pemToBin(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput));
  const jwt = `${sigInput}.${arrayBufToB64url(sig)}`;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  return (await tokenResp.json()).access_token;
}

function buildContext(body) {
  const { projectType, projectSize, deckHeight, materialPreference, railing,
          stairs, siteCondition, addOns, timeline, budget, location, projectNotes } = body;
  return [
    `Project type: ${list(projectType)}`,
    `Size: ${projectSize?.sizeRange || 'not specified'}${projectSize?.length ? ` (${projectSize.length}×${projectSize.width || '?'} ft)` : ''}`,
    `Deck height: ${deckHeight || 'not specified'}`,
    `Material: ${materialPreference || 'not specified'}`,
    `Railing: ${railing || 'not specified'}`,
    `Stairs: ${stairs || 'not specified'}`,
    `Site conditions: ${list(siteCondition)}`,
    `Add-ons: ${list(addOns)}`,
    `Timeline: ${timeline || 'not specified'}`,
    `Budget: ${budget || 'not specified'}`,
    `Location: ${[location?.city, location?.state].filter(Boolean).join(', ') || 'not provided'}`,
    projectNotes ? `Customer notes: "${projectNotes}"` : null,
  ].filter(Boolean).join('\n');
}

function fallbackQuote(body) {
  return {
    leadScore: 50, quoteConfidence: 'low',
    estimatedLow: 15000, estimatedHigh: 40000,
    projectSummary: 'Details received — manual review required.',
    customerFriendlySummary: 'We received your project details and will prepare a personalized estimate.',
    assumptions: ['Site visit required to confirm scope'],
    missingInformation: ['AI quote unavailable — manual review needed'],
    manualReviewRequired: true, manualReviewReasons: ['AI quote generation failed'],
    customerEmailBody: `Hi ${body.contact?.name?.split(' ')[0]},\n\nThank you for reaching out to Grandson's Construction. We received your project details and Richard will follow up within 24 hours to discuss your project and prepare your estimate.\n\nLooking forward to connecting.\n\n— Richard\nGrandson's Construction`,
    contractorInternalSummary: 'AI quote failed. Review lead manually.',
    contractorFollowUpScript: `Hi, this is Richard from Grandson's Construction — calling about the project estimate you requested. Do you have a few minutes?`,
  };
}

function list(arr) { return Array.isArray(arr) && arr.length ? arr.join(', ') : '—'; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function b64url(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
function arrayBufToB64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
function pemToBin(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
