const L = require("./_lib");

// GET: tells the page whether it's running on sample data and whether hosting needs the family passcode
module.exports = (req, res) => L.send(res, 200, { mock: L.MOCK, needsPasscode: !!L.APP_PASSCODE });
