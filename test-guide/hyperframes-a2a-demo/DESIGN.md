# Visual Identity

## Purpose

Competition demo video for the CROO Web3 Address Intel & Risk Agent. The video should
first explain the product function for judges, then include recorded execution evidence as
supporting proof.

## Style

- Canvas: 1920x1080 landscape.
- Tone: technical, focused, credible.
- Duration target: about 192 seconds.
- Structure: product capability -> three call modes -> A2A execution -> report page -> replay assets.
- Final report section: three generated report pages, each shown for 30 seconds with slow internal
  scrolling based on page length.
- Background: near-black green-tinted console surface with subtle grid lines.
- Primary colors:
  - Background: `#06140f`
  - Surface: `#0b1f18`
  - Border: `#21483b`
  - Text: `#e8f5ef`
  - Muted text: `#89a39a`
  - Official: `#22c55e`
  - Safe: `#38bdf8`
  - Caution: `#f59e0b`
  - Danger: `#ef4444`
- Typography: system sans-serif with monospace for logs and hashes.
- Cards: maximum 8px radius, thin borders, dense information.

## Motion

- Simple opacity and translate transitions.
- No randomness, no network data, no dynamic timestamps.
- Use deterministic GSAP timelines registered under `window.__timelines.main`.
