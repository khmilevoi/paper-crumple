"""Headless smoke test for the bake toolchain. Raises on any failure.

Two parts:

1. API smoke checks -- one per Blender 5.2 API the later bake tasks rely on (force fields,
   collision modifiers, bmesh primitives, BVH ray casts, Workbench display settings, quaternion
   tracking, UV layers). Each prints "SMOKE ok: <name>" and raises loudly if the API renamed or
   misbehaved -- --python-exit-code 1 turns that into a non-zero exit.
2. The cloth pipeline itself: builds a 6x6 cloth sheet, pins two corners, drives one corner with
   a Hook on an animated Empty, releases the pins at frame 4 through a VertexWeightMix keyed on
   mask_constant, steps to frame 16, reads the evaluated mesh back, renders one still. Writes
   out/smoke.json and out/smoke.png.

   The window runs to frame 16, not the release frame + a couple of steps: measured on this
   machine, a released pinned corner keeps rising under residual spring tension until ~frame 7
   before gravity takes over (elastic snap-back), so a short window after release reads as "still
   pinned" even though the pin weight already dropped to 0. Confirmed by reading the evaluated
   'pin' vertex group weight directly, not just inferred from geometry.
"""
import json
import os
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

# Scratch output lives in tools/bake/out/, kept untracked by tools/bake/.gitignore.
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(OUT, exist_ok=True)


# --- API smoke checks -------------------------------------------------------------------------
# Each check resets to a fresh empty scene so it can't be affected by, or leak into, the others
# or the cloth pipeline below.

def smoke_force_field():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.object.effector_add(type='FORCE')
    obj = bpy.context.object
    obj.field.strength = 5.0
    if obj.field.strength != 5.0:
        raise RuntimeError(f'force field strength did not stick: {obj.field.strength}')
    print('SMOKE ok: force_field')


def smoke_collision_modifier():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_plane_add()
    obj = bpy.context.object
    obj.modifiers.new('col', 'COLLISION')
    obj.collision.thickness_outer = 0.02
    if abs(obj.collision.thickness_outer - 0.02) > 1e-6:
        raise RuntimeError(f'collision thickness_outer did not stick: {obj.collision.thickness_outer}')
    print('SMOKE ok: collision_modifier')


def smoke_bmesh_uvsphere_reverse():
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=8, radius=1.0)
    if len(bm.verts) < 3:
        raise RuntimeError('create_uvsphere produced no verts')
    print('SMOKE ok: create_uvsphere')
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    print('SMOKE ok: reverse_faces')
    bm.free()


def smoke_bmesh_grid_bvh():
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=4, y_segments=4, size=1.0)
    if len(bm.verts) < 4:
        raise RuntimeError('create_grid produced no verts')
    print('SMOKE ok: create_grid')
    verts = [tuple(v.co) for v in bm.verts]
    polys = [[v.index for v in f.verts] for f in bm.faces]
    bm.free()
    bvh = BVHTree.FromPolygons(verts, polys, all_triangles=False)
    hit = bvh.ray_cast((0.0, 0.0, 5.0), (0.0, 0.0, -1.0))
    if hit is None or hit[0] is None:
        raise RuntimeError(f'bvhtree ray_cast missed the grid: {hit}')
    print('SMOKE ok: bvhtree_raycast')


def smoke_display_shading():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    shading = bpy.context.scene.display.shading
    shading.light = 'STUDIO'
    shading.color_type = 'SINGLE'
    shading.single_color = (0.8, 0.8, 0.8)
    shading.show_cavity = True
    shading.cavity_type = 'BOTH'
    shading.show_shadows = True
    shading.show_backface_culling = True
    print('SMOKE ok: display_shading')


def smoke_to_track_quat():
    quat = Vector((0.0, 0.0, 1.0)).to_track_quat('Z', 'Y')
    if quat is None:
        raise RuntimeError('to_track_quat returned None')
    print('SMOKE ok: to_track_quat')


def smoke_uv_layers():
    mesh = bpy.data.meshes.new('smoke_uv')
    mesh.from_pydata([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [], [(0, 1, 2, 3)])
    mesh.update()
    uv = mesh.uv_layers.new()
    if uv is None:
        raise RuntimeError('uv_layers.new() returned None')
    print('SMOKE ok: uv_layers_new')


def run_api_smoke_checks():
    smoke_force_field()
    smoke_collision_modifier()
    smoke_bmesh_uvsphere_reverse()
    smoke_bmesh_grid_bvh()
    smoke_display_shading()
    smoke_to_track_quat()
    smoke_uv_layers()


# --- cloth pipeline ----------------------------------------------------------------------------

def evaluated_positions(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    pos = [tuple(v.co) for v in me.vertices]
    ev.to_mesh_clear()
    return pos


def main():
    major = bpy.app.version[0]
    if major < 5:
        raise RuntimeError(f'expected Blender 5.x, got {bpy.app.version_string}')
    print('blender', bpy.app.version_string, 'python', sys.version.split()[0])

    run_api_smoke_checks()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 0, 16
    scene.render.fps = 24
    scene.gravity = (0.0, 0.0, -9.81)

    n = 6
    s = n + 1
    verts = [(x / n - 0.5, y / n - 0.5, 0.0) for y in range(s) for x in range(s)]
    faces = [(y * s + x, y * s + x + 1, (y + 1) * s + x + 1, (y + 1) * s + x) for y in range(n) for x in range(n)]
    mesh = bpy.data.meshes.new('sheet')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('sheet', mesh)
    scene.collection.objects.link(obj)

    corner_a, corner_b, free = 0, n, s * s - 1
    obj.vertex_groups.new(name='hooked').add([corner_b], 1.0, 'REPLACE')
    obj.vertex_groups.new(name='pin').add([corner_a, corner_b], 1.0, 'REPLACE')

    # Hook: the empty sits on the corner, rises 0.2 over frames 0..3. A pinned cloth vertex
    # follows the pre-cloth stack, so the corner must end up at z = 0.2.
    empty = bpy.data.objects.new('hinge', None)
    empty.location = Vector(verts[corner_b])
    scene.collection.objects.link(empty)
    bpy.context.view_layer.update()
    hook = obj.modifiers.new('hook', 'HOOK')
    hook.object = empty
    hook.vertex_group = 'hooked'
    hook.matrix_inverse = empty.matrix_world.inverted()
    empty.keyframe_insert('location', frame=0)
    empty.location.z = 0.2
    empty.keyframe_insert('location', frame=3)

    # Release: SET the pin group to weight 0, faded in by mask_constant 0 -> 1 at frame 4.
    release = obj.modifiers.new('release', 'VERTEX_WEIGHT_MIX')
    release.vertex_group_a = 'pin'
    release.mix_mode = 'SET'
    release.mix_set = 'ALL'
    release.default_weight_b = 0.0
    release.mask_constant = 0.0
    obj.keyframe_insert('modifiers["release"].mask_constant', frame=3)
    release.mask_constant = 1.0
    obj.keyframe_insert('modifiers["release"].mask_constant', frame=4)

    cloth = obj.modifiers.new('cloth', 'CLOTH')
    cloth.settings.vertex_group_mass = 'pin'
    cloth.settings.quality = 5
    cloth.collision_settings.use_self_collision = True
    cloth.point_cache.frame_start, cloth.point_cache.frame_end = 0, 16

    z_free, z_hooked = [], []
    for f in range(0, 17):
        scene.frame_set(f)
        pos = evaluated_positions(obj)
        z_free.append(pos[free][2])
        z_hooked.append(pos[corner_b][2])
    print('free corner z', [round(z, 4) for z in z_free])
    print('hooked corner z', [round(z, 4) for z in z_hooked])
    if not z_free[3] < -0.01:
        raise RuntimeError(f'cloth did not simulate: free corner z {z_free}')
    if not abs(z_hooked[3] - 0.2) < 0.02:
        raise RuntimeError(f'hooked pin did not follow its empty: {z_hooked}')
    if not z_hooked[16] < z_hooked[3] - 0.01:
        raise RuntimeError(f'pin was not released at frame 4: {z_hooked}')

    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.ortho_scale = 1.6
    cam_obj = bpy.data.objects.new('cam', cam)
    cam_obj.location = (0.0, 0.0, 3.0)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj
    scene.render.resolution_x = scene.render.resolution_y = 256
    png_path = os.path.join(OUT, 'smoke.png')
    png_tmp = os.path.join(OUT, 'smoke.tmp.png')  # already ends in .png: Blender won't rename it
    scene.render.filepath = png_tmp
    render = 'workbench'
    try:
        scene.render.engine = 'BLENDER_WORKBENCH'
        bpy.ops.render.render(write_still=True)
    except Exception as error:  # no GPU context in this session: Cycles on the CPU still works
        print('workbench failed, falling back to cycles:', error)
        render = 'cycles'
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'
        scene.cycles.samples = 8
        bpy.ops.render.render(write_still=True)
    if os.path.getsize(png_tmp) < 1000:
        raise RuntimeError('render wrote an empty PNG')
    os.replace(png_tmp, png_path)

    json_path = os.path.join(OUT, 'smoke.json')
    json_tmp = os.path.join(OUT, 'smoke.json.tmp')
    with open(json_tmp, 'w', encoding='utf8') as fh:
        json.dump({'blender': bpy.app.version_string, 'python': sys.version.split()[0], 'render': render,
                   'zFree': z_free, 'zHooked': z_hooked}, fh, indent=1)
    os.replace(json_tmp, json_path)
    print('smoke ok')


main()
