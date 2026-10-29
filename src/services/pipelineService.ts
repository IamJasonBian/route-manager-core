import axios from 'axios';
import { getApiBaseUrl } from '../config/runtime';

// Client for netlify/functions/aa-pipeline.js — the American Airlines data
// pipeline (Cloud Run Job) control plane.

export type ExecutionState = 'running' | 'succeeded' | 'failed' | 'finished';

export interface PipelineExecution {
  name: string;
  state: ExecutionState;
  createTime: string;
  startTime?: string;
  completionTime?: string;
  brand?: string;
  dryRun: boolean;
  message?: string;
  consoleUrl: string;
}

export interface PipelineStatus {
  job: { name: string; project: string; region: string; image?: string; ready: boolean; lastModifier?: string };
  brands: string[];
  executions: PipelineExecution[];
}

export interface PipelineLogEntry {
  id: string;
  timestamp: string;
  severity: string;
  message: string;
}

const ENDPOINT = `${getApiBaseUrl()}/aa-pipeline`;

const errorMessage = (err: unknown) =>
  axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);

export async function getPipelineStatus(): Promise<PipelineStatus> {
  try {
    const { data } = await axios.get<PipelineStatus>(ENDPOINT, { params: { op: 'status' } });
    return data;
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}

export async function getExecutionLogs(execution: string, after?: string): Promise<PipelineLogEntry[]> {
  try {
    const { data } = await axios.get<{ entries: PipelineLogEntry[] }>(ENDPOINT, {
      params: { op: 'logs', execution, ...(after && { after }) },
    });
    return data.entries;
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}

export async function runPipeline(
  brand: string,
  dryRun: boolean,
  token: string,
): Promise<{ execution?: string; operation: string }> {
  try {
    const { data } = await axios.post(
      ENDPOINT,
      { op: 'run', brand, dryRun },
      { headers: { 'x-pipeline-token': token } },
    );
    return data;
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}
