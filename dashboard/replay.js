// Plays an NDJSON stream backup through the live pipeline (dashboard ?demo=<url>).
// Used to rehearse without the car or a broker. Full Replay mode (controls, CSV) is v0.2.

/** Parse NDJSON text into [{receivedAt (ms), message}] sorted by receive time. */
export function parseNdjson(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.message && typeof rec.message === 'object') out.push({ receivedAt: Number(rec.received_at) / 1e6, message: rec.message });
    } catch {
      // skip corrupt lines
    }
  }
  return out.sort((a, b) => a.receivedAt - b.receivedAt);
}

/** Shift every sample time so the recording appears to happen now. */
export function shiftMessage(message, offsetNs) {
  const payload = Array.isArray(message.payload) ? message.payload.map((e) => ({ ...e, time: Number(e.time) + offsetNs })) : [];
  return { ...message, payload };
}

/**
 * Feed records to onMessage in real time (scaled by speed). Returns a stop function.
 * @param {{receivedAt: number, message: object}[]} records
 */
export function play(records, onMessage, { speed = 1, loop = true } = {}) {
  let timer = null;
  let stopped = false;
  let round = 0;
  const run = () => {
    if (!records.length) return;
    const wallStart = Date.now();
    const recStart = records[0].receivedAt;
    const offsetNs = (wallStart - recStart) * 1e6;
    const suffix = round ? `-loop${round}` : '';
    let i = 0;
    const tick = () => {
      if (stopped) return;
      const simNow = recStart + (Date.now() - wallStart) * speed;
      while (i < records.length && records[i].receivedAt <= simNow) {
        const m = shiftMessage(records[i].message, offsetNs);
        if (suffix) m.sessionId = `${m.sessionId}${suffix}`;
        onMessage(m);
        i += 1;
      }
      if (i < records.length) timer = setTimeout(tick, 100);
      else if (loop) { round += 1; timer = setTimeout(run, 2000); }
    };
    tick();
  };
  run();
  return () => { stopped = true; clearTimeout(timer); };
}
