// Offline track map (Leaflet). No online tiles: an optional georeferenced track image
// (L.imageOverlay, corners from assets/track.json) plus the GPS trace colored by speed.

/* global L */

import { cssVar } from './charts.js';

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Single-hue sequential ramp between the --seq-low and --seq-high tokens. */
export function rampColor(low, high, f) {
  const a = hexToRgb(low);
  const b = hexToRgb(high);
  const k = Math.max(0, Math.min(1, f));
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
}

export class TrackMap {
  constructor(el, { center, zoom, maxSpeedKmh, t }) {
    this.maxSpeed = maxSpeedKmh;
    this.t = t;
    this.map = L.map(el, { attributionControl: false, preferCanvas: true, zoomSnap: 0.25 }).setView(center, zoom);
    this.renderer = L.canvas({ padding: 0.5 });
    this.trace = L.layerGroup().addTo(this.map);
    this.overlay = null;
    this.hasImage = false;
    this.reset();
  }

  async loadTrack(url) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return false;
      const track = await res.json();
      const bounds = L.latLngBounds(track.bounds);
      this.overlay = L.imageOverlay(new URL(track.image, res.url).href, bounds).addTo(this.map);
      this.overlay.bringToBack();
      this.map.fitBounds(bounds);
      this.hasImage = true;
      return true;
    } catch {
      return false;
    }
  }

  reset() {
    this.trace.clearLayers();
    this.drawn = 0;
    this.cursor = null;
    this.halo = null;
    this.startMarker = null;
  }

  colorFor(speed) {
    return rampColor(cssVar('--seq-low'), cssVar('--seq-high'), speed === null ? 0 : speed / this.maxSpeed);
  }

  /** Draw new GPS points since the last call. */
  update(gps) {
    const n = gps.lat.length;
    if (n === 0) return;
    const first = this.drawn === 0;
    for (let i = Math.max(1, this.drawn); i < n; i += 1) {
      L.polyline([[gps.lat[i - 1], gps.lon[i - 1]], [gps.lat[i], gps.lon[i]]], {
        renderer: this.renderer, color: this.colorFor(gps.speed[i]), weight: 5, lineCap: 'round', interactive: false,
      }).addTo(this.trace);
    }
    this.drawn = n;
    const start = [gps.lat[0], gps.lon[0]];
    const cur = [gps.lat[n - 1], gps.lon[n - 1]];
    if (!this.startMarker) {
      this.startMarker = L.circleMarker(start, {
        renderer: this.renderer, radius: 5, color: cssVar('--surface'), weight: 2, fillColor: cssVar('--text'), fillOpacity: 1,
      }).addTo(this.trace);
      this.startMarker.bindTooltip(this.t('start'), { permanent: true, direction: 'top', offset: [0, -6] });
    }
    if (!this.cursor) {
      const red = cssVar('--brand-red');
      this.halo = L.circleMarker(cur, { renderer: this.renderer, radius: 13, stroke: false, fillColor: red, fillOpacity: 0.2 }).addTo(this.trace);
      this.cursor = L.circleMarker(cur, { renderer: this.renderer, radius: 7, color: '#fff', weight: 2.5, fillColor: red, fillOpacity: 1 }).addTo(this.trace);
    }
    this.halo.setLatLng(cur).bringToFront();
    this.cursor.setLatLng(cur).bringToFront();
    if (first && !this.hasImage) this.map.setView(cur, Math.max(this.map.getZoom(), 17));
    else if (!this.map.getBounds().pad(-0.1).contains(cur)) this.map.panTo(cur);
  }

  /** Redraw everything with the current theme colors. */
  redraw(gps) {
    this.reset();
    if (gps) this.update(gps);
  }

  relabel() {
    if (this.startMarker) this.startMarker.setTooltipContent(this.t('start'));
  }
}
