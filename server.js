const express = require('express');

function add(a, b) {
  return Number(a) + Number(b);
}

function createApp() {
  const app = express();
  app.get('/add/:a/:b', (req, res) => {
    res.json({ result: add(Number(req.params.a), Number(req.params.b)) });
  });
  return app;
}

module.exports = { add, createApp };

if (require.main === module) {
  createApp().listen(3000, () => console.log('listening on :3000'));
}
