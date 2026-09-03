import * as THREE from 'three';
import { LAYOUT } from './config.js';

// A floating glass card that teaches the controls and shows live stats.
// It's one canvas texture, redrawn only when something it shows changes.

const W = 640, H = 900;

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
    this.invasion = null; // stats from the game mode; null in peacetime
    this.dirty = true;
    this.draw();
  }

  setStats(patch) {
    let changed = false;
    for (const k in patch) {
      if (k === 'invasion') continue;
      const v = k === 'timeScale' ? Math.round(patch[k] * 10) / 10 : patch[k];
      if (this.stats[k] !== v) { this.stats[k] = v; changed = true; }
    }
    if (patch.invasion !== undefined) {
      const key = JSON.stringify(patch.invasion);
      if (key !== this.invasionKey) {
        this.invasionKey = key;
        this.invasion = patch.invasion;
        changed = true;
      }
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
    if (this.invasion?.active) {
      this.drawInvasion();
      return;
    }
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
      ['EXIT HATCH', 'hold a hand on it to leave VR'],
    ];
    let y = 208;
    for (const [key, desc] of rows) {
      g.fillStyle = '#67d7ff';
      g.font = '600 26px "Segoe UI", system-ui, sans-serif';
      g.fillText(key, 48, y);
      g.fillStyle = 'rgba(235, 242, 255, 0.92)';
      g.font = '26px "Segoe UI", system-ui, sans-serif';
      g.fillText(desc, 244, y);
      y += 40;
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

  // Wartime layout: the card turns red and becomes a scoreboard.
  drawInvasion() {
    const g = this.g;
    const inv = this.invasion;
    g.clearRect(0, 0, W, H);

    g.fillStyle = 'rgba(30, 8, 14, 0.85)';
    roundRect(g, 6, 6, W - 12, H - 12, 28);
    g.fill();
    g.strokeStyle = 'rgba(255, 90, 80, 0.6)';
    g.lineWidth = 3;
    roundRect(g, 6, 6, W - 12, H - 12, 28);
    g.stroke();

    g.textAlign = 'center';
    g.fillStyle = '#ff6a5a';
    g.font = '600 56px Georgia, serif';
    g.fillText('INVASION', W / 2, 92);
    g.fillStyle = 'rgba(255, 180, 170, 0.85)';
    g.font = 'italic 27px Georgia, serif';
    const sub = inv.state === 'alarm' ? 'they noticed your garden'
      : inv.state === 'intermission' ? `next wave in ${inv.nextIn}s`
      : inv.state === 'retreat' ? 'they are leaving'
      : `wave ${inv.wave}  ·  ${inv.inbound} ship${inv.inbound === 1 ? '' : 's'} out there`;
    g.fillText(sub, W / 2, 138);

    redLine(g, 40, 170, W - 40, 170);

    // The score, big enough to read across the room.
    g.fillStyle = '#ffd9a0';
    g.font = '700 110px "Segoe UI", system-ui, sans-serif';
    g.fillText(String(inv.score), W / 2, 292);
    g.fillStyle = 'rgba(255, 200, 160, 0.75)';
    g.font = '26px "Segoe UI", system-ui, sans-serif';
    g.fillText(`best ${inv.best}`, W / 2, 336);

    // The hot line: a live combo, a loaded magazine of seekers, or both.
    const combo = inv.mult > 1 ? `COMBO ×${inv.mult}` : null;
    const seekers = inv.seekers > 0 ? `SEEKERS ${inv.seekers}` : null;
    g.font = '700 44px "Segoe UI", system-ui, sans-serif';
    if (combo && seekers) {
      g.fillStyle = '#8dff5a';
      g.fillText(combo, W * 0.29, 396);
      g.fillStyle = '#ffe9a0';
      g.fillText(seekers, W * 0.71, 396);
    } else if (combo || seekers) {
      g.fillStyle = combo ? '#8dff5a' : '#ffe9a0';
      g.fillText(combo ?? seekers, W / 2, 396);
    }

    redLine(g, 40, 424, W - 40, 424);

    g.textAlign = 'left';
    const rows = [
      ['TRIGGER', 'hold: hose out laser bolts'],
      ['GRIP', 'still grabs — planets swat ships'],
      ['POD', 'grab one: homing seekers'],
      ['WRAITH', 'only shootable while it shows'],
      ['WARDEN', 'kill it, or swat through its bubble'],
      ['SIPHON', 'drains the sun — nova first'],
      ['NOVA', 'feed the sun 8: it clears the sky'],
      ['BEACON', 'press again to end the siege'],
    ];
    let y = 468;
    for (const [key, desc] of rows) {
      g.fillStyle = '#ff8adf';
      g.font = '600 25px "Segoe UI", system-ui, sans-serif';
      g.fillText(key, 48, y);
      g.fillStyle = 'rgba(255, 235, 230, 0.92)';
      g.font = '24px "Segoe UI", system-ui, sans-serif';
      g.fillText(desc, 178, y);
      y += 40;
    }

    redLine(g, 40, y - 14, W - 40, y - 14);

    g.textAlign = 'center';
    g.fillStyle = 'rgba(255, 190, 180, 0.9)';
    g.font = '25px "Segoe UI", system-ui, sans-serif';
    g.fillText(`${inv.kills} ships down   ·   ${inv.worldsLost} worlds lost`, W / 2, y + 26);
    g.fillStyle = 'rgba(140, 170, 210, 0.9)';
    g.font = '24px "Segoe UI", system-ui, sans-serif';
    g.fillText(`${this.stats.bodies} planets   ·   sun fed ${this.stats.meals}/${this.stats.mealsToNova}`, W / 2, H - 44);
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

function redLine(g, x1, y1, x2, y2) {
  g.strokeStyle = 'rgba(255, 106, 90, 0.35)';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}
