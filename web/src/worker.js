// Web Worker: converts an LDraw part (text) to a binary STL ArrayBuffer,
// off the main thread. The parts-library fetch cache persists for the
// worker's lifetime, so subsequent conversions reuse fetched primitives.

import { LDrawParser } from './ldraw-parser.js';
import { buildBinarySTL } from './stl-writer.js';

const DEFAULT_LIBRARY =
    'https://cdn.jsdelivr.net/gh/gkjohnson/ldraw-parts-library@master/complete/ldraw/';

let cache = new Map();

self.onmessage = async (event) => {
    const { type, id } = event.data;
    if (type !== 'convert') return;
    const { text, scale, libraryUrl } = event.data;

    try {
        const parser = new LDrawParser({
            libraryUrl: libraryUrl || DEFAULT_LIBRARY,
            cache,
            onProgress: (filename, depth) => {
                if (depth === 0) {
                    self.postMessage({ type: 'progress', id, filename });
                }
            },
        });
        await parser.parse(text);
        const stl = buildBinarySTL(parser.triangles, scale || 1);

        // Transfer ownership of the buffer (zero copy).
        self.postMessage(
            {
                type: 'result',
                id,
                triangles: parser.triangles.length / 9,
                stl,
            },
            [stl]
        );
    } catch (e) {
        self.postMessage({ type: 'error', id, message: String(e && e.message || e) });
    }
};
