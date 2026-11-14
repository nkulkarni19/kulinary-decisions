const L = require("./_lib");

// POST {code, member, name}: join an existing session (no passcode needed, the code is the invite)
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return L.send(res, 405, { error: "Method not allowed" });
    const b = await L.readBody(req);
    const code = String(b.code || "").toUpperCase();
    if (!L.isCode(code)) return L.send(res, 400, { error: "Codes are 4 letters" });
    if (!L.isId(b.member)) return L.send(res, 400, { error: "Bad member id" });
    const st0 = await L.loadState(code);
    if (!st0) return L.send(res, 404, { error: "No session with that code (they expire after 24 hours)" });
    if (!st0.members[b.member] && Object.keys(st0.members).length >= 8)
      return L.send(res, 403, { error: "Session is full (8 people max)" });
    await L.kv.hset(`s:${code}:m`, { [b.member]: JSON.stringify({ name: L.clean(b.name, 24) || "Someone" }) });
    const st = await L.loadState(code);
    L.send(res, 200, L.summarize(st, b.member));
  } catch (e) {
    console.error(e);
    L.send(res, 500, { error: e.message || "Server error" });
  }
};
