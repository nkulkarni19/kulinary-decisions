const L = require("./_lib");

// GET ?name=places/.../photos/...: redirects to the Google photo, so the API key never reaches the browser
module.exports = async (req, res) => {
  try {
    const url = await L.photoUrl(L.query(req).name);
    if (!url) { res.statusCode = 404; return res.end(); }
    res.statusCode = 302;
    res.setHeader("Location", url);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end();
  } catch (e) {
    console.error(e);
    res.statusCode = 404;
    res.end();
  }
};
