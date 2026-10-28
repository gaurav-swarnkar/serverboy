// Long-running tasks (installs, deployments) run in the background; the UI polls their log.
const crypto = require('crypto');
const ssh = require('./ssh');

const MAX_LOG = 512 * 1024;
const MAX_JOBS = 100;
const jobs = new Map();

function summary(job) {
  const { id, serverId, title, status, startedAt, endedAt, error } = job;
  return { id, serverId, title, status, startedAt, endedAt, error };
}

/**
 * steps: array of
 *   { label, cmd, sudo, allowFail, timeout }  — shell command on the server
 *   { label, fn: async (log) => {} }          — arbitrary async work
 */
function create(serverId, title, steps, { onSuccess } = {}) {
  const job = {
    id: crypto.randomUUID(),
    serverId,
    title,
    status: 'running',
    log: '',
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
  };
  jobs.set(job.id, job);
  if (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);

  const log = (text) => {
    job.log += text;
    if (job.log.length > MAX_LOG) job.log = `…(trimmed)…\n${job.log.slice(-MAX_LOG)}`;
  };

  (async () => {
    try {
      for (const step of steps) {
        if (step.label) log(`\n▶ ${step.label}\n`);
        if (step.fn) {
          try {
            await step.fn(log);
          } catch (err) {
            if (!step.allowFail) throw err;
            log(`(ignored) ${err.message}\n`);
          }
          continue;
        }
        const r = await ssh.exec(serverId, step.cmd, {
          sudo: step.sudo,
          onData: log,
          timeout: step.timeout ?? 30 * 60 * 1000,
        });
        if (r.code !== 0 && !step.allowFail) throw new Error(`Step failed with exit code ${r.code}`);
      }
      if (onSuccess) await onSuccess(log);
      job.status = 'success';
      log('\n✔ Done.\n');
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      log(`\n✘ ${err.message}\n`);
    } finally {
      job.endedAt = new Date().toISOString();
    }
  })();

  return summary(job);
}

function get(id) {
  return jobs.get(id) || null;
}

function list(serverId) {
  return [...jobs.values()]
    .filter((j) => !serverId || j.serverId === serverId)
    .reverse()
    .map(summary);
}

module.exports = { create, get, list, summary };
