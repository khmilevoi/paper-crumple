"""Bakes one generic paper sheet crumpling. Stage 1: hinge-pinned flaps fold inward.
Stage 2: the pin is released and a shrinking sphere with inward normals crushes the stack into a
ball while a central force field keeps loose flaps from escaping. Run through bake/run.mjs:

    node bake/run.mjs bake/crumple.py --bucket 2x3 --stage 1 --stills 0,4,8,12,16,20
    node bake/run.mjs bake/crumple.py --bucket 2x3 --stills 24,32,44

A stage-2 run simulates twice: pass 1 is stage 1 alone and only exists to measure the stack the
crusher has to start around; pass 2 rebuilds the same scene, adds the crusher, and runs the full
--frames. Because the crusher is huge and the pull is zero until stage1_end - 1, pass 2 must
reproduce pass 1 up to there, and main() asserts exactly that.

Deterministic: no random numbers anywhere, fps 24, single thread (-t 1 from run.mjs), and
nothing time-stamped in the output. Fails loudly: every inconsistency raises, and
--python-exit-code 1 (run.mjs) turns that into a non-zero exit.

Coordinates: the sheet lies in Z = 0, width = aspect, height = 1, centred on the origin, +Z
toward the orthographic camera. The fold lines come from bake/folds.json (Task 6): the line is
nx*x + ny*y = c and the flap is the side where nx*x + ny*y > c.

Each fold splits the sheet into three regions by the signed distance d of a vertex to that fold's
line (--depth-scale first slides the line outward, which is how much of the middle stays open):

    d >= +band   flap body   hook weight 1  -> rigid rotation about the fold line
    |d| < band   crease      hook weight fades toward the line -> a rounded roll across the line
    d <= -band   not this flap's material   hook weight 0

band is --crease-band grid cells. The weight is a smooth function of d, never of which grid cell a
vertex sits in, which is what keeps a crease off the 64x64 staircase.

The regions are NOT exclusive: a vertex inside two flaps is in both hook groups, and the Hook
modifiers stack, so it takes the earlier fold's rotation and then the later one's -- which is what
folding a corner twice does to real paper. Cutting the overlap out of one of the two flaps instead
(what this used to do) tears that flap along a jagged claim boundary and renders as a pleat fan.

The cloth pin is a separate field: 1 (hard) everywhere except within band of a fold line, where it
falls to --crease-pin so the solver can own the crease core. At the default 1.0 nothing is solved
during stage 1 and every crease is the geometric roll the graded hook blend traces.
"""
import argparse
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
# Scratch output — stills, stage1-*.json, and the default pack destination — lives in
# tools/bake/out/, which tools/bake/.gitignore keeps untracked. In the spike this was the sibling
# `out/` of `bake/`; after the move to tools/bake/ that would be `tools/out/`, outside this
# directory (spec 13). A real bake is copied into packages/motion/src/packs/<bucket>/ by hand.
ROOT = HERE
sys.path.insert(0, HERE)
import pack  # noqa: E402  (tools/bake/pack.py)

BUCKETS = {'2x3': 2 / 3, '1x1': 1.0, '3x2': 1.5}
LIGHT = (-0.4, 0.55, 0.73338)   # toward the light; upper-left-front, like paper-fold's 125 degrees
GUARD = 3.0                     # sheet units; a vertex further out than this means the sim exploded
REST_EPS = 1e-6                 # the mesh stores float32, so frame 0 lands this close to the rest grid


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser(
        prog='crumple.py',
        epilog='--strip is RETIRED. It pinned "the outer fraction of each flap" with a binary, '
               'per-vertex test, which staircased every crease along the grid and left the centre '
               'unanchored at any value below 1. The flap / crease / centre split is now geometric: '
               '--crease-band sets the width of the crease, --crease-pin how much of its core the solver '
               'owns, and --depth-scale how deep the flaps cut.')
    p.add_argument('--bucket', required=True, choices=sorted(BUCKETS))
    p.add_argument('--frames', type=int, default=48)
    p.add_argument('--out', default=os.path.join(HERE, 'out', 'packs'))
    p.add_argument('--quads', type=int, default=64)
    p.add_argument('--store-every', type=int, default=4)
    p.add_argument('--stage1-end', type=int, default=20)
    p.add_argument('--key', default='0,8,16,24,32,44', help='recommended key frames (simulated frame numbers)')
    p.add_argument('--stage', choices=['1', '2'], default='2', help='1 = flaps only (tuning stills); 2 = full bake')
    # stage 2
    p.add_argument('--ball', type=float, default=0.28,
                   help='final crusher radius as a fraction of the stack radius. The shipped bake runs 0.24 (see '
                        'bake:all in package.json): at 0.28 the crush stops while the outer flaps still arch over '
                        'the bulk, and the 1x1 bucket freezes an open notch between a free edge and the layers '
                        'behind it into the last stored frame, which the verify harness sees as a hole in the '
                        'silhouette. 0.28 stays the default because it is what stage 2 was first tuned against')
    p.add_argument('--r0-scale', type=float, default=1.1, help='crusher start radius / measured stack radius')
    p.add_argument('--pull', type=float, default=1.5, help='central force field strength during the crush')
    p.add_argument('--ao-samples', type=int, default=16,
                   help='AO rays per vertex, half per side of the sheet. 1..16: the directions are a fixed set of '
                        '8 (hemisphere_dirs, so the bake is deterministic) cast on both sides, and asking for more '
                        'than 16 is rejected rather than silently under-sampled')
    p.add_argument('--stills', default='', help='comma-separated frames to render to out/stills/')
    p.add_argument('--render', choices=['auto', 'workbench', 'cycles'], default='auto')
    p.add_argument('--seed', type=int, default=7, help='recorded in the manifest; the sim itself has no randomness')
    # stage 1
    p.add_argument('--hinge', choices=['pins', 'paddles'], default='pins', help='approach A (pins) or fallback B')
    p.add_argument('--flaps', type=int, default=6)
    p.add_argument('--crease-band', type=float, default=2.5,
                   help='half-width of the crease, in grid cells (a cell is 1/quads of the sheet height). Across '
                        'it the hook rotation fades in and the cloth pin fades out, both smoothly in the distance '
                        'to the fold line, so the fold gets a bend radius instead of a per-cell staircase')
    p.add_argument('--depth-scale', type=float, default=0.6,
                   help='how deep every folds.json line cuts: 1 = as authored, 0.5 = half as deep. Slides the line '
                        'outward (c = support - (support - c) * depthScale) so the middle of the sheet stays open')
    p.add_argument('--crease-pin', type=float, default=1.0,
                   help='cloth pin weight on the fold line itself, rising to 1 at the edge of the crease band. '
                        '1 (the default) places every crease vertex exactly where the smooth blend says, which is '
                        'the only setting that keeps the crease off the grid: below about 0.95 the solver takes '
                        'the crease over, its springs snap it back onto mesh edges and the staircase returns')
    p.add_argument('--hinge-deg', type=float, default=150.0)
    p.add_argument('--hinge-frames', type=int, default=8)
    p.add_argument('--stagger', type=int, default=2, help='frames between successive flap starts')
    # cloth (paper preset)
    p.add_argument('--quality', type=int, default=10)
    p.add_argument('--mass', type=float, default=0.15)
    p.add_argument('--tension', type=float, default=80.0)
    p.add_argument('--compression', type=float, default=80.0)
    p.add_argument('--shear', type=float, default=60.0)
    p.add_argument('--bending', type=float, default=25.0,
                   help='bending stiffness. The shipped bake runs 500 (see bake:all in package.json): the crush '
                        'buckles the sheet, and a plate buckles at a wavelength that grows with its bending '
                        'stiffness, so 25 gives grid-scale crumb and 500 gives the broad flat facets a paper ball '
                        'has. It is not a default because 25 is the neutral cloth value stage 1 was tuned against')
    p.add_argument('--damping', type=float, default=10.0, help='tension/compression/shear damping')
    p.add_argument('--bend-damping', type=float, default=2.0)
    p.add_argument('--air', type=float, default=1.0)
    p.add_argument('--self-dist', type=float, default=0.006)
    p.add_argument('--col-dist', type=float, default=0.008)
    p.add_argument('--col-quality', type=int, default=4)
    p.add_argument('--pin-stiffness', type=float, default=1.0,
                   help='goal-spring stiffness for partially pinned vertices, i.e. the crease band; full-weight '
                        'pins are hard and ignore it')
    args = p.parse_args(argv)
    # Validated here, not where they are consumed: a bad flag must cost a Blender startup, not a
    # full two-pass simulation. --depth-scale keeps its own check inside scale_folds (it is called
    # by the fold-table tooling too); these two have no such second caller.
    check_ao_samples(args.ao_samples)
    if not 0.0 <= args.crease_pin <= 1.0:
        raise RuntimeError(f'--crease-pin must be in [0, 1], got {args.crease_pin}')
    return args


# --- scene ----------------------------------------------------------------------------------

def fresh_scene(args):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Every keyframe inserted below interpolates linearly; set once, globally, instead of
    # walking fcurves (whose API changed with slotted actions in 4.4+).
    bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
    scene = bpy.context.scene
    scene.frame_start = 0
    scene.frame_end = args.frames - 1
    scene.render.fps = 24
    scene.gravity = (0.0, 0.0, 0.0)   # no gravity, no floor: pins and colliders drive everything
    return scene


def make_sheet(scene, aspect, quads):
    """Grid in Z = 0, width aspect, height 1, centred; vertex row*(quads+1)+col; UVs from pack."""
    n = quads + 1
    rest = [(aspect * (x / quads - 0.5), 1.0 * (y / quads - 0.5), 0.0) for y in range(n) for x in range(n)]
    mesh = bpy.data.meshes.new('sheet')
    mesh.from_pydata(rest, [], pack.grid_faces(quads))
    mesh.update()
    if len(mesh.vertices) != n * n or len(mesh.polygons) != quads * quads:
        raise RuntimeError(f'grid built {len(mesh.vertices)} verts / {len(mesh.polygons)} faces, expected {n * n} / {quads * quads}')
    uv = mesh.uv_layers.new(name='UVMap')
    uvs = pack.grid_uvs(quads)
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            uv.data[li].uv = uvs[mesh.loops[li].vertex_index]
    obj = bpy.data.objects.new('sheet', mesh)
    scene.collection.objects.link(obj)
    return obj, rest


def load_folds(bucket, count, aspect=None, depth_scale=1.0):
    """The bucket's fold lines from folds.json, rescaled by depth_scale when an aspect is given.
    folds.json stays the source of the normals and of the authored depth; depth_scale only slides
    each line along its own normal."""
    with open(os.path.join(HERE, 'folds.json'), encoding='utf8') as fh:
        table = json.load(fh)
    folds = table[bucket][:count]
    if len(folds) != count:
        raise RuntimeError(f'folds.json has {len(folds)} folds for {bucket}, {count} requested')
    if aspect is None:
        if depth_scale != 1.0:
            raise RuntimeError('load_folds needs the bucket aspect to apply a depth scale')
        return folds
    return scale_folds(folds, aspect, depth_scale)


# --- fold geometry --------------------------------------------------------------------------

def sheet_support(nx, ny, aspect):
    """How far the sheet reaches along the unit normal (nx, ny): the max over its four corners.
    A fold line at c = support has an empty flap; at c = -support the flap is the whole sheet."""
    return max(nx * sx * aspect / 2 + ny * sy * 0.5 for sx in (-1.0, 1.0) for sy in (-1.0, 1.0))


def scale_folds(folds, aspect, depth_scale):
    """Rescale how deep every line cuts without re-deriving it: the normal is kept and the line
    slides outward to c = support - (support - c) * depthScale. depthScale 1 is folds.json
    verbatim; smaller values make shallower flaps, which is what leaves the middle open."""
    if not 0.0 < depth_scale <= 1.0:
        raise RuntimeError(f'--depth-scale must be in (0, 1], got {depth_scale}')
    out = []
    for f in folds:
        support = sheet_support(f['nx'], f['ny'], aspect)
        scaled = dict(f)
        scaled['c'] = support - (support - f['c']) * depth_scale
        if not -support < scaled['c'] < support:
            raise RuntimeError(f'scaled fold line {scaled} misses the sheet (support {support:.5f})')
        out.append(scaled)
    return out


def smoothstep(lo, hi, t):
    if hi <= lo:
        return 0.0 if t < lo else 1.0
    u = min(1.0, max(0.0, (t - lo) / (hi - lo)))
    return u * u * (3.0 - 2.0 * u)


def signed_distance(f, x, y):
    """Distance from (x, y) to fold line f, positive on the flap side; the normal is unit, so
    this is in sheet units and comparable across folds."""
    return f['nx'] * x + f['ny'] * y - f['c']


def flap_weight(f, x, y, band):
    """This flap's hook weight at (x, y): 0 more than band inside the line, 1 more than band beyond
    it, smoothstep across. A continuous function of the distance to the line and of nothing else,
    which is what stops the crease from reading as a 64x64 staircase."""
    return smoothstep(-band, band, signed_distance(f, x, y))


def assign_flaps(rest, folds, band):
    """Hook weight per vertex, one dict {vertex index: weight} per flap.

    Every flap claims its whole half-plane, overlaps included -- a vertex inside two flaps lands in
    both groups and both hooks drive it, composing in stack order (see add_hinges). Nothing is
    subtracted from a flap because another flap got there first: doing that tore the losing flap
    along a claim boundary that jumped from grid cell to grid cell, and the stretched quads across
    it rendered as a sawtooth pleat fan wherever two flaps met.

    Vertices further than band inside every fold line are in no group: they are the centre, and the
    pin holds them flat."""
    groups = [{} for _ in folds]
    for i, (x, y, _) in enumerate(rest):
        for k, f in enumerate(folds):
            w = flap_weight(f, x, y, band)
            if w > 0.0:
                groups[k][i] = w
    for k, group in enumerate(groups):
        driven = sum(1 for w in group.values() if w >= 1.0)
        if driven < 3:
            raise RuntimeError(f'flap {k} is too thin: {driven} vertices sit beyond the crease band, need 3')
    return groups


def pin_weights(rest, folds, band, core):
    """Cloth pin weight per vertex: lerp(core, 1, smoothstep(0, band, |d|)) on the distance d to
    the NEAREST fold line.

    Weight 1 is a hard pin (Blender snaps any goal above 0.999), and that is what the centre and
    the flap bodies get: the centre stays flat at its rest position and holds the whole sheet
    still, each flap body rides its hooks rigidly. `core` is --crease-pin, the weight on a fold
    line itself. At the default 1.0 every crease is held to the graded hook blend, whose profile is
    a smooth roll --crease-band wide, so the fold has a bend radius that is geometric rather than
    solved; below about 0.95 the solver takes the crease over and its springs snap it back onto
    mesh edges, which brings the staircase back. See the report for the measurements.

    Nearest rather than deepest: flaps overlap, so a fold line can run across another flap's body,
    and where it does that body is creased too and has to soften exactly like any other crease."""
    out = {}
    for i, (x, y, _) in enumerate(rest):
        d = min(abs(signed_distance(f, x, y)) for f in folds)
        out[i] = core + (1.0 - core) * smoothstep(0.0, band, d)
    return out


def add_weighted_group(obj, name, weights):
    """A vertex group from {index: weight}. The full-weight vertices go in one call because they
    are the overwhelming majority; only the graded band is added one at a time."""
    vg = obj.vertex_groups.new(name=name)
    vg.add([i for i, w in weights.items() if w >= 1.0], 1.0, 'REPLACE')
    for i, w in sorted(weights.items()):
        if w < 1.0:
            vg.add([i], w, 'REPLACE')
    return vg


def hinge_axis_and_pivot(f):
    """Rotation about (ny, -nx, 0) by a positive angle lifts the flap toward +Z, the camera."""
    nx, ny, c = f['nx'], f['ny'], f['c']
    return Vector((ny, -nx, 0.0)), Vector((nx * c, ny * c, 0.0))


def fold_transforms(folds, hinge_deg):
    """The world matrix each fully folded flap applies, in the same order the hooks are stacked.
    Identical to what Blender computes for hook i at the end of its window: the sheet object sits
    at the origin, so empty.matrix_world @ matrix_inverse is exactly this rotation about the fold
    line. Used by open_fractions to measure the pose the bake will actually produce."""
    angle = math.radians(hinge_deg)
    out = []
    for f in folds:
        axis, pivot = hinge_axis_and_pivot(f)
        out.append(Matrix.Translation(pivot) @ Matrix.Rotation(angle, 4, axis) @ Matrix.Translation(-pivot))
    return out


def open_fractions(aspect, folds, hinge_deg, samples=384):
    """Two coverage numbers for the sheet, from a samples x samples raster of the flat rest grid.

    open:    area outside every flap half-plane / sheet area -- the window no flap is cut from.
    visible: how much of that window a viewer still sees once the flaps have folded back over it,
             which is what "the middle is open" actually means. Every sample runs through the same
             stack of folds the hooks apply, in the same order, so material inside two half-planes
             folds twice, and the cell its projection lands in is marked hidden.

    Each fold is a rigid motion, so projecting the stacked result back onto the sheet plane has a
    Jacobian of at most 1: the scattered samples stay at least as dense as the raster, and the
    hidden set therefore has no pinholes."""
    mats = fold_transforms(folds, hinge_deg)
    hidden = bytearray(samples * samples)
    window = []
    for j in range(samples):
        y = (j + 0.5) / samples - 0.5
        for i in range(samples):
            x = aspect * ((i + 0.5) / samples - 0.5)
            claims = [k for k, f in enumerate(folds) if signed_distance(f, x, y) > 0.0]
            if not claims:
                window.append(j * samples + i)
                continue
            p = Vector((x, y, 0.0))
            for k in claims:
                p = mats[k] @ p
            ci = int((p.x / aspect + 0.5) * samples)
            cj = int((p.y + 0.5) * samples)
            if 0 <= ci < samples and 0 <= cj < samples:
                hidden[cj * samples + ci] = 1
    total = samples * samples
    return len(window) / total, sum(1 for c in window if not hidden[c]) / total


def animated_empty(scene, name, f, args, index):
    """An Empty on the fold line whose axis-angle rotation sweeps 0 -> hinge_deg over the flap's
    window. Axis-angle, not quaternion, so the angle itself interpolates linearly."""
    axis, pivot = hinge_axis_and_pivot(f)
    empty = bpy.data.objects.new(name, None)
    empty.location = pivot
    empty.rotation_mode = 'AXIS_ANGLE'
    scene.collection.objects.link(empty)
    start = 1 + index * args.stagger
    end = start + args.hinge_frames
    empty.rotation_axis_angle = (0.0, axis.x, axis.y, axis.z)
    empty.keyframe_insert('rotation_axis_angle', frame=start)
    empty.rotation_axis_angle = (math.radians(args.hinge_deg), axis.x, axis.y, axis.z)
    empty.keyframe_insert('rotation_axis_angle', frame=end)
    empty.rotation_axis_angle = (0.0, axis.x, axis.y, axis.z)   # rest pose for matrix_inverse
    bpy.context.view_layer.update()
    return empty


def add_hinges(scene, obj, folds, groups, args):
    """Approach A: each flap is hooked to its animated empty at the weights assign_flaps gives it
    (the Hook modifier blends rest -> hooked by vertex weight, so the crease band rotates only
    partially), and pin_weights decides how hard the cloth is held to that result -- rigidly on the
    centre and on the flap bodies, loosening to --crease-pin along each fold line. The crease cores
    are the only cloth the solver really owns, and they become the folds.

    Stack order is fold order, and fold order is hinge order: animated_empty starts fold i at frame
    1 + i * stagger, so the modifiers already run earliest-fold-first. That matters because the
    groups overlap -- hook i deforms whatever hooks 0..i-1 handed it, so a corner inside two flaps
    is rotated about line i-1 and then about line i, the order the two folds actually happen in."""
    for i, (f, group) in enumerate(zip(folds, groups)):
        add_weighted_group(obj, f'flap_{i}', group)
        empty = animated_empty(scene, f'hinge_{i}', f, args, i)
        hook = obj.modifiers.new(f'hook_{i}', 'HOOK')
        hook.object = empty
        hook.vertex_group = f'flap_{i}'
        hook.matrix_inverse = empty.matrix_world.inverted()
    band = args.crease_band / args.quads
    rest = [tuple(v.co) for v in obj.data.vertices]
    add_weighted_group(obj, 'pin', pin_weights(rest, folds, band, args.crease_pin))


def add_paddles(scene, obj, folds, args):
    """Fallback B: no pins. A collider plane just under each flap is parented to the animated
    empty and sweeps up through 150 degrees, pushing the flap over. Use with --hinge paddles."""
    obj.vertex_groups.new(name='pin')   # empty group: nothing pinned
    for i, f in enumerate(folds):
        axis, pivot = hinge_axis_and_pivot(f)
        n = Vector((f['nx'], f['ny'], 0.0))
        empty = animated_empty(scene, f'hinge_{i}', f, args, i)
        mesh = bpy.data.meshes.new(f'paddle_{i}')
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
        bm.to_mesh(mesh)
        bm.free()
        paddle = bpy.data.objects.new(f'paddle_{i}', mesh)
        scene.collection.objects.link(paddle)
        reach = 0.9   # further than any flap tip
        paddle.location = pivot + n * (reach / 2) + Vector((0.0, 0.0, -0.012))
        paddle.rotation_mode = 'XYZ'
        paddle.rotation_euler = (0.0, 0.0, math.atan2(n.y, n.x))
        paddle.scale = (reach / 2, 1.0, 1.0)
        paddle.parent = empty
        bpy.context.view_layer.update()
        paddle.matrix_parent_inverse = empty.matrix_world.inverted()
        paddle.modifiers.new('collision', 'COLLISION')
        paddle.collision.thickness_outer = 0.006
        paddle.collision.thickness_inner = 0.006
        paddle.collision.use_culling = False
        paddle.collision.cloth_friction = 5.0
        paddle.hide_render = True


def add_release(obj, args):
    """Pins are SET to weight 0 through a VertexWeightMix whose mask fades 0 -> 1 right after
    stage 1. Cloth re-reads its pin group every step, so the flaps go free for the crush."""
    mod = obj.modifiers.new('release', 'VERTEX_WEIGHT_MIX')
    mod.vertex_group_a = 'pin'
    mod.mix_mode = 'SET'
    mod.mix_set = 'ALL'
    mod.default_weight_b = 0.0
    mod.mask_constant = 0.0
    obj.keyframe_insert('modifiers["release"].mask_constant', frame=args.stage1_end)
    mod.mask_constant = 1.0
    obj.keyframe_insert('modifiers["release"].mask_constant', frame=args.stage1_end + 2)
    mod.mask_constant = 0.0


def add_cloth(obj, args):
    """The paper preset. Must be the LAST modifier: hooks and the release edit the mesh it reads."""
    cloth = obj.modifiers.new('cloth', 'CLOTH')
    s = cloth.settings
    c = cloth.collision_settings
    s.quality = args.quality
    s.mass = args.mass
    s.tension_stiffness = args.tension
    s.compression_stiffness = args.compression
    s.shear_stiffness = args.shear
    s.bending_stiffness = args.bending
    s.bending_model = 'ANGULAR'
    s.tension_damping = args.damping
    s.compression_damping = args.damping
    s.shear_damping = args.damping
    s.bending_damping = args.bend_damping
    s.air_damping = args.air
    s.vertex_group_mass = 'pin'
    s.pin_stiffness = args.pin_stiffness
    s.effector_weights.gravity = 0.0
    c.use_collision = True
    c.collision_quality = args.col_quality
    c.distance_min = args.col_dist
    c.friction = 5.0
    c.use_self_collision = True
    c.self_distance_min = args.self_dist
    c.self_friction = 5.0
    cloth.point_cache.frame_start = 0
    cloth.point_cache.frame_end = args.frames - 1
    return cloth


def cloth_settings_dict(args):
    return {k: getattr(args, k) for k in (
        'quads', 'quality', 'mass', 'tension', 'compression', 'shear', 'bending', 'damping', 'bend_damping', 'air',
        'self_dist', 'col_dist', 'col_quality', 'pin_stiffness', 'hinge', 'flaps', 'crease_band', 'crease_pin',
        'depth_scale', 'hinge_deg', 'hinge_frames', 'stagger')}


# --- stills ---------------------------------------------------------------------------------

def choose_renderer(args):
    if args.render != 'auto':
        return args.render
    try:
        with open(os.path.join(ROOT, 'out', 'smoke.json'), encoding='utf8') as fh:
            return json.load(fh).get('render', 'workbench')
    except OSError:
        return 'workbench'


def setup_render(scene, args):
    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.ortho_scale = 1.4
    cam_obj = bpy.data.objects.new('cam', cam)
    cam_obj.location = (0.0, 0.0, 3.0)   # looking down -Z, +Y up in the image
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.0
    sun_obj = bpy.data.objects.new('sun', sun)
    sun_obj.rotation_euler = Vector(LIGHT).to_track_quat('Z', 'Y').to_euler()   # shines along -LIGHT
    scene.collection.objects.link(sun_obj)
    scene.render.resolution_x = scene.render.resolution_y = 768
    scene.render.image_settings.file_format = 'PNG'
    if choose_renderer(args) == 'cycles':
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'
        scene.cycles.samples = 16
        scene.cycles.use_denoising = False
    else:
        scene.render.engine = 'BLENDER_WORKBENCH'
        sh = scene.display.shading
        sh.light = 'STUDIO'
        sh.color_type = 'SINGLE'
        sh.single_color = (0.85, 0.82, 0.78)
        sh.show_cavity = True
        sh.cavity_type = 'BOTH'
        # BOTH is world cavity + screen-space curvature, but Blender ships both curvature factors
        # at 0, so asking for BOTH without these two lines buys nothing. Curvature is the half that
        # draws a dark line along every crease and every flap edge, which is the only thing that
        # separates a flap lying on the sheet from the sheet: same colour, same normal, same light.
        sh.curvature_ridge_factor = 1.0
        sh.curvature_valley_factor = 1.0
        sh.show_shadows = True
        sh.show_backface_culling = False


def render_still(scene, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    if os.path.getsize(path) < 1000:
        raise RuntimeError(f'still {path} is empty')


# --- simulation -----------------------------------------------------------------------------

def evaluated_positions(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    pos = [tuple(v.co) for v in me.vertices]
    ev.to_mesh_clear()
    return pos


def simulate(obj, scene, frames, on_frame=None):
    """Steps frames 0..frames-1 in order (the cloth cache fills sequentially) and returns the
    evaluated positions per frame. on_frame(f) runs after each frame, for stills."""
    out = []
    for f in range(frames):
        scene.frame_set(f)
        pos = evaluated_positions(obj)
        far = max(abs(c) for p in pos for c in p)
        if far != far or far > GUARD:
            raise RuntimeError(f'simulation blew up at frame {f}: extent {far:.3f} > {GUARD}')
        out.append(pos)
        if on_frame:
            on_frame(f)
        print(f'frame {f:2d}  extent {far:.3f}', flush=True)
    return out


def check_rest_frame(pos, rest):
    """Frame 0 must BE the flat grid, vertex for vertex. src/bakeLoader.js and src/mask.js read
    the stored order as pack.grid_uvs's (row 0 = y min, index = row * side + col); anything moving
    at frame 0 means the pack and the UVs disagree. Tolerance is float32 mesh storage, nothing
    more."""
    if len(pos) != len(rest):
        raise RuntimeError(f'frame 0 has {len(pos)} vertices, the grid has {len(rest)}')
    worst = max(max(abs(a - b) for a, b in zip(p, r)) for p, r in zip(pos, rest))
    if worst > REST_EPS:
        raise RuntimeError(f'frame 0 is not the flat rest grid: worst vertex drift {worst:.3e} > {REST_EPS}')
    return worst


def bounding_sphere(pos):
    lo = [min(p[c] for p in pos) for c in range(3)]
    hi = [max(p[c] for p in pos) for c in range(3)]
    centre = tuple((lo[c] + hi[c]) / 2 for c in range(3))
    radius = max(math.dist(p, centre) for p in pos)
    return centre, radius


# --- stage 2: crush, AO, pack -----------------------------------------------------------------

def add_crusher(scene, centre, r0, args):
    """Stage 2: a UV sphere with inward normals collides with the stack from outside and shrinks
    from r0 (just outside the measured stack) to ball * r0; a point force at the centre keeps loose
    flaps from escaping. Both idle (huge sphere, zero force) until stage 1 has ended."""
    mesh = bpy.data.meshes.new('crusher')
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=1.0)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)   # normals inward: the cloth is inside the sphere
    bm.to_mesh(mesh)
    bm.free()
    sph = bpy.data.objects.new('crusher', mesh)
    sph.location = centre
    scene.collection.objects.link(sph)
    sph.modifiers.new('collision', 'COLLISION')
    sph.collision.thickness_outer = 0.01
    sph.collision.thickness_inner = 0.01
    sph.collision.use_culling = True
    sph.collision.cloth_friction = 5.0
    sph.collision.damping = 0.5
    big = 3.0
    r_end = r0 * args.ball
    for frame, r in ((0, big), (args.stage1_end - 1, big), (args.stage1_end, r0),
                     (args.frames - 4, r_end), (args.frames - 1, r_end)):
        sph.scale = (r, r, r)
        sph.keyframe_insert('scale', frame=frame)
    sph.hide_render = True

    # bpy.data.objects.new('pull', None) makes a bare empty whose .field is None; only the
    # effector_add operator allocates the FieldSettings struct, so create it that way and fetch
    # the result via bpy.context.object (effector_add already links it into the current scene).
    bpy.ops.object.effector_add(type='FORCE', location=centre)
    pull = bpy.context.object
    pull.name = 'pull'
    pull.field.shape = 'POINT'
    pull.field.falloff_power = 0.0
    pull.field.use_max_distance = False
    pull.field.strength = 0.0
    pull.keyframe_insert('field.strength', frame=args.stage1_end - 1)
    pull.field.strength = -args.pull   # negative = attracts
    pull.keyframe_insert('field.strength', frame=args.stage1_end)
    pull.hide_render = True
    return sph


def hemisphere_dirs():
    """Eight fixed directions in the +Z hemisphere of a local frame: two rings (30 and 60 degrees
    elevation), four azimuths each, the rings offset by 45 degrees. Fixed, so the bake is
    deterministic."""
    dirs = []
    for elev, phase in ((30.0, 0.0), (60.0, 45.0)):
        for k in range(4):
            az = math.radians(phase + 90.0 * k)
            el = math.radians(elev)
            dirs.append((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    return dirs


def check_ao_samples(samples):
    """--ao-samples cannot exceed the fixed direction set. hemisphere_dirs() returns 8 directions
    and each is cast on both sides, so 16 rays is the ceiling. Truncating the list to what exists
    while still dividing by the requested count (what this used to do) inflates every AO value —
    at --ao-samples 32 nothing can ever read below 0.5 — so it is an error, not a clamp."""
    limit = 2 * len(hemisphere_dirs())
    if not 1 <= samples <= limit:
        raise RuntimeError(f'--ao-samples must be in 1..{limit} (the direction set is fixed), got {samples}')


def ambient_occlusion(pos, quads, normals, samples):
    """Per-vertex AO, samples rays split evenly between the two sides of the sheet (a flap shows
    its back), against a BVH of the frame's own geometry. 1 = open, 0 = fully enclosed."""
    from mathutils.bvhtree import BVHTree
    check_ao_samples(samples)
    verts = [Vector(p) for p in pos]
    bvh = BVHTree.FromPolygons(verts, pack.grid_faces(quads), all_triangles=False)
    per_side = max(1, samples // 2)
    local = hemisphere_dirs()[:per_side]
    eps = 0.003
    reach = 0.6
    out = []
    up = Vector((0.0, 0.0, 1.0))
    right = Vector((1.0, 0.0, 0.0))
    for p, nv in zip(verts, normals):
        n = Vector(nv)
        t = n.cross(up) if abs(n.z) < 0.9 else n.cross(right)
        t.normalize()
        b = n.cross(t)
        hits = 0
        for sign in (1.0, -1.0):
            for lx, ly, lz in local:
                d = (t * lx + b * ly + n * (lz * sign)).normalized()
                loc, _, _, _ = bvh.ray_cast(p + d * eps, d, reach)
                if loc is not None:
                    hits += 1
        out.append(1.0 - hits / (2 * per_side))
    return out


def export_pack(args, aspect, pos, centre, r_stack, extra_sim=None):
    side = args.quads + 1
    n = side * side
    stored = list(range(0, args.frames, args.store_every))
    last = stored[-1]
    keys = [int(k) for k in args.key.split(',')]
    for k in keys:
        if k not in stored:
            raise RuntimeError(f'key frame {k} is not a stored frame {stored}')
    hw, hh = aspect / 2, 0.5
    # Frame 0 is written from the grid itself, never from the sim: (col/32 - 1, row/32 - 1, 0) is
    # exact in float16, which is what makes pose 0 pixel-identical to the sprite.
    rest_norm = [(x / args.quads * 2 - 1, y / args.quads * 2 - 1, 0.0) for y in range(side) for x in range(side)]
    frames = []
    for f in stored:
        if f == 0:
            fr = {'index': 0, 'positions': rest_norm, 'normals': [(0.0, 0.0, 1.0)] * n, 'ao': [1.0] * n}
        else:
            p = pos[f]
            normals = pack.grid_normals(p, side)
            ao = ambient_occlusion(p, args.quads, normals, args.ao_samples)
            fr = {'index': f, 'positions': [(x / hw, y / hh, z / hh) for x, y, z in p], 'normals': normals, 'ao': ao}
        fr['alphaFloor'] = pack.alpha_floor(f, args.stage1_end, last)
        frames.append(fr)
        print(f'export frame {f:2d}  alphaFloor {fr["alphaFloor"]:.3f}  bbox {pack.bbox(fr["positions"])}', flush=True)
    sim = {
        'fps': 24, 'frames': args.frames, 'storeEvery': args.store_every, 'stage1End': args.stage1_end,
        'seed': args.seed, 'blender': bpy.app.version_string,
        'stackCentre': [round(c, 5) for c in centre], 'stackRadius': round(r_stack, 5),
        'ball': args.ball, 'r0Scale': args.r0_scale, 'pull': args.pull, 'aoSamples': args.ao_samples,
        'cloth': cloth_settings_dict(args),
    }
    sim.update(extra_sim or {})
    manifest = pack.write_pack(args.out, args.bucket, side, frames, keys, LIGHT, aspect, sim)
    print(f'wrote {os.path.join(args.out, args.bucket)}.json + .bin: {manifest["binBytes"]} bytes, {len(frames)} frames')
    return manifest


def build_stage1(args, aspect, folds):
    scene = fresh_scene(args)
    obj, rest = make_sheet(scene, aspect, args.quads)
    if args.hinge == 'pins':
        # A cell is 1/quads of the sheet height, so the band is resolution-relative by construction.
        add_hinges(scene, obj, folds, assign_flaps(rest, folds, args.crease_band / args.quads), args)
    else:
        add_paddles(scene, obj, folds, args)
    add_release(obj, args)
    return scene, obj, rest


# --- main -----------------------------------------------------------------------------------

def main():
    args = parse_args()
    aspect = BUCKETS[args.bucket]
    folds = load_folds(args.bucket, args.flaps, aspect, args.depth_scale)
    stills = [int(s) for s in args.stills.split(',') if s.strip()]
    # Stage 2 rebuilds the scene from scratch and pass 2 is only guaranteed to reproduce pass 1 up
    # to stage1_end - 1 (the drift guard below is what proves it); a still below stage1End is
    # therefore identical to what a --stage 1 run already renders, not a stage-2-specific result.
    if args.stage != '1':
        for f in stills:
            if f < args.stage1_end:
                raise RuntimeError('stills below stage1End belong to --stage 1')
    still_dir = os.path.join(ROOT, 'out', 'stills')
    frac_open, frac_visible = open_fractions(aspect, folds, args.hinge_deg)
    print(f'crumple {args.bucket} aspect {aspect:.4f} blender {bpy.app.version_string} '
          f'hinge {args.hinge} stage {args.stage}')
    print(f'depth scale {args.depth_scale} crease band {args.crease_band} cells: '
          f'open fraction {frac_open:.3f}, still visible once folded {frac_visible:.3f}')

    # Pass 1: flaps only. Measures the stack the crusher has to start around. In a stage-1 run
    # this is the whole job and it renders the stills.
    scene, obj, rest = build_stage1(args, aspect, folds)
    add_cloth(obj, args)
    pass1_stills = stills if args.stage == '1' else []
    if pass1_stills:
        setup_render(scene, args)

    def on_frame_1(f):
        if f in pass1_stills:
            render_still(scene, os.path.join(still_dir, f'{args.bucket}-f{f:02d}.png'))

    pos1 = simulate(obj, scene, args.stage1_end + 1, on_frame_1)
    print(f'frame 0 is the rest grid to {check_rest_frame(pos1[0], rest):.2e}')
    centre, r_stack = bounding_sphere(pos1[args.stage1_end])
    print(f'stage 1: stack centre {tuple(round(c, 3) for c in centre)} radius {r_stack:.3f}')
    if args.stage == '1':
        report = {'bucket': args.bucket, 'stage1End': args.stage1_end, 'centre': [round(c, 5) for c in centre],
                  'radius': round(r_stack, 5), 'frames': {f: pack.bbox(pos1[f]) for f in stills if f <= args.stage1_end},
                  'sim': dict(cloth_settings_dict(args), openFraction=round(frac_open, 4),
                              visibleFraction=round(frac_visible, 4))}
        os.makedirs(os.path.join(ROOT, 'out'), exist_ok=True)
        pack.write_atomic(os.path.join(ROOT, 'out', f'stage1-{args.bucket}.json'),
                          (json.dumps(report, indent=1, sort_keys=True) + '\n').encode('utf8'))
        return

    # Pass 2: the same scene rebuilt from scratch (keyframes on a collider must exist before the
    # first frame_set, or the cloth cache is invalidated mid-run) plus the crusher, full length.
    scene, obj, rest = build_stage1(args, aspect, folds)
    add_crusher(scene, centre, args.r0_scale * r_stack, args)
    add_cloth(obj, args)
    if stills:
        setup_render(scene, args)

    def on_frame_2(f):
        if f in stills:
            render_still(scene, os.path.join(still_dir, f'{args.bucket}-f{f:02d}.png'))

    pos = simulate(obj, scene, args.frames, on_frame_2)
    print(f'frame 0 is the rest grid to {check_rest_frame(pos[0], rest):.2e}')
    # The crusher is huge and the pull is zero until stage1_end - 1, so pass 2 must reproduce pass 1
    # up to there. A drift means the setup is not deterministic -- stop and find out why. (This is
    # also why the "stills below stage1End belong to --stage 1" guard above is safe to reject rather
    # than render: those frames are provably identical between the two passes.)
    check = args.stage1_end - 1
    drift = max(math.dist(a, b) for a, b in zip(pos[check], pos1[check]))
    if drift > 1e-4:
        raise RuntimeError(f'pass 2 diverged from pass 1 by {drift:.6f} at frame {check}')
    print(f'pass 2 reproduces pass 1 at frame {check} to {drift:.2e}')
    _, r_ball = bounding_sphere(pos[args.frames - 1])
    print(f'ball radius {r_ball:.3f} = {r_ball / r_stack:.2f} x stack (target {args.ball})')
    if r_ball > 0.6 * r_stack:
        print('WARNING: the ball did not close -- flaps escaped or the pull is too weak; see the tuning table')
    export_pack(args, aspect, pos, centre, r_stack,
                {'openFraction': round(frac_open, 4), 'visibleFraction': round(frac_visible, 4),
                 'ballRadius': round(r_ball, 5)})


main()
