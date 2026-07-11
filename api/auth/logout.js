const { clearSessionCookie } = require('../_lib/session');

module.exports = async (req, res) => {
  clearSessionCookie(res);
  res.writeHead(302, { Location: '/' });
  res.end();
};
