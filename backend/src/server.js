require('dotenv').config();
const app = require('./app');
const prisma = require('./config/database');

const port = Number(process.env.PORT) || 5000;
const server = app.listen(port, '0.0.0.0', () => console.log(`Job API listening on port ${port}`));

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
