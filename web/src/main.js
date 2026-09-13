import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const els = {
    dropzone: document.getElementById('dropzone'),
    fileinput: document.getElementById('fileinput'),
    partname: document.getElementById('partname'),
    parttitle: document.getElementById('parttitle'),
    scale: document.getElementById('scale'),
    convert: document.getElementById('convert'),
    download: document.getElementById('download'),
    status: document.getElementById('status'),
    stats: document.getElementById('stats'),
    example: document.getElementById('example'),
    viewport: document.getElementById('viewport'),
};

const LIBRARY_URL =
    'https://cdn.jsdelivr.net/gh/gkjohnson/ldraw-parts-library@master/complete/ldraw/';

const state = {
    fileText: null,
    fileName: null,
    lastSTL: null, // ArrayBuffer
    lastFileName: null,
    converting: false,
    requestId: 0,
};

// ---- worker ------------------------------------------------------------------

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

worker.onmessage = (event) => {
    const { type, id } = event.data;
    if (id !== state.requestId) return; // stale result
    if (type === 'progress') {
        setStatus(`Loading part: ${event.data.filename}…`);
    } else if (type === 'result') {
        state.converting = false;
        state.lastSTL = event.data.stl;
        const facets = event.data.triangles;
        const sizeMB = (event.data.stl.byteLength / 1024 / 1024).toFixed(2);
        els.stats.textContent = `${facets} facets, ${sizeMB} MB binary STL`;
        els.download.disabled = false;
        setStatus('Done.');
        updatePreview(event.data.stl);
    } else if (type === 'error') {
        state.converting = false;
        setStatus(`Error: ${event.data.message}`, true);
    }
};

// ---- three.js preview ----------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d21);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
els.viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const light1 = new THREE.DirectionalLight(0xffffff, 2.2);
light1.position.set(1, 2, 1.5);
scene.add(light1);
const light2 = new THREE.DirectionalLight(0xffffff, 0.8);
light2.position.set(-1, -1, -1);
scene.add(light2);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

let mesh = null;
let grid = null;

function updatePreview(stlBuffer) {
    // Parse binary STL back into geometry (simplest reliable path: we already
    // have binary in state; alternatively the worker could send raw triangles).
    const view = new DataView(stlBuffer);
    const numTriangles = view.getUint32(80, true);
    const positions = new Float32Array(numTriangles * 9);
    for (let t = 0; t < numTriangles; t++) {
        const base = 84 + t * 50 + 12; // skip normal
        for (let v = 0; v < 9; v++) {
            positions[t * 9 + v] = view.getFloat32(base + v * 4, true);
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.center();

    if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
    }
    mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
            color: 0xd9a441,
            metalness: 0.1,
            roughness: 0.55,
            side: THREE.DoubleSide,
        })
    );
    scene.add(mesh);

    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = maxDim * 2.2;
    camera.position.set(dist * 0.7, dist * 0.6, dist * 0.9);
    camera.near = maxDim / 100;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();

    if (grid) {
        scene.remove(grid);
        grid.geometry.dispose();
        grid.material.dispose();
    }
    grid = new THREE.GridHelper(maxDim * 2, 20, 0x3a4048, 0x2a2f36);
    grid.position.y = box.min.y;
    scene.add(grid);

    resizeRenderer();
}

function resizeRenderer() {
    const w = els.viewport.clientWidth || 1;
    const h = els.viewport.clientHeight || 1;
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}

window.addEventListener('resize', resizeRenderer);

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

// ---- UI wiring -------------------------------------------------------------------

function setStatus(msg, isError = false) {
    els.status.textContent = msg;
    els.status.classList.toggle('error', isError);
}

function loadFileText(name, text) {
    state.fileText = text;
    state.fileName = name;
    els.partname.textContent = name;
    const titleLine = text.split(/\r?\n/).find((l) => /^0\s+Name:/i.test(l));
    els.parttitle.textContent = titleLine
        ? titleLine.replace(/^0\s+Name:\s*/i, '').trim()
        : '';
    els.convert.disabled = false;
    setStatus('Ready. Click "Convert & Preview".');
}

function convert() {
    if (!state.fileText || state.converting) return;
    const scale = parseFloat(els.scale.value);
    if (!(scale > 0)) {
        setStatus('Scale must be a positive number.', true);
        return;
    }
    state.converting = true;
    state.requestId += 1;
    els.download.disabled = true;
    els.stats.textContent = '';
    setStatus('Fetching library parts and converting…');
    worker.postMessage({
        type: 'convert',
        id: state.requestId,
        text: state.fileText,
        scale,
        libraryUrl: LIBRARY_URL,
    });
}

function downloadSTL() {
    if (!state.lastSTL) return;
    const base = (state.fileName || 'part').replace(/\.(dat|ldr|mpd)$/i, '');
    const blob = new Blob([state.lastSTL], { type: 'model/stl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}.stl`;
    a.click();
    URL.revokeObjectURL(url);
}

// Drop zone
els.dropzone.addEventListener('click', () => els.fileinput.click());
els.fileinput.addEventListener('change', async () => {
    const file = els.fileinput.files[0];
    if (file) loadFileText(file.name, await file.text());
});
els.dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.dropzone.classList.add('drag');
});
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('drag'));
els.dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag');
    const file = e.dataTransfer.files[0];
    if (file) loadFileText(file.name, await file.text());
});

els.convert.addEventListener('click', convert);
els.scale.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') convert();
});
els.download.addEventListener('click', downloadSTL);

els.example.addEventListener('click', async () => {
    setStatus('Fetching example 40902.dat…');
    try {
        const resp = await fetch(LIBRARY_URL + 'parts/40902.dat');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        loadFileText('40902.dat', await resp.text());
        convert();
    } catch (e) {
        setStatus(`Error fetching example: ${e.message}`, true);
    }
});

resizeRenderer();
