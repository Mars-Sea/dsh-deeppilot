// Generates docs/preview.svg: a text-free 640x300 feature illustration for the
// DeepPilot bundle detail document. Deterministic (seeded PRNG) so reruns are
// byte-identical. Not part of the package; run with `node <this file>`.
import { writeFileSync } from 'node:fs'

/** Mulberry32: small deterministic PRNG so the QR pattern never changes. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const N = 21
const MOD = 4.5
const QX = 56
const QY = 96

/** 21x21 module grid: three finder patterns, timing rows, seeded data. */
function qrModules() {
  const grid = Array.from({ length: N }, () => Array(N).fill(false))
  const reserved = Array.from({ length: N }, () => Array(N).fill(false))
  const finder = (ox, oy) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3))
        grid[oy + y][ox + x] = ring !== 2
        reserved[oy + y][ox + x] = true
      }
    }
    // Quiet separator ring around each finder.
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const gy = oy + y
        const gx = ox + x
        if (gy < 0 || gx < 0 || gy >= N || gx >= N) continue
        if (y === -1 || y === 7 || x === -1 || x === 7) reserved[gy][gx] = true
      }
    }
  }
  finder(0, 0)
  finder(N - 7, 0)
  finder(0, N - 7)
  // Timing patterns.
  for (let i = 8; i < N - 8; i++) {
    grid[6][i] = i % 2 === 0
    grid[i][6] = i % 2 === 0
    reserved[6][i] = true
    reserved[i][6] = true
  }
  // Alignment pattern at (N-9, N-9).
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const ring = Math.max(Math.abs(x - 2), Math.abs(y - 2))
      grid[N - 9 + y][N - 9 + x] = ring !== 1
      reserved[N - 9 + y][N - 9 + x] = true
    }
  }
  const random = rng(0x5eed)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (reserved[y][x]) continue
      grid[y][x] = random() > 0.52
    }
  }
  return grid
}

const modules = qrModules()
const qrRects = []
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (!modules[y][x]) continue
    qrRects.push(
      `<rect x="${(QX + x * MOD).toFixed(2)}" y="${(QY + y * MOD).toFixed(2)}" width="${MOD}" height="${MOD}" fill="#1F2433"/>`,
    )
  }
}

/** One settings row: a label bar and a switch, the switch on or off. */
function toggleRow(x, y, w, on) {
  const knobX = on ? x + w - 26 : x + w - 46
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="30" rx="8" fill="#F7F9FD"/>`,
    `<rect x="${x + 10}" y="${y + 11}" width="${w * 0.42}" height="8" rx="4" fill="#C6CEDD"/>`,
    `<rect x="${x + w - 48}" y="${y + 7}" width="40" height="16" rx="8" fill="${on ? '#4D6BFE' : '#D5DBE7'}"/>`,
    `<circle cx="${knobX}" cy="${y + 15}" r="6" fill="#FFFFFF"/>`,
  ].join('')
}

/** One chat bubble on the phone screen. */
function bubble(x, y, w, mine) {
  return `<rect x="${x}" y="${y}" width="${w}" height="18" rx="9" fill="${mine ? '#4D6BFE' : '#EDF0FB'}"/>`
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300" fill="none" role="img" aria-label="DeepPilot: the DSH settings page on a computer shows a pairing QR code, and a phone connects to it over an encrypted link">
<defs>
<clipPath id="canvas"><rect width="640" height="300" rx="12"/></clipPath>
<linearGradient id="screen" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#F7F9FD"/>
</linearGradient>
</defs>
<g clip-path="url(#canvas)">
<rect width="640" height="300" fill="#F5F6FC"/>
<path d="M0 232C120 276 236 262 356 226C452 198 552 194 640 214V300H0Z" fill="#EBF0FC"/>

<!-- Computer: the DSH settings page with the pairing panel. -->
<rect x="36" y="40" width="304" height="216" rx="12" fill="#FFFFFF" stroke="#DFE4EF"/>
<path d="M36 52a12 12 0 0 1 12-12h280a12 12 0 0 1 12 12v20H36z" fill="#F7F9FD"/>
<circle cx="54" cy="56" r="3.5" fill="#D5DBE7"/>
<circle cx="66" cy="56" r="3.5" fill="#D5DBE7"/>
<circle cx="78" cy="56" r="3.5" fill="#D5DBE7"/>
<rect x="96" y="50" width="86" height="12" rx="6" fill="#E4E9F3"/>
<path d="M36 72h304" stroke="#DFE4EF"/>

<!-- Pairing panel: QR code on a light plate. -->
<rect x="48" y="86" width="112" height="112" rx="10" fill="#FFFFFF" stroke="#E4E9F3"/>
${qrRects.join('\n')}
<rect x="48" y="206" width="112" height="26" rx="8" fill="#4D6BFE"/>
<rect x="66" y="216" width="76" height="7" rx="3.5" fill="#FFFFFF" opacity="0.92"/>

<!-- Settings switches beside the panel. -->
${toggleRow(172, 86, 156, true)}
${toggleRow(172, 124, 156, false)}
${toggleRow(172, 162, 156, true)}
<rect x="172" y="200" width="156" height="32" rx="8" fill="#F7F9FD"/>
<rect x="182" y="211" width="60" height="8" rx="4" fill="#C6CEDD"/>
<rect x="248" y="207" width="70" height="18" rx="9" fill="#E4E9F3"/>

<!-- Encrypted link between the two devices. -->
<path d="M344 148h72" stroke="#8FA5F1" stroke-width="2" stroke-dasharray="5 5" stroke-linecap="round"/>
<circle cx="380" cy="148" r="17" fill="#FFFFFF" stroke="#D3DCF0"/>
<path d="M374 148v-4.5a6 6 0 0 1 12 0v4.5" stroke="#4D6BFE" stroke-width="2.2" stroke-linecap="round"/>
<rect x="372.5" y="147" width="15" height="11" rx="3" fill="#4D6BFE"/>
<circle cx="380" cy="152" r="1.8" fill="#FFFFFF"/>

<!-- Phone: the paired app showing a live session. -->
<rect x="428" y="34" width="176" height="232" rx="26" fill="#FFFFFF" stroke="#DFE4EF"/>
<rect x="438" y="44" width="156" height="212" rx="18" fill="url(#screen)"/>
<rect x="492" y="50" width="48" height="7" rx="3.5" fill="#E4E9F3"/>
<circle cx="458" cy="72" r="9" fill="#EDF0FB"/>
<rect x="472" y="66" width="58" height="7" rx="3.5" fill="#C6CEDD"/>
<rect x="472" y="77" width="34" height="6" rx="3" fill="#E4E9F3"/>
<path d="M438 92h156" stroke="#EDF0FB"/>
${bubble(450, 104, 92, false)}
${bubble(450, 128, 118, false)}
${bubble(494, 152, 88, true)}
${bubble(450, 176, 104, false)}
${bubble(512, 200, 70, true)}
<rect x="450" y="226" width="132" height="20" rx="10" fill="#F7F9FD" stroke="#E4E9F3"/>
<circle cx="572" cy="236" r="7" fill="#4D6BFE"/>

<!-- Signal arcs: the phone is connected, not pairing. -->
<path d="M404 128a26 26 0 0 1 0 40" stroke="#C3CFF6" stroke-width="2.4" stroke-linecap="round"/>
<path d="M412 120a38 38 0 0 1 0 56" stroke="#DCE4FA" stroke-width="2.4" stroke-linecap="round"/>
</g>
</svg>
`

writeFileSync(new URL('../docs/preview.svg', import.meta.url), svg)
console.log(`preview.svg: ${svg.length} bytes, ${qrRects.length} QR modules`)
