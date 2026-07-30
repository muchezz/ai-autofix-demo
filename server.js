const express = require('express');

function add(a, b) {
  // Bug: no numeric coercion, so add(2, '3') returns '23' instead of 5.
  return a + b;
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
