'use strict';

const fs = require('node:fs');
const path = require('node:path');

const lockPath = path.join(__dirname, '..', 'package-lock.json');
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
let changed = 0;

function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.resolved === 'string' && value.resolved.startsWith('file:vendor/kernel/')) {
    if (Object.prototype.hasOwnProperty.call(value, 'integrity')) {
      delete value.integrity;
      changed += 1;
    }
  }
  for (const child of Object.values(value)) visit(child);
}

visit(lock);
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
console.log(`[refresh-kernel-lock] removed ${changed} generated kernel integrity entries`);
