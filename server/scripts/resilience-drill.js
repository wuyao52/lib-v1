import { runResilienceDrill } from '../resilience-drill.js';

const result = await runResilienceDrill({ concurrency: Number(process.env.DRILL_CONCURRENCY || 50) });
console.log('Resilience drill completed:', JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
