// Pull the aa.com (American Airlines) login out of GCP Secret Manager using your
// Google Application Default Credentials (set up by scripts/gcloud/auth.sh).
//
// Mirrors get-delta-credentials.mjs — different secret names, same vault seam.
//
// As a module:
//     import { getAaCredentials } from './scripts/gcloud/get-aa-credentials.mjs';
//     const { username, password } = await getAaCredentials();
//
// As a CLI (does NOT print the password unless you pass --reveal):
//     node scripts/gcloud/get-aa-credentials.mjs
//     node scripts/gcloud/get-aa-credentials.mjs --reveal

import '../load-env.mjs';

const PROJECT = process.env.GCP_PROJECT || 'allocation-agent-service';
const USERNAME_SECRET = process.env.AA_USERNAME_SECRET || 'aa-com-username';
const PASSWORD_SECRET = process.env.AA_PASSWORD_SECRET || 'aa-com-password';

let _client; // lazy singleton

async function client() {
  if (_client) return _client;
  let SecretManagerServiceClient;
  try {
    ({ SecretManagerServiceClient } = await import('@google-cloud/secret-manager'));
  } catch {
    throw new Error(
      "Missing dependency '@google-cloud/secret-manager'. Install it with:\n" +
        '  npm install @google-cloud/secret-manager'
    );
  }
  _client = new SecretManagerServiceClient();
  return _client;
}

async function accessSecret(name) {
  const c = await client();
  const path = `projects/${PROJECT}/secrets/${name}/versions/latest`;
  try {
    const [version] = await c.accessSecretVersion({ name: path });
    return version.payload.data.toString('utf8');
  } catch (err) {
    if (err.code === 5 /* NOT_FOUND */) {
      throw new Error(
        `Secret '${name}' not found in project '${PROJECT}'. ` +
          'Seed it with: sh scripts/gcloud/put-aa-credentials.sh'
      );
    }
    if (
      err.code === 7 /* PERMISSION_DENIED */ ||
      err.code === 16 /* UNAUTHENTICATED */ ||
      /could not load the default credentials/i.test(err.message || '')
    ) {
      throw new Error(
        'Not authenticated to GCP (or missing Secret Manager access). ' +
          'Run: sh scripts/gcloud/auth.sh'
      );
    }
    throw err;
  }
}

/**
 * @returns {Promise<{username: string, password: string}>}
 */
export async function getAaCredentials() {
  // Local override: a gitignored .env wins over Secret Manager so the scripts
  // are runnable before gcloud/ADC is set up. Remove these to force the vault.
  if (process.env.AA_USERNAME && process.env.AA_PASSWORD) {
    console.log('🔑 Using aa.com credentials from environment (.env fallback).');
    return { username: process.env.AA_USERNAME.trim(), password: process.env.AA_PASSWORD };
  }
  const [username, password] = await Promise.all([
    accessSecret(USERNAME_SECRET),
    accessSecret(PASSWORD_SECRET),
  ]);
  return { username: username.trim(), password };
}

// --- CLI -------------------------------------------------------------------
const isCli = import.meta.url === `file://${process.argv[1]}`;
if (isCli) {
  const reveal = process.argv.includes('--reveal');
  try {
    const { username, password } = await getAaCredentials();
    console.log(`✅ Pulled aa.com credentials from Secret Manager (project: ${PROJECT})`);
    console.log(`   username: ${username}`);
    console.log(`   password: ${reveal ? password : '•'.repeat(Math.min(password.length, 12)) + ' (use --reveal to show)'}`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
