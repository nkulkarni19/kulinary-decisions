const L = require("./_lib");

// POST: create a session and fetch the restaurant deck (the only Google search call per session)
// GET ?code=ABCD&member=xyz: current state (polled by every phone in the session)
module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const { code, member } = L.query(req);
      if (!L.isCode(code)) return L.send(res, 400, { error: "Bad code" });
      const st = await L.loadState(code);
      if (!st) return L.send(res, 404, { error: "Session not found or expired" });
      return L.send(res, 200, L.summarize(st, member));
    }

    if (req.method === "POST") {
      const b = await L.readBody(req);
      if (L.APP_PASSCODE && b.passcode !== L.APP_PASSCODE)
        return L.send(res, 401, { error: "Wrong family passcode" });
      if (!L.isId(b.member)) return L.send(res, 400, { error: "Bad member id" });
      const name = L.clean(b.name, 24) || "Someone";
      const f = b.filters || {};
      const filters = {
        cuisine: L.CUISINES[f.cuisine] ? f.cuisine : "anything",
        radiusMi: Math.min(Math.max(Number(f.radiusMi) || 5, 1), 25),
        maxPrice: Math.min(Math.max(Number(f.maxPrice) || 4, 1), 4),
        openNow: !!f.openNow,
        mode: ["popular", "top", "new"].includes(f.mode) ? f.mode : "popular",
        lat: f.lat != null ? Number(f.lat) : null,
        lng: f.lng != null ? Number(f.lng) : null,
        place: L.clean(f.place, 80),
      };
      if (filters.lat == null && !filters.place)
        return L.send(res, 400, { error: "Need your location or a city / ZIP" });

      const places = await L.searchPlaces(filters);
      if (!places.length) return L.send(res, 404, { error: "No restaurants matched. Try a wider radius or fewer filters." });

      let code;
      for (let i = 0; i < 10; i++) {
        code = L.newCode();
        if (!(await L.kv.getJSON("s:" + code))) break;
      }
      const { lat, lng, ...publicFilters } = filters; // don't hand out exact coordinates
      await L.kv.setJSON("s:" + code, { code, host: b.member, filters: publicFilters, places, mock: L.MOCK, createdAt: Date.now() });
      await L.kv.hset(`s:${code}:m`, { [b.member]: JSON.stringify({ name }) });
      const st = await L.loadState(code);
      return L.send(res, 200, L.summarize(st, b.member));
    }

    L.send(res, 405, { error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    L.send(res, 500, { error: e.message || "Server error" });
  }
};
