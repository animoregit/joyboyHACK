require('dotenv').config();

const app = require('./server');

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`JoyBoy local server listening on port ${port}`);
});
