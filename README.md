# dat2stl

Convert LEGO LDraw part files (`.dat`) to STL in the browser, for 3D printing.

Drop a `.dat` file, preview the part in 3D, set a scale multiplier, and
download a binary STL ready for Bambu Studio or any slicer.

Live at [dat2stl.timvandeneijnden.nl](https://dat2stl.timvandeneijnden.nl).

## Run

No build step. Any static server works:

```
python3 -m http.server 8642
# open http://localhost:8642
```

## Use

1. Drop a `.dat` (or `.ldr`) file onto the drop zone — or click "Try example".
2. Optionally set a scale multiplier (LDU → mm at 0.4 mm/LDU; e.g. 4× for
   giant parts).
3. **Convert & Preview** — fetches referenced primitives from a CDN-hosted
   LDraw parts library and renders the part in 3D.
4. **Download STL** — saves a binary STL.

## Notes

- The parts library is fetched from
  `https://cdn.jsdelivr.net/gh/gkjohnson/ldraw-parts-library@master/complete/ldraw/`
  (LDraw.org library, CORS-enabled). Change `LIBRARY_URL` in `src/main.js` and
  `src/worker.js` to point at a local copy if preferred.
- First conversion makes ~40–60 small HTTP fetches (primitives); they're cached
  in memory per session and by the browser CDN afterwards.
- Parsed sub-part geometry is cached keyed `filename__invert`.
- BFC winding, `INVERTNEXT`, and reflection (negative-determinant) inversion
  handling follow the LDraw format spec.

## Attribution

- Geometry is generated from the
  [LDraw.org Parts Library](https://library.ldraw.org/) under its own part
  licenses.
