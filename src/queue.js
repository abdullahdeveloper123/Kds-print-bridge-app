/**
 * queue.js — Simple in-memory print queue.
 * Ensures jobs are processed one at a time so the printer isn't flooded.
 */

class PrintQueue {
  constructor(processFn) {
    this._process = processFn; // async (job) => void
    this._queue   = [];
    this._running = false;
  }

  enqueue(job) {
    this._queue.push(job);
    this._drain();
  }

  async _drain() {
    if (this._running) return;
    this._running = true;

    while (this._queue.length > 0) {
      const job = this._queue.shift();
      try {
        await this._process(job);
      } catch (err) {
        console.error('[Queue] Job failed:', err.message);
      }
    }

    this._running = false;
  }
}

module.exports = { PrintQueue };
