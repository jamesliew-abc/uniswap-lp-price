#!/usr/bin/env node
// Creates a personal access link for the shared dashboard.
//
// Usage:  node scripts/new-link.mjs "Somchai (Treasury)" https://uniswap-lp-price.<you>.workers.dev
//
// Prints the line to add to the VIEWER_LINKS secret and the link to send to that person.
// The token is 32 random characters (192 bits), so links can't be guessed.

import { randomBytes } from 'node:crypto';

const [name, baseUrl] = process.argv.slice(2);
if (!name) {
  console.error('Usage: node scripts/new-link.mjs "<person or team name>" [dashboard URL]');
  process.exit(1);
}
if (/[:,\n]/.test(name)) {
  console.error('The name can\'t contain ":", "," or line breaks.');
  process.exit(1);
}

const token = randomBytes(24).toString('base64url');
const url = `${(baseUrl || 'https://<your-dashboard-url>').replace(/\/+$/, '')}/?k=${token}`;

console.log('\nAdd this line to the VIEWER_LINKS secret:\n');
console.log(`  ${name}:${token}`);
console.log('\nThen send this link to that person (privately):\n');
console.log(`  ${url}\n`);
