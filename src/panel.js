import * as THREE from 'three';
import { LAYOUT } from './config.js';

// A floating glass card that teaches the controls and shows live stats.
// It's one canvas texture, redrawn only when something it shows changes.

const W = 640, H = 830;

export class InfoPanel {
  constructor(scene) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;

    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.5 * H / W),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false })
    );
    this.mesh.position.set(...LAYOUT.panelPos);
    this.mesh.rotation.y = LAYOUT.panelTilt;
    scene.add(this.mesh);

    this.stats = { bodies: 0, timeScale: 1, paused: false, trails: true, meals: 0, mealsToNova: 8 };
    this.dirty = true;
    this.draw();
  }

  setStats(patch) {
    let changed = false;
    for (const k in patch) {
      const v = k === 'timeScale' ? Math.round(patch[k] * 10) / 10 : patch[k];
      if (this.stats[k] !== v) { this.stats[k] = v; changed = true; }
    }
    if (changed) this.dirty = true;
  }

  toggle() {
    this.mesh.visible = !this.mesh.visible;
  }

  update() {
    if (!this.dirty || !this.mesh.visible) return;
    this.dirty = false;
    this.draw();
    this.tex.needsUpdate = true;
  }

  draw() {
    const g = this.g;
    g.clearRect(0, 0, W, H);

    // Card
    g.fillStyle = 'rgba(8, 16, 32, 0.82)';
    roundRect(g, 6, 6, W - 12, H - 12, 28);
    g.fill();
    g.strokeStyle = 'rgba(103, 215, 255, 0.55)';
    g.lineWidth = 3;
    roundRect(g, 6, 6, W - 12, H - 12, 28);
    g.stroke();

    // Title
    g.textAlign = 'center';
    g.fillStyle = '#ffd9a0';
    g.font = '600 54px Georgia, serif';
    g.fillText('GRAVITY GARDEN', W / 2, 86);
    g.fillStyle = 'rgba(160, 200, 255, 0.85)';
    g.font = 'italic 28px Georgia, serif';
    g.fillText('plant planets · grow orbits', W / 2, 130);

    line(g, 40, 158, W - 40, 158);

    // Controls
    g.textAlign = 'left';
    const rows = [
      ['GRAB', 'trigger, grip, or a pinch'],
      ['THROW', 'your speed becomes its orbit'],
      ['HOLD', 'shows the path it will take'],
      ['BOTH HANDS', 'grip space — zoom, pan, turn'],
      ['STICKS click', 'both at once: reset the view'],
      ['R-STICK ↑↓', 'time faster / slower'],
      ['A', 'trails on / off'],
      ['B', 'pause / resume'],
      ['X', 'clear all planets'],
      ['Y', 'hide this panel'],
    ];
    let y = 208;
    for (const [key, desc] of rows) {
      g.fillStyle = '#67d7ff';
      g.font = '600 26px "Segoe UI", system-ui, sans-serif';
      g.fillText(key, 48, y);
      g.fillStyle = 'rgba(235, 242, 255, 0.92)';
      g.font = '26px "Segoe UI", system-ui, sans-serif';
      g.fillText(desc, 244, y);
      y += 42;
    }

    line(g, 40, y - 10, W - 40, y - 10);

    // Lore
    g.fillStyle = 'rgba(255, 217, 160, 0.9)';
    g.font = 'italic 24px Georgia, serif';
    g.textAlign = 'center';
    g.fillText('soft throws bend into orbit · hurl hard to escape', W / 2, y + 34);
    g.fillText('every completed orbit plays a note', W / 2, y + 68);
    g.fillText(`the sun eats what falls in — feed it ${this.stats.mealsToNova}`, W / 2, y + 102);

    // Live stats
    const fed = this.stats.meals;
    g.fillStyle = 'rgba(140, 170, 210, 0.9)';
    g.font = '24px "Segoe UI", system-ui, sans-serif';
    const timeTxt = this.stats.paused ? 'paused' : `time ×${this.stats.timeScale}`;
    g.fillText(`${this.stats.bodies} planets   ·   ${timeTxt}   ·   sun fed ${fed}/${this.stats.mealsToNova}`, W / 2, H - 48);
  }
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function line(g, x1, y1, x2, y2) {
  g.strokeStyle = 'rgba(103, 215, 255, 0.3)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}
