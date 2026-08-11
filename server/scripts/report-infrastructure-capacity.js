import { statfs } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signCapacityReport } from '../infrastructure-capacity.js';

const endpoint = String(process.env.CAPACITY_REPORT_URL || '').trim();
const secret = String(process.env.INFRA_CAPACITY_REPORT_SECRET || '');
const source = String(process.env.CAPACITY_REPORT_SOURCE || 'railway-volume').trim();
let usedBytes = Number(process.env.CAPACITY_USED_BYTES);
let totalBytes = Number(process.env.CAPACITY_TOTAL_BYTES);
if (process.env.CAPACITY_VOLUME_PATH) {
  const stats = await statfs(resolve(process.env.CAPACITY_VOLUME_PATH));
  totalBytes = Number(stats.blocks) * Number(stats.bsize);
  usedBytes = totalBytes - Number(stats.bfree) * Number(stats.bsize);
}
if (!/^https:\/\//.test(endpoint) && !/^http:\/\/127\.0\.0\.1(?::\d+)?/.test(endpoint)) throw new Error('CAPACITY_REPORT_URL must use HTTPS or local loopback');
if (secret.length < 24) throw new Error('INFRA_CAPACITY_REPORT_SECRET must contain at least 24 characters');
if (!Number.isSafeInteger(usedBytes) || !Number.isSafeInteger(totalBytes) || usedBytes < 0 || totalBytes <= 0 || usedBytes > totalBytes) throw new Error('Capacity bytes are invalid');
const timestamp = Date.now();
const body = Buffer.from(JSON.stringify({ source, usedBytes, totalBytes }));
const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-capacity-timestamp': String(timestamp), 'x-capacity-signature': signCapacityReport(secret, timestamp, body) }, body });
if (!response.ok) throw new Error(`Capacity report failed with HTTP ${response.status}`);
console.log('Infrastructure capacity reported:', JSON.stringify({ source, usedBytes, totalBytes, status: response.status }));
