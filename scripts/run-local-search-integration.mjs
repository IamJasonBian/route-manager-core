#!/usr/bin/env node
/**
 * 1) If .env already has AMADEUS_API_KEY + AMADEUS_API_SECRET → skip pull.
 * 2) Else if NETLIFY_AUTH_TOKEN is set → pull from Netlify into .env.
 * 3) Invoke search-flights locally (JFK → LAX).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');

function hasAmadeusInDotenv() {
  if (!fs.existsSync(envPath)) return false;
  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  return !!(parsed.AMADEUS_API_KEY?.trim() && parsed.AMADEUS_API_SECRET?.trim());
}

function main() {
  if (!hasAmadeusInDotenv()) {
    const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
    if (!token) {
      console.error('No Amadeus keys in .env and NETLIFY_AUTH_TOKEN is not set.\n');
      console.error('Do one of the following:');
      console.error('  • Copy .env.example to .env and add AMADEUS_API_KEY / AMADEUS_API_SECRET, or');
      console.error('  • export NETLIFY_AUTH_TOKEN=... then run this again to pull from Netlify.\n');
      process.exit(1);
    }
    console.log('Pulling environment from Netlify…');
    const pull = spawnSync('node', [path.join(__dirname, 'pull-amadeus-from-netlify.mjs')], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    if (pull.status !== 0) process.exit(pull.status ?? 1);
  } else {
    console.log('Using AMADEUS_* from existing .env');
  }

  const r = spawnSync('node', [path.join(__dirname, 'invoke-search-flights-local.mjs')], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(r.status ?? 1);
}

main();
