// JS port of ldraw2stl's lib/LDraw/Parser.pm
// Same logic: line-type dispatch, BFC winding, INVERTNEXT, reflection detection
// via matrix determinant, LDU->mm scaling. Sub-files are fetched from a CDN
// parts library instead of the local filesystem, in the same priority order.
//
// Sub-file references are scheduled at the point they are encountered (so
// INVERTNEXT applies to exactly the next reference, as in Parser.pm) but their
// network fetches run concurrently; triangle push order is therefore not
// guaranteed to match the Perl tool, which does not matter for STL output.

export const MM_PER_LDU = 0.4;

// Words that begin a "0 ..." comment line but are not meta commands (from Parser.pm).
const META_IGNORE = new Set([
    'hi-res', 'name:', 'author:', '!ldraw_org', '!license', '!history',
    'technic', 'box', 'cylinder', 'peg', 'rectangle', 'stud',
]);

// Library lookup priority, matching parse_sub_file_reference in Parser.pm:
// p/48 (hi-res) -> p -> parts -> parts/s
const SEARCH_PATHS = ['p/48/', 'p/', 'parts/', 'parts/s/'];

export class LDrawParser {
    constructor({ libraryUrl, cache, invert = false, onProgress = null } = {}) {
        if (!libraryUrl) throw new Error('libraryUrl required');
        this.libraryUrl = libraryUrl.endsWith('/') ? libraryUrl : libraryUrl + '/';
        // Map<cacheKey "filename__invert", Float32Array (9 floats per triangle)>
        // — the equivalent of LDraw::Parser::Cache.
        this.cache = cache || new Map();
        this.invert = invert;
        this.ccwWinding = true;
        this._invertNext = false;
        this.onProgress = onProgress;

        // Accumulated triangles for the part being parsed: 9 floats per triangle.
        this.triangles = [];

        // Shared fetch state (propagated to sub-parsers) so concurrent parses
        // dedupe network requests.
        this._inflight = new Map(); // url -> Promise<text>
        this._missing = new Set(); // filenames already warned about
        this._tasks = [];
    }

    _spawnTask(promiseFactory) {
        this._tasks.push(promiseFactory());
    }

    async _drainTasks() {
        const tasks = this._tasks.splice(0);
        await Promise.all(tasks);
    }

    // ---- geometry accumulation -------------------------------------------------

    _addTriangle(tri) {
        for (const p of tri) {
            this.triangles.push(p[0], p[1], p[2]);
        }
    }

    // ---- BFC / winding ----------------------------------------------------------

    // use_ccw_winding in Parser.pm
    _useCcwWinding() {
        return this.invert ? !this.ccwWinding : this.ccwWinding;
    }

    // handle_bfc_command in Parser.pm
    _handleBfc(items) {
        const first = items.shift();
        if (!first) return;
        if (first === 'INVERTNEXT') {
            this._invertNext = true;
            return;
        }
        if (first === 'CERTIFY') {
            const winding = items[0];
            if (winding === 'CW') this.ccwWinding = false;
        }
    }

    // compute_inversion in Parser.pm — called with the INVERTNEXT state captured
    // at the moment the type-1 line was encountered.
    _computeInversion(mat, invertNext) {
        let invert = invertNext ? !this.invert : this.invert;
        if (mat4Determinant(mat) < 0) invert = !invert;
        return invert;
    }

    // ---- line parsing -----------------------------------------------------------

    // parse_line in Parser.pm. Returns true if the line was a type-1 sub-file
    // reference (in which case the caller must handle it, to preserve
    // INVERTNEXT ordering).
    _parseLine(line, depth) {
        const trimmed = line.trim();
        const m = /^(\d+)\s*(.*)$/.exec(trimmed);
        if (!m) return false;
        const lineType = parseInt(m[1], 10);
        const rest = m[2];
        if (lineType === 0) {
            this._parseCommentOrMeta(rest);
        } else if (lineType === 1) {
            // Capture and consume INVERTNOW state synchronously, in file order.
            const capturedInvertNext = this._invertNext;
            this._invertNext = false;
            this._spawnTask(() => this._processSubFileReference(rest, capturedInvertNext, depth));
        } else if (lineType === 3) {
            this._parseTriangleCommand(rest);
        } else if (lineType === 4) {
            this._parseQuadrilateralCommand(rest);
        }
        // 2 (line) and 5 (optional line) are ignored, as in Parser.pm.
        return lineType === 1;
    }

    // parse_comment_or_meta in Parser.pm
    _parseCommentOrMeta(rest) {
        const items = rest.split(/\s+/);
        const first = items.shift();
        if (!first) return;
        if (first === '//') return;
        if (META_IGNORE.has(first.toLowerCase())) return;
        if (first === 'BFC') {
            this._handleBfc(items);
        }
    }

    // parse_triange_command in Parser.pm
    _parseTriangleCommand(rest) {
        const items = rest.split(/\s+/).map(Number);
        if (this._useCcwWinding()) {
            this._addTriangle([
                [items[1], items[2], items[3]],
                [items[4], items[5], items[6]],
                [items[7], items[8], items[9]],
            ]);
        } else {
            this._addTriangle([
                [items[1], items[2], items[3]],
                [items[7], items[8], items[9]],
                [items[4], items[5], items[6]],
            ]);
        }
    }

    // parse_quadrilateral_command in Parser.pm
    _parseQuadrilateralCommand(rest) {
        const items = rest.split(/\s+/).map(Number);
        const p1 = [items[1], items[2], items[3]];
        const p2 = [items[4], items[5], items[6]];
        const p3 = [items[7], items[8], items[9]];
        const p4 = [items[10], items[11], items[12]];
        if (this._useCcwWinding()) {
            this._addTriangle([p1, p2, p3]);
            this._addTriangle([p3, p4, p1]);
        } else {
            this._addTriangle([p1, p3, p2]);
            this._addTriangle([p3, p1, p4]);
        }
    }

    // ---- library fetching -------------------------------------------------------

    _probe(url) {
        let p = this._inflight.get(url);
        if (p) return p;
        p = fetch(url).then((resp) => {
            if (!resp.ok) {
                const err = new Error(`HTTP ${resp.status} for ${url}`);
                err.status = resp.status;
                throw err;
            }
            return resp.text();
        });
        this._inflight.set(url, p);
        p.catch(() => {});
        return p;
    }

    // Path probing matching parse_sub_file_reference in Parser.pm.
    // Returns Promise<text | null>.
    _resolveLibraryFile(filename) {
        const attempt = (idx) => {
            if (idx >= SEARCH_PATHS.length) return Promise.resolve(null);
            const url = this.libraryUrl + SEARCH_PATHS[idx] + filename;
            return this._probe(url).catch((e) => {
                if (e && e.status === 404) return attempt(idx + 1);
                throw e;
            });
        };
        return attempt(0);
    }

    // ---- sub-file references ------------------------------------------------------

    // parse_sub_file_reference in Parser.pm
    async _processSubFileReference(rest, capturedInvertNext, depth) {
        // "16 0 -10 0 9 0 0 0 1 0 0 0 -9 2-4edge.dat"
        const items = rest.split(/\s+/);
        const nums = items.slice(1, 13).map(Number);
        const [x, y, z, a, b, c, d, e, f, g, h, i] = nums;
        const filename = (items[13] || '').toLowerCase().replace(/\\/g, '/');

        // Matrix layout, matching Parser.pm:
        //   / a b c x \
        //   | d e f y |
        //   | g h i z |
        //   \ 0 0 0 1 /
        const mat = [a, b, c, x, d, e, f, y, g, h, i, z, 0, 0, 0, 1];

        const text = await this._resolveLibraryFile(filename);
        if (text === null) {
            if (!this._missing.has(filename)) {
                this._missing.add(filename);
                console.warn(`unable to find file: ${filename} in library paths`);
            }
            return;
        }

        const invert = this._computeInversion(mat, capturedInvertNext);
        const cacheKey = `${filename}__${invert ? 1 : 0}`;

        let subTriangles = this.cache.get(cacheKey);
        if (!subTriangles) {
            const sub = new LDrawParser({
                libraryUrl: this.libraryUrl,
                cache: this.cache,
                invert,
            });
            sub._inflight = this._inflight;
            sub._missing = this._missing;
            await sub._parseText(text, depth + 1);
            subTriangles = sub.triangles;
            this.cache.set(cacheKey, subTriangles);
        }

        if (this.onProgress) this.onProgress(filename, depth);

        // Transform cached sub-part vertices into place.
        for (let v = 0; v < subTriangles.length; v += 3) {
            this.triangles.push(
                ...mat4xv3(mat, subTriangles[v], subTriangles[v + 1], subTriangles[v + 2])
            );
        }
    }

    // parse_handle in Parser.pm, over an in-memory string.
    async _parseText(text, depth) {
        const lines = text.split(/\r\n|\r|\n/);
        for (const line of lines) {
            this._parseLine(line, depth);
        }
        await this._drainTasks();
    }

    // Top-level entry (parse in Parser.pm): parse a part file's text, resolving
    // all sub-file references, and return the accumulated triangle soup.
    async parse(text) {
        this.triangles = [];
        await this._parseText(text, 0);
        return this;
    }
}

// ---- math (mat4xv3, mat4determinant in Parser.pm) ------------------------------

function mat4xv3(mat, u, v, w) {
    const x = mat[0] * u + mat[1] * v + mat[2] * w + mat[3];
    const y = mat[4] * u + mat[5] * v + mat[6] * w + mat[7];
    const z = mat[8] * u + mat[9] * v + mat[10] * w + mat[11];
    return [x, y, z];
}

function mat4Determinant(mat) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = mat;
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

// calc_surface_normal in Parser.pm
// tri: flat array [x1,y1,z1, x2,y2,z2, x3,y3,z3]
export function calcSurfaceNormal(tri) {
    const ux = tri[3] - tri[0];
    const uy = tri[4] - tri[1];
    const uz = tri[5] - tri[2];
    const vx = tri[6] - tri[0];
    const vy = tri[7] - tri[1];
    const vz = tri[8] - tri[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len === 0) return [0, 0, 0];
    return [nx / len, ny / len, nz / len];
}
