import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 8787);
const allowedOrigins = String(process.env.APP_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const { app } = await createApp({ allowedOrigins, serveFrontend: true });
app.listen(port, '0.0.0.0', () => {
  console.log(`AI Drama Studio server listening on http://127.0.0.1:${port}`);
});
