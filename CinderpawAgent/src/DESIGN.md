# Designing a page that looks made by a designer

Read this whole guide before you write a design: a poster, flyer, invitation, social post,
menu, certificate, banner, thumbnail, slide or page mockup. A design is an `app` artifact:
one HTML file with its CSS inline, drawn on a fixed artboard that scales to fit the window.
It runs sandboxed with no network: no web fonts, no remote images, no CDN.

## 1. Pick the artboard first

Write the size into the CSS and never let content decide it.

| What | Size (px) | Notes |
|---|---|---|
| Poster, A4 portrait | 1240 x 1754 | prints at A4, 150 dpi |
| Poster, A3 portrait | 1754 x 2480 | |
| Flyer, A5 | 874 x 1240 | |
| Invitation, 5 x 7 in | 1050 x 1470 | |
| Instagram post | 1080 x 1350 | portrait wins the feed |
| Square post | 1080 x 1080 | |
| Story, Reel cover | 1080 x 1920 | keep text 250 px away from top and bottom |
| YouTube thumbnail | 1280 x 720 | readable at 160 px wide |
| Slide | 1920 x 1080 | |
| LinkedIn banner | 1584 x 396 | the profile photo covers the bottom left |
| Business card | 1050 x 600 | |
| Certificate, landscape A4 | 1754 x 1240 | |

No size asked for: a poster is A4 portrait, a "post" is 1080 x 1350.

## 2. The skeleton (use it as is, then fill the artboard)

```html
<!doctype html>
<html lang="ro"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jazz in the night</title>
<style>
  :root { --w: 1240px; --h: 1754px; --m: 96px; /* margin: 6-8% of the width */ }
  html, body { margin: 0; height: 100%; background: #202024; }
  body { display: grid; place-items: center; overflow: hidden; }
  .artboard { width: var(--w); height: var(--h); position: relative; overflow: hidden;
    flex: none; transform-origin: center; box-sizing: border-box; padding: var(--m); }
  @page { size: 1240px 1754px; margin: 0; }
  @media print { html, body { background: none; height: auto; display: block; }
    .artboard { transform: none !important; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head>
<body><main class="artboard"><!-- the design --></main>
<script>
  const board = document.querySelector('.artboard');
  const fit = () => { board.style.transform =
    `scale(${Math.min(innerWidth / board.offsetWidth, innerHeight / board.offsetHeight)})`; };
  addEventListener('resize', fit); fit();
</script></body></html>
```

Inside the artboard, lay out with CSS grid. Position by grid areas, not by absolute pixel
guesses; absolute positioning is for decoration (shapes, glows) only.

## 3. Hierarchy: one thing first

- One focal element: the headline or one image-like shape. It is 3 to 5 times the body size.
- Three levels at most: headline, supporting line, details. Three sizes, not seven.
- Details that belong together sit together: date, time and place in one block, in that order.
- Leave at least a third of the artboard empty. Empty space is what makes it look expensive.
- Align everything to the margins and to one or two shared edges. Centre only symmetric
  designs (invitations, certificates); posters read better left-aligned.
- Squint test: shrink it to a thumbnail in your head. The headline and the date must still read.

## 4. Type (system fonts only; these exist on Windows, macOS and most Linux)

- Sans: `"Segoe UI Variable Display", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`
- Serif display: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif`
- Condensed (tall, loud headlines): `Bahnschrift, "DIN Condensed", "Arial Narrow", "Roboto Condensed", sans-serif`
- Mono (labels, tickets): `ui-monospace, "Cascadia Code", Consolas, Menlo, monospace`

Two families at most: one for the headline, one for everything else.

Scale on a 1080-1240 px wide artboard: headline 120-220 px, supporting 48-72 px, details
30-40 px, small print 22-26 px. Headline line-height 0.9-1.0 and letter-spacing -0.02em;
body line-height 1.35-1.5. Small uppercase labels: letter-spacing 0.12em, weight 600.
Scale every number by the artboard width for other sizes (a 1920 slide: x 1.6).

Write the user's language with its real letters (ă â î ș ț, é, ü). Never lorem ipsum: a fact
you do not have stays visible as [Band name] and you say so in one line in the chat.

## 5. Colour

Three colours plus neutrals: a background, a text colour, one accent used for the one thing
that matters (date, price, call to action). Body text against its background: contrast at
least 4.5:1; large headlines at least 3:1. Pick a palette by mood and keep to it:

| Mood | Background | Text | Accent | Extra |
|---|---|---|---|---|
| Night, jazz, cinema | #0f0c29 | #f8f1e5 | #f5c518 | #c0392b |
| Market, food, warm | #f4f1de | #3d405b | #e07a5f | #81b29a |
| Corporate, calm | #ffffff | #1e1e24 | #0b3d91 | #ff6b35 |
| Kids, party | #fff4e6 | #3a2e5c | #ff6f61 | #88b04b |
| Minimal | #fafafa | #111111 | #e63946 | |
| Ember | #1a1414 | #f6ece4 | #e8643b | #ffb38a |
| Wellness, nature | #f7f3ee | #3f4a3c | #7d8f69 | #d9c5b2 |
| Tech launch | #0b0f19 | #e5e7eb | #7c5cff | #22d3ee |

The user named colours or a brand: use theirs and only check the contrast.

## 6. Pictures without the network

You cannot load photos. Make the image out of the page itself:
- big shapes: circles, arcs, stripes, a sun, a stage light, drawn with CSS or inline SVG;
- gradients (`radial-gradient` for light, `linear-gradient` for sky and depth);
- an inline SVG illustration made of a few clean paths (an instrument, a cup, a leaf);
- texture: an SVG `feTurbulence` noise layer at 6-10% opacity over flat colour;
- giant type as the image (a single word or number bleeding off the edge).
A picture the user attached or a `data:` URI is fine. Never an `<img>` with an http address.

## 7. Before you save: the checklist

1. The artboard size is the one asked for (or the default above) and the skeleton is intact.
2. Nothing sits inside the margin; nothing overflows its box; no text is cut or overlaps.
3. One focal point; three type sizes at most; two families at most.
4. Contrast holds for every line of text (4.5:1 body, 3:1 large).
5. The key facts are all there and spelled right: what, when, where, how to get in.
6. Real letters of the language, no placeholder text except visible [missing facts].
7. It still reads as a thumbnail.

After saving, tell the user in one or two lines what you made and what is missing, and offer
the obvious next step (another format of the same design, a colour change, a missing fact).
