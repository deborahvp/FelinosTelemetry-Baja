// Live connection to the broker with MQTT.js over WSS. Use a READ-ONLY broker user here:
// config.js is readable by anyone who can open the dashboard.

/* global mqtt */

/**
 * @param {{url: string, username: string, password: string, topic: string}} cfg
 * @param {{onMessage: (msg: object, topic: string) => void,
 *          onStatus: (state: 'connecting'|'connected'|'reconnecting'|'offline'|'auth') => void}} handlers
 */
export function connectLive(cfg, { onMessage, onStatus }) {
  if (typeof mqtt === 'undefined') {
    onStatus('offline');
    return null;
  }
  onStatus('connecting');
  const client = mqtt.connect(cfg.url, {
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    clientId: `felinos-dash-${Math.random().toString(16).slice(2, 10)}`,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 10000,
    keepalive: 30,
  });
  const decoder = new TextDecoder();
  client.on('connect', () => {
    onStatus('connected');
    client.subscribe(cfg.topic || 'felinos/#', { qos: 0 });
  });
  client.on('reconnect', () => onStatus('reconnecting'));
  client.on('offline', () => onStatus('offline'));
  client.on('error', (err) => {
    // CONNACK 4/5: bad credentials / not authorized. Stop retrying; the config must be fixed.
    if (err && (err.code === 4 || err.code === 5 || err.code === 134 || err.code === 135)) {
      onStatus('auth');
      client.end(true);
    }
  });
  client.on('message', (topic, payload) => {
    let msg;
    try {
      msg = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    if (msg && typeof msg === 'object') onMessage(msg, topic);
  });
  return client;
}
