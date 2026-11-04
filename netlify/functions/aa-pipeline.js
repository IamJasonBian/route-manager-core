// American Airlines data pipeline control plane.
//
// Proxies the deployed `american-data-pipeline` Cloud Run Job
// (IamJasonBian/american_data_pipeline) so the app can trigger an execution
// and tail its logs:
//
//   GET  ?op=status                         job + recent executions
//   GET  ?op=logs&execution=<name>[&after=<iso>]  Cloud Logging entries for one execution
//   POST { op: 'run', brand, dryRun }       start an execution (needs x-pipeline-token)
//
// Brand → portal login mapping is server-side only (AA_BRANDS), mirroring the
// dispatcher's confused-deputy rule: the client picks a brand key, never a login.
//
// Env:
//   GCP_SERVICE_ACCOUNT_JSON  SA key JSON (raw or base64). Falls back to ADC locally.
//   GCP_ACCESS_TOKEN  local dev only: `export GCP_ACCESS_TOKEN=$(gcloud auth print-access-token)`
//   AA_JOB_PROJECT / AA_JOB_REGION / AA_JOB_NAME
//   AA_BRANDS   JSON: { "<brand>": { "portalUsername", "portalAccountId"?, "bucket"?, "mfaMailbox"? } }
//   PIPELINE_TRIGGER_TOKEN  shared secret required for op=run

import { GoogleAuth } from 'google-auth-library';

const PROJECT = process.env.AA_JOB_PROJECT || 'user-integration-504203';
const REGION = process.env.AA_JOB_REGION || 'us-central1';
const JOB = process.env.AA_JOB_NAME || 'american-data-pipeline';
const JOB_PATH = `projects/${PROJECT}/locations/${REGION}/jobs/${JOB}`;
const RUN_API = `https://run.googleapis.com/v2/${JOB_PATH}`;
const LOGGING_API = 'https://logging.googleapis.com/v2/entries:list';

const headers = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-pipeline-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

let auth;
function getAuth() {
  if (auth) return auth;
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON;
  let credentials;
  if (raw) {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    credentials = JSON.parse(text);
  }
  auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return auth;
}

/** Authenticated Google API call; throws with the API's error message. */
async function gcp(url, { method = 'GET', body } = {}) {
  try {
    if (process.env.GCP_ACCESS_TOKEN) {
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${process.env.GCP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(), { response: { status: res.status, data } });
      return data;
    }
    const client = await getAuth().getClient();
    const res = await client.request({ url, method, data: body });
    return res.data;
  } catch (err) {
    const apiError = err.response?.data?.error;
    const e = new Error(apiError?.message || err.message);
    e.status = err.response?.status || 502;
    throw e;
  }
}

function brands() {
  try {
    return JSON.parse(process.env.AA_BRANDS || '{}');
  } catch {
    return {};
  }
}

/** Collapse a Run v2 Execution into what the UI needs. */
function summarizeExecution(ex) {
  const name = ex.name.split('/').pop();
  const completed = ex.conditions?.find((c) => c.type === 'Completed');
  let state = 'running';
  if (ex.succeededCount > 0) state = 'succeeded';
  else if (ex.failedCount > 0 || ex.cancelledCount > 0 || completed?.state === 'CONDITION_FAILED') state = 'failed';
  else if (ex.completionTime) state = 'finished';
  const env = ex.template?.containers?.[0]?.env || [];
  const envVal = (k) => env.find((e) => e.name === k)?.value;
  return {
    name,
    state,
    createTime: ex.createTime,
    startTime: ex.startTime,
    completionTime: ex.completionTime,
    brand: envVal('BRAND'),
    dryRun: ['1', 'true'].includes(String(envVal('DRY_RUN') || '').toLowerCase()),
    message: completed?.message,
    consoleUrl: `https://console.cloud.google.com/run/jobs/executions/details/${REGION}/${name}/logs?project=${PROJECT}`,
  };
}

async function status() {
  const [job, list] = await Promise.all([gcp(RUN_API), gcp(`${RUN_API}/executions?pageSize=20`)]);
  return {
    job: {
      name: JOB,
      project: PROJECT,
      region: REGION,
      image: job.template?.template?.containers?.[0]?.image,
      ready: job.terminalCondition?.state === 'CONDITION_SUCCEEDED',
      lastModifier: job.lastModifier,
    },
    brands: Object.keys(brands()),
    executions: (list.executions || []).map(summarizeExecution),
  };
}

/** Pick a readable line from text, structured, or audit (system_event) entries. */
function formatLogMessage(e) {
  if (e.textPayload) return e.textPayload;
  if (e.jsonPayload) return e.jsonPayload.message ?? JSON.stringify(e.jsonPayload);
  const p = e.protoPayload;
  if (p) {
    const conditions = p.response?.status?.conditions || [];
    const failed = conditions.find((c) => c.status === 'False' && c.message) || conditions.find((c) => c.message);
    const detail = p.status?.message || failed?.message || '';
    return `[audit] ${p.methodName || 'event'}${detail ? `: ${detail}` : ''}`;
  }
  return '';
}

async function logs(execution, after) {
  if (!/^[a-z0-9-]+$/.test(execution || '')) {
    const e = new Error('execution must be a Cloud Run execution name');
    e.status = 400;
    throw e;
  }
  const filter = [
    'resource.type="cloud_run_job"',
    `resource.labels.job_name="${JOB}"`,
    `labels."run.googleapis.com/execution_name"="${execution}"`,
    after ? `timestamp>"${new Date(after).toISOString()}"` : `timestamp>="${new Date(Date.now() - 7 * 864e5).toISOString()}"`,
  ].join(' AND ');
  const data = await gcp(LOGGING_API, {
    method: 'POST',
    body: { resourceNames: [`projects/${PROJECT}`], filter, orderBy: 'timestamp asc', pageSize: 500 },
  });
  return {
    execution,
    entries: (data.entries || []).map((e) => ({
      id: e.insertId,
      timestamp: e.timestamp,
      severity: e.severity || 'DEFAULT',
      message: formatLogMessage(e),
    })),
  };
}

async function run({ brand, dryRun = true }) {
  const cfg = brands()[brand];
  if (!cfg) {
    const e = new Error(`Unknown brand '${brand}'. Configured: ${Object.keys(brands()).join(', ') || 'none'}`);
    e.status = 400;
    throw e;
  }
  const bucket = cfg.bucket || 'user_integration';
  const env = [
    ['BRAND', brand],
    ['GCP_BUCKET', bucket],
    ['PORTAL_USERNAME', cfg.portalUsername],
    ['PORTAL_SECRET_ID', cfg.portalSecretId || `${bucket}_americanairlines`],
    ['PORTAL_ACCOUNT_ID', cfg.portalAccountId],
    ['AA_MFA_MAILBOX', cfg.mfaMailbox],
    ['DRY_RUN', dryRun ? '1' : '0'],
  ]
    .filter(([, value]) => value)
    .map(([name, value]) => ({ name, value }));

  const op = await gcp(`${RUN_API}:run`, {
    method: 'POST',
    body: { overrides: { containerOverrides: [{ env }] } },
  });
  return { operation: op.name, execution: op.metadata?.name?.split('/').pop(), brand, dryRun };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      if ((q.op || 'status') === 'status') return reply(200, await status());
      if (q.op === 'logs') return reply(200, await logs(q.execution, q.after));
      return reply(400, { error: `Unknown op '${q.op}'` });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (body.op !== 'run') return reply(400, { error: `Unknown op '${body.op}'` });
      const expected = process.env.PIPELINE_TRIGGER_TOKEN;
      if (!expected || event.headers?.['x-pipeline-token'] !== expected) {
        return reply(401, { error: 'Missing or invalid x-pipeline-token' });
      }
      return reply(202, await run(body));
    }

    return reply(405, { error: 'Method Not Allowed', allowed: ['GET', 'POST'] });
  } catch (err) {
    console.error('aa-pipeline error:', err);
    return reply(err.status || 500, { error: err.message });
  }
};
