"""Frame pack writer: the binary layout and the manifest the runtime loads.

Pure Python (struct / json / math / os) on purpose: crumple.py imports it inside Blender, the
unit tests import it under a plain interpreter, and neither needs the other. The format is
mirrored byte for byte by packages/motion/src/{format,half,oct,pack}.ts on the reading side and
by tools/bake/packWriter.ts on the writing side — change all three or none. The layout is
spelled out in the design spec section 9 and in tools/bake/README.md.

    python tools/bake/pack.py --fixture <dir>    writes tiny.json / tiny.bin
"""
import json
import math
import os
import struct
import sys

MAGIC = b'CRMP'
VERSION = 1
HEADER_BYTES = 32
HEADER_FMT = '<4sIIIIIII'


def align4(n):
    return (n + 3) & ~3


# --- grid tables ----------------------------------------------------------------------------

def grid_uvs(quads):
    """(u, v) per vertex, row-major, row 0 = bottom. Vertex index = row * (quads + 1) + col."""
    return [(x / quads, y / quads) for y in range(quads + 1) for x in range(quads + 1)]


def grid_faces(quads):
    """Quads (a, b, c, d) counter-clockwise seen from +Z, for Blender's from_pydata."""
    s = quads + 1
    return [(y * s + x, y * s + x + 1, (y + 1) * s + x + 1, (y + 1) * s + x)
            for y in range(quads) for x in range(quads)]


def grid_indices(quads):
    """Triangles (a, b, c) (a, c, d) per quad, same winding as grid_faces."""
    out = []
    for a, b, c, d in grid_faces(quads):
        out += [a, b, c, a, c, d]
    return out


# --- codecs ---------------------------------------------------------------------------------

def snorm8(v):
    """floor(v * 127 + 0.5), clamped: identical to the JS side, unlike Python's banker's round()."""
    return int(max(-127, min(127, math.floor(v * 127 + 0.5))))


def encode_oct(n):
    """Unit vector -> two signed bytes (octahedral mapping; +Z is (0, 0), -Z is (127, 127))."""
    x, y, z = n
    l = abs(x) + abs(y) + abs(z)
    if l == 0:
        return (0, 0)
    x, y, z = x / l, y / l, z / l
    if z < 0:
        x, y = (1 - abs(y)) * (1 if x >= 0 else -1), (1 - abs(x)) * (1 if y >= 0 else -1)
    return (snorm8(x), snorm8(y))


def decode_oct(a, b):
    x, y = a / 127, b / 127
    z = 1 - abs(x) - abs(y)
    if z < 0:
        x, y = (1 - abs(y)) * (1 if x >= 0 else -1), (1 - abs(x)) * (1 if y >= 0 else -1)
    l = math.sqrt(x * x + y * y + z * z)
    return (x / l, y / l, z / l)


def to_half(f):
    return struct.unpack('<H', struct.pack('<e', f))[0]


def from_half(h):
    return struct.unpack('<e', struct.pack('<H', h))[0]


# --- geometry helpers -----------------------------------------------------------------------

def grid_normals(positions, verts_per_side):
    """Area-weighted vertex normals of the grid (cross product of each quad's diagonals, summed
    into its four corners), unit length. A flat grid gives exactly (0, 0, 1)."""
    s = verts_per_side
    acc = [[0.0, 0.0, 0.0] for _ in positions]
    for y in range(s - 1):
        for x in range(s - 1):
            a, b, c, d = y * s + x, y * s + x + 1, (y + 1) * s + x + 1, (y + 1) * s + x
            pa, pb, pc, pd = positions[a], positions[b], positions[c], positions[d]
            e1 = (pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2])
            e2 = (pd[0] - pb[0], pd[1] - pb[1], pd[2] - pb[2])
            nx = e1[1] * e2[2] - e1[2] * e2[1]
            ny = e1[2] * e2[0] - e1[0] * e2[2]
            nz = e1[0] * e2[1] - e1[1] * e2[0]
            for i in (a, b, c, d):
                acc[i][0] += nx
                acc[i][1] += ny
                acc[i][2] += nz
    out = []
    for nx, ny, nz in acc:
        l = math.sqrt(nx * nx + ny * ny + nz * nz)
        out.append((nx / l, ny / l, nz / l) if l > 0 else (0.0, 0.0, 1.0))
    return out


def bbox(positions):
    lo = [min(p[c] for p in positions) for c in range(3)]
    hi = [max(p[c] for p in positions) for c in range(3)]
    return [round(v, 5) for v in lo + hi]


def alpha_floor(frame, stage1_end, last):
    """0 through stage 1, smoothstep to 1 at the last stored frame: the compaction ramp."""
    if last <= stage1_end:
        return 0.0 if frame < last else 1.0
    t = max(0.0, min(1.0, (frame - stage1_end) / (last - stage1_end)))
    return round(t * t * (3 - 2 * t), 4)


# --- pack -----------------------------------------------------------------------------------

def frame_layout(vertex_count):
    n = vertex_count
    return {'positions': 0, 'normals': 6 * n, 'ao': 8 * n, 'bytes': align4(9 * n)}


def pack_frame(positions, normals, ao):
    n = len(ao)
    if len(positions) != n or len(normals) != n:
        raise ValueError(f'frame arrays disagree: {len(positions)} positions, {len(normals)} normals, {n} ao')
    lay = frame_layout(n)
    buf = bytearray(lay['bytes'])
    struct.pack_into(f'<{3 * n}e', buf, lay['positions'], *[c for p in positions for c in p])
    struct.pack_into(f'<{2 * n}b', buf, lay['normals'], *[c for nv in normals for c in encode_oct(nv)])
    struct.pack_into(f'<{n}B', buf, lay['ao'], *[int(max(0, min(255, math.floor(a * 255 + 0.5)))) for a in ao])
    return bytes(buf)


def build_pack(verts_per_side, frames):
    """The whole .bin as bytes, plus the absolute byte offset of every frame block."""
    n = verts_per_side * verts_per_side
    quads = verts_per_side - 1
    uvs = grid_uvs(quads)
    indices = grid_indices(quads)
    if max(indices) > 0xFFFF:
        raise ValueError('UInt16 indices cannot address this grid')
    uv_off = HEADER_BYTES
    idx_off = align4(uv_off + 8 * n)
    base = align4(idx_off + 2 * len(indices))
    stride = frame_layout(n)['bytes']
    body = bytearray(base)
    struct.pack_into(HEADER_FMT, body, 0, MAGIC, VERSION, n, len(indices), len(frames), uv_off, idx_off, base)
    struct.pack_into(f'<{2 * n}f', body, uv_off, *[c for uv in uvs for c in uv])
    struct.pack_into(f'<{len(indices)}H', body, idx_off, *indices)
    offsets = []
    for i, fr in enumerate(frames):
        if len(fr['positions']) != n:
            raise ValueError(f'frame {fr["index"]}: {len(fr["positions"])} positions, grid has {n}')
        offsets.append(base + i * stride)
        body += pack_frame(fr['positions'], fr['normals'], fr['ao'])
    return bytes(body), offsets


def build_manifest(*, bucket, aspect, verts_per_side, frames, offsets, key_frames, light, bin_name, bin_bytes, sim):
    indices = [fr['index'] for fr in frames]
    if indices != sorted(indices) or len(set(indices)) != len(indices):
        raise ValueError(f'stored frames must be strictly increasing: {indices}')
    for k in key_frames:
        if k not in indices:
            raise ValueError(f'key frame {k} is not a stored frame ({indices})')
    l = math.sqrt(sum(c * c for c in light))
    if l == 0:
        raise ValueError('light must not be the zero vector')
    n = verts_per_side * verts_per_side
    stage1_end = sim.get('stage1End', 0)
    return {
        'version': VERSION,
        'bucket': bucket,
        'aspect': round(aspect, 5),
        'vertsPerSide': verts_per_side,
        'vertexCount': n,
        'indexCount': 6 * (verts_per_side - 1) ** 2,
        'bin': bin_name,
        'binBytes': bin_bytes,
        'frameBytes': frame_layout(n)['bytes'],
        'frames': [
            {'index': fr['index'], 'offset': off,
             'alphaFloor': fr.get('alphaFloor', alpha_floor(fr['index'], stage1_end, indices[-1])),
             'bbox': bbox(fr['positions'])}
            for fr, off in zip(frames, offsets)
        ],
        'keyFrames': list(key_frames),
        'light': [round(c / l, 5) for c in light],
        'sim': sim,
    }


def write_atomic(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'wb') as fh:
        fh.write(data)
    os.replace(tmp, path)


def write_pack(out_dir, bucket, verts_per_side, frames, key_frames, light, aspect, sim):
    os.makedirs(out_dir, exist_ok=True)
    data, offsets = build_pack(verts_per_side, frames)
    bin_name = f'{bucket}.bin'
    manifest = build_manifest(bucket=bucket, aspect=aspect, verts_per_side=verts_per_side, frames=frames,
                              offsets=offsets, key_frames=key_frames, light=light, bin_name=bin_name,
                              bin_bytes=len(data), sim=sim)
    write_atomic(os.path.join(out_dir, bin_name), data)
    text = json.dumps(manifest, sort_keys=True, indent=1) + '\n'
    write_atomic(os.path.join(out_dir, f'{bucket}.json'), text.encode('utf8'))
    return manifest


# --- fixture --------------------------------------------------------------------------------

def fixture_frames():
    """2 quads per side (9 vertices), 2 frames. Frame 0 flat; frame 4 is the plane z = 0.25 x
    with the plane's exact normal on every vertex and ao = i / 8. The Node test writes the same
    content with its own writer and expects the identical bytes."""
    side = 3
    n = side * side
    p0 = [(x - 1.0, y - 1.0, 0.0) for y in range(side) for x in range(side)]
    p1 = [(x, y, 0.25 * x) for x, y, _ in p0]
    l = math.sqrt(0.25 * 0.25 + 1)
    tilt = (-0.25 / l, 0.0, 1.0 / l)
    return side, [
        {'index': 0, 'positions': p0, 'normals': [(0.0, 0.0, 1.0)] * n, 'ao': [1.0] * n},
        {'index': 4, 'positions': p1, 'normals': [tilt] * n, 'ao': [i / (n - 1) for i in range(n)]},
    ]


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        side, frames = fixture_frames()
        manifest = write_pack(sys.argv[2], 'tiny', side, frames, [0, 4], (-0.4, 0.55, 0.73338), 1.0,
                              {'fps': 24, 'frames': 8, 'storeEvery': 4, 'stage1End': 4, 'seed': 0, 'blender': 'fixture'})
        print('wrote', os.path.join(sys.argv[2], 'tiny.json'), manifest['binBytes'], 'bytes')
    else:
        print('usage: python tools/bake/pack.py --fixture <dir>')
        sys.exit(2)
