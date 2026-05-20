// SpaFix — Supabase Backup Script
// Dumps spa_models to timestamped JSON files
// Add to Railway as a scheduled job or run manually with: node spafix-backup.js

const https = require('https');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://oioygqqbtdlzofszanag.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_nHCWXx8a79M8AtZ3x-bwlQ_wvKv6lNg';
const BACKUP_DIR = process.env.BACKUP_DIR || './backups';

function fetchAllRows() {
  return new Promise((resolve, reject) => {
    const url = new URL('/rest/v1/spa_models?select=*&order=brand.asc,model_name.asc,year_start.asc', SUPABASE_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Accept': 'application/json',
        'Prefer': 'count=exact'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Supabase returned ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const rows = JSON.parse(data);
          const count = res.headers['content-range']
            ? res.headers['content-range'].split('/')[1]
            : rows.length;
          resolve({ rows, count });
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function runBackup() {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log(`[${new Date().toISOString()}] SpaFix backup starting...`);

  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`Created backup directory: ${BACKUP_DIR}`);
  }

  try {
    const { rows, count } = await fetchAllRows();

    // Build backup payload
    const backup = {
      meta: {
        timestamp: new Date().toISOString(),
        row_count: rows.length,
        supabase_count: count,
        brands: [...new Set(rows.map(r => r.brand))].sort()
      },
      data: rows
    };

    // Write timestamped backup
    const filename = `spa_models_${timestamp}.json`;
    const filepath = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(backup, null, 2));

    // Also overwrite latest.json for easy access
    const latestPath = path.join(BACKUP_DIR, 'spa_models_latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(backup, null, 2));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] ✅ Backup complete`);
    console.log(`   Rows: ${rows.length} | Brands: ${backup.meta.brands.length} | File: ${filename} | ${elapsed}s`);

    // Prune old backups — keep last 30
    pruneOldBackups(BACKUP_DIR, 30);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Backup failed: ${err.message}`);
    process.exit(1);
  }
}

function pruneOldBackups(dir, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('spa_models_') && f.endsWith('.json') && f !== 'spa_models_latest.json')
      .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    const toDelete = files.slice(keep);
    toDelete.forEach(f => {
      fs.unlinkSync(path.join(dir, f.name));
      console.log(`   Pruned old backup: ${f.name}`);
    });
  } catch (err) {
    console.warn(`   Warning: pruning failed — ${err.message}`);
  }
}

runBackup();
