# Debugging layout

If WhatsApp changes its DOM and sidebar collapse or offset looks wrong, use `_measure.mjs` to inspect computed layout in a saved page snapshot.

## Save a snapshot

1. Open [web.whatsapp.com](https://web.whatsapp.com/) in the broken state.
2. **File → Save Page As…** (save the complete page with assets into a folder).

Serve that folder over HTTP — WhatsApp's CSS uses `crossorigin` and often fails to load from `file://`:

```bash
cd path/to/saved-page && python3 -m http.server 8732
```

## Run the measurer

From this directory:

```bash
WHC_URL=http://127.0.0.1:8732/WhatsApp.html node _measure.mjs
```

Or pass the URL as an argument:

```bash
node _measure.mjs http://127.0.0.1:8732/WhatsApp.html
```

## Output

JSON with layout metrics, including:

- `--navbar-width` on `:root`
- Bounding boxes for the icon rail, `#side`, and `div.two`
- `#side` ancestor chain (margins, padding, position)
- Direct children of `div.two` (useful for drawer/divider elements)

## Environment variables

| Variable             | Description                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `WHC_URL`            | Page URL to load (required if not passed as argv)                                         |
| `WHC_SIMULATE_FIX=1` | Apply rail padding / `--navbar-width` overrides before measuring (to test collapse fixes) |
| `CHROME_BIN`         | Chrome/Chromium binary (default: `google-chrome-stable`)                                  |
| `CDP_PORT`           | Remote debugging port (default: `9222`)                                                   |

## Requirements

- Node.js 18+ (uses native `fetch` and top-level `await`)
- A Chromium-based browser installed locally
