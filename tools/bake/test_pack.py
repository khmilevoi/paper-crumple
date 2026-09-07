"""Unit tests for the pack writer. Pure Python; runs outside Blender, and tools/bake/python.test.ts
runs it under the repository's level-1 gate:

    python -m unittest discover -s tools/bake -p "test_*.py" -v
"""
import math
import os
import struct
import tempfile
import unittest

import pack


class Codecs(unittest.TestCase):
    def test_half_roundtrip_is_exact_on_the_frame0_grid(self):
        for i in range(65):
            v = i / 32 - 1
            self.assertEqual(pack.from_half(pack.to_half(v)), v)
        self.assertEqual(pack.to_half(1.0), 0x3C00)
        self.assertEqual(pack.to_half(-2.0), 0xC000)
        self.assertAlmostEqual(pack.from_half(pack.to_half(0.1)), 0.1, delta=1e-3)

    def test_oct_axes_and_roundtrip(self):
        self.assertEqual(pack.encode_oct((0, 0, 1)), (0, 0))
        self.assertEqual(pack.encode_oct((1, 0, 0)), (127, 0))
        self.assertEqual(pack.encode_oct((0, -1, 0)), (0, -127))
        self.assertEqual(pack.encode_oct((0, 0, -1)), (127, 127))
        for n in [(0.3, -0.4, 0.866), (-0.6, 0.2, -0.77), (0.707, 0.707, 0.0)]:
            l = math.sqrt(sum(c * c for c in n))
            n = tuple(c / l for c in n)
            d = pack.decode_oct(*pack.encode_oct(n))
            dot = sum(a * b for a, b in zip(n, d))
            self.assertGreater(dot, 0.999, f'{n} -> {d}')

    def test_snorm8_rounds_half_up_like_the_js_side(self):
        self.assertEqual(pack.snorm8(0.5 / 127), 1)      # 0.5 -> 1, not banker's 0
        self.assertEqual(pack.snorm8(1.5 / 127), 2)
        self.assertEqual(pack.snorm8(-0.5 / 127), 0)     # floor(-0.5 + 0.5) = 0
        self.assertEqual(pack.snorm8(5.0), 127)
        self.assertEqual(pack.snorm8(-5.0), -127)


class Grid(unittest.TestCase):
    def test_grid_tables(self):
        self.assertEqual(len(pack.grid_uvs(64)), 65 * 65)
        self.assertEqual(pack.grid_uvs(2)[0], (0.0, 0.0))
        self.assertEqual(pack.grid_uvs(2)[8], (1.0, 1.0))
        self.assertEqual(pack.grid_uvs(2)[1], (0.5, 0.0))     # column advances first
        idx = pack.grid_indices(2)
        self.assertEqual(len(idx), 2 * 2 * 6)
        self.assertEqual(idx[:6], [0, 1, 4, 0, 4, 3])
        self.assertEqual(pack.grid_faces(2)[0], (0, 1, 4, 3))

    def test_flat_grid_normals_point_up_and_tilted_plane_normals_tilt(self):
        n = 3
        flat = [(x / 2 - 0.5, y / 2 - 0.5, 0.0) for y in range(n) for x in range(n)]
        for nx, ny, nz in pack.grid_normals(flat, n):
            self.assertAlmostEqual(nz, 1.0)
        tilted = [(x, y, 0.25 * x) for x, y, _ in flat]
        expect = (-0.25, 0.0, 1.0)
        l = math.sqrt(sum(c * c for c in expect))
        for nv in pack.grid_normals(tilted, n):
            for got, want in zip(nv, expect):
                self.assertAlmostEqual(got, want / l, places=5)

    def test_alpha_floor_ramp(self):
        self.assertEqual(pack.alpha_floor(0, 20, 44), 0.0)
        self.assertEqual(pack.alpha_floor(20, 20, 44), 0.0)
        self.assertEqual(pack.alpha_floor(44, 20, 44), 1.0)
        self.assertEqual(pack.alpha_floor(32, 20, 44), 0.5)   # smoothstep(0.5) = 0.5
        self.assertLess(pack.alpha_floor(24, 20, 44), 0.2)


class Pack(unittest.TestCase):
    def frames(self, side):
        n = side * side
        q = side - 1
        p0 = [(x / q * 2 - 1, y / q * 2 - 1, 0.0) for y in range(side) for x in range(side)]
        p1 = [(x, y, 0.25 * x) for x, y, _ in p0]
        return [
            {'index': 0, 'positions': p0, 'normals': [(0, 0, 1)] * n, 'ao': [1.0] * n},
            {'index': 4, 'positions': p1, 'normals': pack.grid_normals(p1, side), 'ao': [i / (n - 1) for i in range(n)]},
        ]

    def test_layout_offsets_and_sizes(self):
        lay = pack.frame_layout(4225)
        self.assertEqual(lay, {'positions': 0, 'normals': 25350, 'ao': 33800, 'bytes': 38028})
        data, offsets = pack.build_pack(65, [self.frames(65)[0]])
        magic, version, nverts, nidx, nframes, uv_off, idx_off, base = struct.unpack_from('<4sIIIIIII', data, 0)
        self.assertEqual(magic, b'CRMP')
        self.assertEqual((version, nverts, nidx, nframes), (1, 4225, 24576, 1))
        self.assertEqual((uv_off, idx_off, base), (32, 33832, 82984))
        self.assertEqual(offsets, [82984])
        self.assertEqual(len(data), 82984 + 38028)

    def test_frame_roundtrip(self):
        side = 3
        n = side * side
        frames = self.frames(side)
        data, offsets = pack.build_pack(side, frames)
        lay = pack.frame_layout(n)
        for fr, off in zip(frames, offsets):
            halves = struct.unpack_from(f'<{3 * n}e', data, off + lay['positions'])
            for i, p in enumerate(fr['positions']):
                for c in range(3):
                    self.assertAlmostEqual(halves[3 * i + c], p[c], delta=2e-3)
            octs = struct.unpack_from(f'<{2 * n}b', data, off + lay['normals'])
            for i, nv in enumerate(fr['normals']):
                d = pack.decode_oct(octs[2 * i], octs[2 * i + 1])
                self.assertGreater(sum(a * b for a, b in zip(nv, d)), 0.999)
            aos = struct.unpack_from(f'<{n}B', data, off + lay['ao'])
            for i, a in enumerate(fr['ao']):
                self.assertEqual(aos[i], int(math.floor(a * 255 + 0.5)))

    def test_manifest_and_atomic_write(self):
        side = 3
        frames = self.frames(side)
        with tempfile.TemporaryDirectory() as tmp:
            manifest = pack.write_pack(tmp, '1x1', side, frames, [0, 4], (-0.4, 0.55, 0.73338), 1.0,
                                       {'fps': 24, 'frames': 8, 'storeEvery': 4, 'stage1End': 4})
            self.assertEqual(sorted(os.listdir(tmp)), ['1x1.bin', '1x1.json'])
            self.assertEqual(manifest['bucket'], '1x1')
            self.assertEqual(manifest['vertsPerSide'], 3)
            self.assertEqual([f['index'] for f in manifest['frames']], [0, 4])
            self.assertEqual(manifest['frames'][0]['alphaFloor'], 0.0)
            self.assertEqual(manifest['frames'][1]['alphaFloor'], 1.0)   # last stored frame is the ball
            self.assertEqual(manifest['frames'][1]['bbox'], [-1.0, -1.0, -0.25, 1.0, 1.0, 0.25])
            self.assertEqual(manifest['frames'][1]['offset'], manifest['frames'][0]['offset'] + manifest['frameBytes'])
            self.assertEqual(manifest['binBytes'], os.path.getsize(os.path.join(tmp, '1x1.bin')))
            self.assertAlmostEqual(sum(c * c for c in manifest['light']), 1.0, places=4)
            with open(os.path.join(tmp, '1x1.json'), encoding='utf8') as fh:
                text = fh.read()
            self.assertLess(text.index('"aspect"'), text.index('"bucket"'))   # sorted keys
        with self.assertRaises(ValueError):
            pack.build_manifest(bucket='1x1', aspect=1.0, verts_per_side=3, frames=frames, offsets=[0, 1],
                                key_frames=[0, 5], light=(0, 0, 1), bin_name='x', bin_bytes=1, sim={})

    def test_two_writes_are_byte_identical(self):
        side = 3
        a, _ = pack.build_pack(side, self.frames(side))
        b, _ = pack.build_pack(side, self.frames(side))
        self.assertEqual(a, b)


if __name__ == '__main__':
    unittest.main()
