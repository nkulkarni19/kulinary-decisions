// Shared helpers for Kulinary Decisions API routes.
// Files starting with "_" are not exposed as routes by Vercel.

const SESSION_TTL = 60 * 60 * 24; // sessions expire after 24h
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY || "";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
const APP_PASSCODE = process.env.APP_PASSCODE || "";
const MOCK = !GOOGLE_KEY;

// ---------- storage: Upstash Redis (prod) or in-memory (local dev) ----------
const mem = globalThis.__kvMem || (globalThis.__kvMem = new Map());

async function redis(cmd) {
  if (!REDIS_URL) return memCmd(cmd);
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error("Redis: " + j.error);
  return j.result;
}

function memCmd([op, key, ...args]) {
  op = op.toUpperCase();
  if (op === "GET") return mem.get(key) ?? null;
  if (op === "SET") { mem.set(key, args[0]); return "OK"; }
  if (op === "EXPIRE") return 1;
  if (op === "EXISTS") return mem.has(key) ? 1 : 0;
  if (op === "HSET") {
    const h = mem.get(key) || {};
    for (let i = 0; i < args.length; i += 2) h[args[i]] = String(args[i + 1]);
    mem.set(key, h);
    return 1;
  }
  if (op === "HGETALL") {
    const h = mem.get(key) || {};
    return Object.entries(h).flat();
  }
  throw new Error("mem op not supported: " + op);
}

const kv = {
  async getJSON(k) { const v = await redis(["GET", k]); return v ? JSON.parse(v) : null; },
  async setJSON(k, v, ttl = SESSION_TTL) { await redis(["SET", k, JSON.stringify(v), "EX", String(ttl)]); },
  async hset(k, obj, ttl = SESSION_TTL) {
    await redis(["HSET", k, ...Object.entries(obj).flat().map(String)]);
    await redis(["EXPIRE", k, String(ttl)]);
  },
  async hgetall(k) {
    const arr = (await redis(["HGETALL", k])) || [];
    const o = {};
    for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1];
    return o;
  },
};

// ---------- http helpers ----------
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}

function query(req) {
  return Object.fromEntries(new URL(req.url, "http://x").searchParams);
}

const clean = (s, n = 40) => String(s ?? "").replace(/[<>]/g, "").trim().slice(0, n);
const isId = (s) => /^[a-z0-9]{6,32}$/i.test(String(s || ""));
const isCode = (s) => /^[A-Z]{4}$/.test(String(s || ""));

function newCode() {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
  let c = "";
  for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
  return c;
}

// ---------- Google Places (New) ----------
const CUISINES = {
  anything: { label: "", type: "restaurant" },
  american: { label: "American", type: "american_restaurant" },
  mexican: { label: "Mexican", type: "mexican_restaurant" },
  italian: { label: "Italian", type: "italian_restaurant" },
  pizza: { label: "Pizza", type: "pizza_restaurant" },
  indian: { label: "Indian", type: "indian_restaurant" },
  chinese: { label: "Chinese", type: "chinese_restaurant" },
  japanese: { label: "Japanese", type: "japanese_restaurant" },
  sushi: { label: "Sushi", type: "sushi_restaurant" },
  thai: { label: "Thai", type: "thai_restaurant" },
  vietnamese: { label: "Vietnamese", type: "vietnamese_restaurant" },
  korean: { label: "Korean", type: "korean_restaurant" },
  mediterranean: { label: "Mediterranean", type: "mediterranean_restaurant" },
  burgers: { label: "Burger", type: "hamburger_restaurant" },
  bbq: { label: "BBQ", type: "barbecue_restaurant" },
  seafood: { label: "Seafood", type: "seafood_restaurant" },
  steak: { label: "Steakhouse", type: "steak_house" },
  vegetarian: { label: "Vegetarian", type: "vegetarian_restaurant" },
};

const FIELD_MASK = [
  "places.id", "places.displayName", "places.primaryTypeDisplayName", "places.rating",
  "places.userRatingCount", "places.priceLevel", "places.formattedAddress", "places.location",
  "places.photos", "places.googleMapsUri", "places.currentOpeningHours.openNow",
].join(",");

const PRICE = {
  PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4,
};
const PRICE_ENUM = ["", "PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"];

function miles(a, b) {
  if (!a || !b) return null;
  const R = 3958.8, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b.latitude - a.latitude), dLng = toR(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.latitude)) * Math.cos(toR(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

// opts: {lat,lng,place,cuisine,radiusMi,maxPrice,openNow,mode}
async function searchPlaces(opts) {
  const c = CUISINES[opts.cuisine] || CUISINES.anything;
  if (MOCK) return mockPlaces(opts, c);

  const prefix = opts.mode === "new" ? "new " : "";
  const what = `${prefix}${c.label ? c.label + " " : ""}restaurants`.trim();
  const body = { pageSize: 20, includedType: c.type, strictTypeFiltering: c.type !== "restaurant" };
  const radius = Math.min(Math.max(Number(opts.radiusMi) || 5, 1), 25) * 1609;
  let center = null;
  if (opts.lat != null && opts.lng != null) {
    center = { latitude: Number(opts.lat), longitude: Number(opts.lng) };
    body.textQuery = what;
    body.locationBias = { circle: { center, radius } };
  } else {
    body.textQuery = `${what} near ${clean(opts.place, 80)}`;
  }
  if (opts.openNow) body.openNow = true;
  const mp = Number(opts.maxPrice) || 4;
  if (mp < 4) body.priceLevels = PRICE_ENUM.slice(1, mp + 1);
  if (opts.mode === "top") body.minRating = 4.3;

  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": FIELD_MASK },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || "Google Places error");

  let places = (j.places || []).map((p) => ({
    id: p.id,
    name: p.displayName?.text || "Unknown",
    type: p.primaryTypeDisplayName?.text || "Restaurant",
    rating: p.rating ?? null,
    reviews: p.userRatingCount ?? 0,
    price: PRICE[p.priceLevel] || null,
    address: p.formattedAddress || "",
    openNow: p.currentOpeningHours?.openNow ?? null,
    mapsUrl: p.googleMapsUri || "",
    photo: p.photos?.[0]?.name || null,
    distance: miles(center, p.location),
  }));

  // drop places clearly outside the radius when we know the center
  if (center) places = places.filter((p) => p.distance == null || p.distance <= radius / 1609 + 0.5);
  return rank(places, opts.mode);
}

function rank(places, mode) {
  const score = (p) => (p.rating || 3.5) * Math.log10((p.reviews || 1) + 10);
  if (mode === "new") {
    // Google has no "opened on" date. Proxy for new + buzzy: strong rating, few reviews so far.
    const gem = (p) => (p.rating || 0) >= 4.3 && p.reviews < 400;
    return places.sort((a, b) => gem(b) - gem(a) || (b.rating || 0) - (a.rating || 0));
  }
  return places.sort((a, b) => score(b) - score(a));
}

async function photoUrl(name) {
  if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name || "")) return null;
  if (MOCK) return null;
  const cacheKey = "ph:" + name;
  const cached = await redis(["GET", cacheKey]);
  if (cached) return cached;
  const r = await fetch(
    `https://places.googleapis.com/v1/${name}/media?maxWidthPx=800&skipHttpRedirect=true&key=${GOOGLE_KEY}`
  );
  const j = await r.json();
  if (!j.photoUri) return null;
  await redis(["SET", cacheKey, j.photoUri, "EX", String(60 * 60 * 6)]);
  return j.photoUri;
}

function mockPlaces(opts, c) {
  const names = [
    ["Smoke & Salt BBQ", "Barbecue restaurant"], ["Pho Saigon Noodle House", "Vietnamese restaurant"],
    ["Tandoori Oven", "Indian restaurant"], ["La Victoria Taqueria", "Mexican restaurant"],
    ["Pizza My Heart", "Pizza restaurant"], ["Sushi Kaz", "Sushi restaurant"],
    ["Bun Bo Hue An Nam", "Vietnamese restaurant"], ["The Habit Burger", "Hamburger restaurant"],
    ["Thai Basil Kitchen", "Thai restaurant"], ["Pasta Pomodoro", "Italian restaurant"],
    ["Seoul Garden BBQ", "Korean restaurant"], ["Oren's Hummus", "Mediterranean restaurant"],
  ];
  return rank(names.map(([name, type], i) => ({
    id: "mock" + i, name, type,
    rating: Math.round((3.8 + ((i * 7) % 12) / 10) * 10) / 10,
    reviews: [42, 1250, 380, 2100, 870, 95, 160, 3400, 510, 640, 230, 1800][i],
    price: (i % 3) + 1, address: `${100 + i * 37} Santa Teresa Blvd, San Jose, CA`,
    openNow: i % 5 !== 0, mapsUrl: "https://maps.google.com/?q=" + encodeURIComponent(name),
    photo: null, distance: Math.round((0.4 + i * 0.6) * 10) / 10,
  })), opts.mode);
}

// ---------- session state ----------
async function loadState(code) {
  const s = await kv.getJSON("s:" + code);
  if (!s) return null;
  const members = await kv.hgetall(`s:${code}:m`); // id -> JSON {name}
  const swipes = {};
  for (const id of Object.keys(members)) swipes[id] = await kv.hgetall(`s:${code}:w:${id}`);
  return { s, members, swipes };
}

function summarize({ s, members, swipes }, me) {
  const ids = Object.keys(members);
  const people = ids.map((id) => {
    const m = JSON.parse(members[id]);
    return { id, name: m.name, done: Object.keys(swipes[id] || {}).length >= s.places.length, swiped: Object.keys(swipes[id] || {}).length };
  });
  const tally = s.places.map((p) => {
    const likes = ids.filter((id) => swipes[id]?.[p.id] === "1").length;
    return { id: p.id, likes };
  });
  const matches = ids.length >= 2
    ? s.places.filter((p) => ids.every((id) => swipes[id]?.[p.id] === "1")).map((p) => p.id)
    : [];
  return {
    code: s.code, host: s.host, filters: s.filters, places: s.places, mock: !!s.mock,
    people, matches, tally, mySwipes: swipes[me] || {}, total: s.places.length,
  };
}

module.exports = {
  kv, send, readBody, query, clean, isId, isCode, newCode, searchPlaces, photoUrl,
  loadState, summarize, APP_PASSCODE, MOCK, CUISINES,
};
