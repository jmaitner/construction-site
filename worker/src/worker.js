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
      max_tokens: 4000,
      system: `You are a quoting assistant for Grandson's Construction, a premium deck, fence, and outdoor living contractor in West Michigan (Grand Rapids + ~80 mi). Analyze project intake forms and produce structured preliminary estimates.

These figures are Grandson's calibrated pricing — already include standard pressure-treated substructure, hidden fasteners, and install labor for a simple ground-level rectangle. They are RANGES on purpose: a preliminary quote is a starting range, not a firm bid. The firm number always happens at the in-person site visit, so lean toward the wider/safer end when inputs are vague.

DECK pricing (installed $/sq ft):
- Pressure-treated wood deck: $18–30/sq ft
- Cedar deck: $26–42/sq ft
- Composite — good/better (TimberTech EDGE/PRO, Trex Enhance/Select, Deckorators Vista/Trailhead): $48–90/sq ft
- PVC / premium composite — best (AZEK Vintage/Landmark, Trex Transcend/Signature, Deckorators Voyage): $90–132/sq ft
- If material is "not sure," assume good/better composite and say so in assumptions.

FENCE pricing (installed $/linear ft):
- Wood privacy, 6 ft (cedar/PT): $42–72/LF
- Wood, 4 ft / picket: $30–54/LF
- Vinyl privacy, 6 ft: $48–84/LF
- Aluminum / ornamental: $48–96/LF
- Single walk gate: $300–720 each. Double/drive gate: $720–1,800 each.
(Fences are priced by linear foot + height, NOT square foot. If they only gave sq ft for a fence, ask for linear footage in missingInformation and widen the range.)

MODIFIERS (apply on top of the base):
- Height surcharge: 1–3 ft +15%, 3–6 ft +25%, 6+ ft / second-story +40–60%
- Railing: wood $48–72/LF, composite $36–84/LF, aluminum $48–96/LF, cable $96–276/LF
- Stairs: $240–480 per step (a typical set runs $800–2,500)
- Demo / removal of old deck: $6–18/sq ft (≈$600–2,400 total)
- Permit: $270–600. Frost footings (W. MI ~42" depth): $600–2,400.
- Multi-level: +$1,800–3,600 per level. Curves / heavy angles: +15–40%.
- Sloped yard or limited access: +10–20%
- Lighting package: $600–2,400. Under-deck drainage: $2,400–6,000.

FINISH LEVEL (craftsmanship — this rides on LABOR, same materials):
- Standard finish = boards flat, fascia run to the edge, butted corners, straight stair treads. Use the base pricing above.
- Premium finish = wrapped/vertical fascia that hides exposed board edges, picture-frame borders, mitered corners, mitered stair-tread detailing. This is significant extra labor on identical materials. Add +15% to the total. Treat it as Premium finish if the "Picture-frame border detail" add-on is selected, OR the customer's notes describe wrapped edges, mitered details, "no exposed edges," or an especially high-end/finished look.
- Fully custom = the customer wants intricate, "make-it-perfect" detailing beyond the above (or signals cost is no object for the look). When you detect this: set manualReviewRequired=true, WIDEN the estimate range, lower quoteConfidence, and in customerFriendlySummary emphasize that custom detail work like this is priced precisely at the in-person visit. Do NOT try to pin a tight number on custom work.

Always anchor the customer toward booking the free on-site visit for an exact quote. Return ONLY valid JSON, no markdown fences.`,
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
  if (data.stop_reason === 'max_tokens') {
    console.error('Claude hit max_tokens — response truncated. Consider raising the limit.');
  }
  return parseQuoteJson(data.content[0].text);
}

// Robustly parse Claude's JSON: strips markdown fences and any prose before/after
// the JSON object, so a stray sentence or code fence doesn't sink the whole quote.
function parseQuoteJson(raw) {
  let text = (raw || '').trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Otherwise slice from first { to last } to drop any surrounding prose
  if (text[0] !== '{') {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }
  return JSON.parse(text);
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
