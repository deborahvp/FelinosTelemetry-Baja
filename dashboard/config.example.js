// Copy this file to config.js (NOT versioned) and fill it in.
// Use a READ-ONLY broker user: anyone who can open the dashboard can read these values.
export default {
  mqtt: {
    // HiveMQ Cloud: Overview → "WebSocket TLS URL" (port 8884, path /mqtt)
    url: 'wss://YOUR-CLUSTER.s1.eu.hivemq.cloud:8884/mqtt',
    username: '',
    password: '',
    topic: 'felinos/#',
  },
  // How the phone is mounted: which vehicle axis each phone axis points along (signed).
  // Same values as device.axis_map in meta.yaml. Lateral sign is derived (ISO 8855: + = left).
  axisMap: { x: 'lateral', y: 'longitudinal', z: 'vertical' },
  // Optional offline track image; see assets/track.example.json
  track: 'assets/track.json',
  // Map start position when there is no track image (test site in León, approximate)
  mapCenter: [21.0894, -101.6987],
  mapZoom: 17,
  // Online satellite basemap (Esri World Imagery). Needs internet; set false to keep the map fully offline.
  satellite: true,
  mapMaxSpeedKmh: 50,
  windowSeconds: 60,
  placeName: 'León, Gto.',
  // Vehicle track width in metres (config/vehicles track_width_m) for the inner-tire turning
  // radius of VG-05. null = the dashboard shows the radius at the CG only.
  trackWidthM: null,
};
