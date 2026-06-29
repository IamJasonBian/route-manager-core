// Pull the delta.com login out of GCP Secret Manager using your Google
// Application Default Credentials (set up by scripts/gcloud/auth.sh).
//
// As a module:
//     import { getDeltaCredentials } from './scripts/gcloud/get-delta-credentials.mjs';
//     const { username, password } = await getDeltaCredentials();
//
// As a CLI (does NOT print the password unless you pass --reveal):
//     node scripts/gcloud/get-delta-credentials.mjs
//     node scripts/gcloud/get-delta-credentials.mjs --reveal

import '../load-env.mjs';

const PROJECT = process.env.GCP_PROJECT || 'allocation-agent-service';
const USERNAME_SECRET = process.env.DELTA_USERNAME_SECRET || 'delta-com-username';
const PASSWORD_SECRET = process.env.DELTA_PASSWORD_SECRET || 'delta-com-password';

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
          'Seed it with: sh scripts/gcloud/put-delta-credentials.sh'
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
export async function getDeltaCredentials() {
  // Local override: a gitignored .env wins over Secret Manager so the scripts
  // are runnable before gcloud/ADC is set up. Remove these to force the vault.
  if (process.env.DELTA_USERNAME && process.env.DELTA_PASSWORD) {
    console.log('🔑 Using delta.com credentials from environment (.env fallback).');
    return { username: process.env.DELTA_USERNAME.trim(), password: process.env.DELTA_PASSWORD };
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
    const { username, password } = await getDeltaCredentials();
    console.log(`✅ Pulled delta.com credentials from Secret Manager (project: ${PROJECT})`);
    console.log(`   username: ${username}`);
    console.log(`   password: ${reveal ? password : '•'.repeat(Math.min(password.length, 12)) + ' (use --reveal to show)'}`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}
