const mode = String(process.env.PROCESS_MODE || 'web').trim().toLowerCase();

if (mode === 'maintenance') {
  await import('./scripts/maintenance.js');
} else if (mode === 'mysql-restore-drill') {
  await import('./scripts/mysql-restore-drill.js');
} else if (mode === 'monitoring-audit-summary') {
  await import('./scripts/monitoring-audit-summary.js');
} else if (mode === 'web') {
  await import('./index.js');
} else {
  throw new Error(`Unsupported PROCESS_MODE: ${mode}`);
}
