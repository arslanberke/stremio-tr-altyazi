import { syncCues, driftReport, coverage } from './align.js';

const jobs = { syncCues, driftReport, coverage };

process.on('message', ({ id, name, args }) => {
  try {
    process.send({ id, value: jobs[name](...args) });
  } catch (e) {
    process.send({ id, error: e.message });
  }
});
