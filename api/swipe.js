const L = require("./_lib");

// POST {code, member, placeId, like}: record one swipe, return fresh state (so a match shows instantly)
module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") return L.send(res, 405, { error: "Method not allowed" });
    const b = await L.readBody(req);
    if (!L.isCode(b.code) || !L.isId(b.member)) return L.send(res, 400, { error: "Bad request" });
    const st0 = await L.loadState(b.code);
    if (!st0) return L.send(res, 404, { error: "Session expired" });
    if (!st0.members[b.member]) return L.send(res, 403, { error: "Join the session first" });
    if (!st0.s.places.some((p) => p.id === b.placeId)) return L.send(res, 400, { error: "Unknown restaurant" });
    await L.kv.hset(`s:${b.code}:w:${b.member}`, { [b.placeId]: b.like ? "1" : "0" });
    const st = await L.loadState(b.code);
    L.send(res, 200, L.summarize(st, b.member));
  } catch (e) {
    console.error(e);
    L.send(res, 500, { error: e.message || "Server error" });
  }
};
