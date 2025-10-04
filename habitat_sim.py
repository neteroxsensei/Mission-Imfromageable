import math
import random
from typing import Dict, Any, Tuple, List, Optional, Callable

# --- Panda3D config (force software renderer, headless safe) ---
from panda3d.core import loadPrcFileData
loadPrcFileData("", "load-display p3tinydisplay")  # use software renderer
loadPrcFileData("", "window-type offscreen")
loadPrcFileData("", "audio-library-name null")
loadPrcFileData("", "framebuffer-multisample 0")
loadPrcFileData("", "multisamples 0")

from direct.showbase.ShowBase import ShowBase
from panda3d.core import (DirectionalLight, AmbientLight, NodePath, Vec4,
                          LineSegs, PNMImage, Filename, TransparencyAttrib,
                          GeomVertexRewriter)

# --- Defaults / Schema ---
DEFAULT_LAYOUT: Dict[str, Any] = {
    "shape": {"type": "cylinder", "radius": 3.0, "length": 12.0},
    "modules": [
        {"id": "sleep-1", "kind": "sleep", "shape": "capsule",
         "pos": [1.0, -2.0, 0.5], "size": [1.0, 1.0, 2.0], "hpr": [0, 0, 0], "color": [0.20, 0.80, 0.30]},
        {"id": "storage-1", "kind": "storage", "shape": "box",
         "pos": [-1.0, 1.5, 0.5], "size": [1.2, 1.2, 1.2], "hpr": [15, 0, 0], "color": [0.90, 0.60, 0.20]},
        {"id": "comms-1", "kind": "comms", "shape": "sphere",
         "pos": [0, 0, 1], "size": [1, 1, 1.2], "hpr": [0, 0, 0], "color": [0.25, 0.55, 0.95]}
    ]
}

# Kind defaults
KIND_POWER_KW = {
    "sleep": 0.1,
    "storage": 0.05,
    "galley": 0.5,
    "medbay": 0.8,
    "exercise": 0.3,
    "life_support": 1.2,
    "power": 0.0,
    "comms": 0.4,
    "waste": 0.3,
}
KIND_CREW_CAP = {
    "sleep": 1,
    "medbay": 0,
    "galley": 0,
    "exercise": 0,
    "storage": 0,
    "life_support": 0,
    "power": 0,
    "comms": 0,
    "waste": 0,
}

def validate_layout(layout: Dict[str, Any]) -> Tuple[bool, str]:
    if not isinstance(layout, dict):
        return False, "layout must be an object"
    if "shape" not in layout or "modules" not in layout:
        return False, "layout requires 'shape' and 'modules'"

    shape = layout["shape"]
    if not isinstance(shape, dict):
        return False, "shape must be an object"

    shape_type = str(shape.get("type", "cylinder")).lower()

    try:
        if shape_type == "sphere":
            radius = float(shape.get("radius", 0))
            if radius <= 0:
                return False, "sphere.radius must be > 0"
        elif shape_type == "cube":
            width = float(shape.get("width", 0))
            depth = float(shape.get("depth", 0))
            height = float(shape.get("height", 0))
            if min(width, depth, height) <= 0:
                return False, "cube dimensions must be > 0"
        else:  # cylinder fallback
            radius = float(shape.get("radius", 0))
            length = float(shape.get("length", 0))
            if radius <= 0 or length <= 0:
                return False, "cylinder requires positive radius and length"
    except (TypeError, ValueError):
        return False, "shape dimensions must be numeric"

    mods = layout["modules"]
    if not isinstance(mods, list):
        return False, "'modules' must be a list"
    for m in mods:
        for key in ("id", "kind", "pos", "size"):
            if key not in m:
                return False, f"module missing '{key}'"
    return True, ""

def _shape_dimensions(layout_shape: Dict[str, Any]) -> Tuple[float, float, float, float]:
    """Return (volume, width, depth, height) based on shape descriptor."""
    shape_type = str(layout_shape.get("type", "cylinder")).lower()

    if shape_type == "sphere":
        r = float(layout_shape.get("radius", 0))
        vol = (4.0 / 3.0) * math.pi * (r ** 3)
        diameter = 2.0 * r
        return vol, diameter, diameter, diameter
    if shape_type == "cube":
        w = float(layout_shape.get("width", 0))
        d = float(layout_shape.get("depth", 0))
        h = float(layout_shape.get("height", 0))
        vol = w * d * h
        return vol, w, d, h

    # default cylinder
    r = float(layout_shape.get("radius", 0))
    L = float(layout_shape.get("length", 0))
    vol = math.pi * r * r * L
    diameter = 2.0 * r
    return vol, diameter, L, diameter


TOLERANCE = 1e-5


def _half_extents(size: List[float]) -> Tuple[float, float, float]:
    """Return the half-extent along each axis for a module scale list."""
    return tuple(abs(float(v)) * 0.5 for v in size)


def _round_triplet(values: List[float], digits: int = 3) -> List[float]:
    return [round(float(v), digits) for v in values]


def _clamp(value: float, min_value: float, max_value: float) -> float:
    if not math.isfinite(value):
        return 0.0
    if min_value > max_value:
        return 0.5 * (min_value + max_value)
    return max(min_value, min(max_value, value))


def _clamp_point_in_circle(x: float, z: float, hx: float, hz: float, radius: float) -> Tuple[float, float]:
    if radius <= 0.0:
        return 0.0, 0.0

    def corner_radius(cx: float, cz: float) -> float:
        return math.hypot(abs(cx) + hx, abs(cz) + hz)

    if corner_radius(x, z) <= radius + TOLERANCE:
        return x, z

    if corner_radius(0.0, 0.0) > radius + TOLERANCE:
        return 0.0, 0.0

    low, high = 0.0, 1.0
    for _ in range(40):
        mid = 0.5 * (low + high)
        cx, cz = x * mid, z * mid
        if corner_radius(cx, cz) <= radius + TOLERANCE:
            low = mid
        else:
            high = mid
    return x * low, z * low


def _clamp_point_in_sphere(x: float, y: float, z: float,
                           hx: float, hy: float, hz: float,
                           radius: float) -> Tuple[float, float, float]:
    if radius <= 0.0:
        return 0.0, 0.0, 0.0

    def corner_radius(cx: float, cy: float, cz: float) -> float:
        return math.sqrt((abs(cx) + hx) ** 2 + (abs(cy) + hy) ** 2 + (abs(cz) + hz) ** 2)

    if corner_radius(x, y, z) <= radius + TOLERANCE:
        return x, y, z

    if corner_radius(0.0, 0.0, 0.0) > radius + TOLERANCE:
        return 0.0, 0.0, 0.0

    low, high = 0.0, 1.0
    for _ in range(50):
        mid = 0.5 * (low + high)
        cx, cy, cz = x * mid, y * mid, z * mid
        if corner_radius(cx, cy, cz) <= radius + TOLERANCE:
            low = mid
        else:
            high = mid
    scale = low
    return x * scale, y * scale, z * scale


def enforce_module_bounds(layout: Dict[str, Any]) -> Dict[str, Any]:
    """Clamp module size and position so they stay inside the habitat shape."""

    shape = layout.get("shape", {})
    modules = layout.get("modules", [])
    shape_type = str(shape.get("type", "cylinder")).lower()

    for module in modules:
        size = [abs(float(v)) for v in module.get("size", (0.0, 0.0, 0.0))]
        pos = [float(v) for v in module.get("pos", (0.0, 0.0, 0.0))]

        if shape_type == "sphere":
            radius = max(0.0, float(shape.get("radius", 0.0)))
            if radius <= 0.0:
                module["size"] = [0.0, 0.0, 0.0]
                module["pos"] = [0.0, 0.0, 0.0]
                continue

            hx, hy, hz = _half_extents(size)
            base_corner = math.sqrt(hx * hx + hy * hy + hz * hz)
            if base_corner > radius and base_corner > 0.0:
                shrink = radius / base_corner
                size = [v * shrink for v in size]
                hx, hy, hz = _half_extents(size)

            x, y, z = _clamp_point_in_sphere(pos[0], pos[1], pos[2], hx, hy, hz, radius)
            module["size"] = size
            module["pos"] = [x, y, z]
            continue

        if shape_type == "cube":
            half_width = max(0.0, float(shape.get("width", 0.0)) * 0.5)
            half_depth = max(0.0, float(shape.get("depth", 0.0)) * 0.5)
            half_height = max(0.0, float(shape.get("height", 0.0)) * 0.5)

            size[0] = min(size[0], max(0.0, half_width * 2.0))
            size[1] = min(size[1], max(0.0, half_depth * 2.0))
            size[2] = min(size[2], max(0.0, half_height * 2.0))

            hx, hy, hz = _half_extents(size)

            max_x = max(0.0, half_width - hx)
            max_y = max(0.0, half_depth - hy)
            max_z = max(0.0, half_height - hz)

            x = _clamp(pos[0], -max_x, max_x)
            y = _clamp(pos[1], -max_y, max_y)
            z = _clamp(pos[2], -max_z, max_z)

            module["size"] = size
            module["pos"] = [x, y, z]
            continue

        # default to cylinder behaviour
        radius = max(0.0, float(shape.get("radius", 0.0)))
        length = max(0.0, float(shape.get("length", 0.0)))
        half_length = 0.5 * length

        size[1] = min(size[1], length) if length > 0.0 else 0.0
        hy = size[1] * 0.5

        if length > 0.0:
            max_y = max(0.0, half_length - hy)
            y = _clamp(pos[1], -max_y, max_y)
        else:
            y = 0.0

        hx = abs(size[0]) * 0.5
        hz = abs(size[2]) * 0.5

        if radius > 0.0:
            module_radius = math.hypot(hx, hz)
            if module_radius > radius and module_radius > 0.0:
                shrink = radius / module_radius
                size[0] *= shrink
                size[2] *= shrink
                hx *= shrink
                hz *= shrink

            x, z = _clamp_point_in_circle(pos[0], pos[2], hx, hz, radius)
        else:
            x, z = 0.0, 0.0
            size[0] = 0.0
            size[2] = 0.0

        module["size"] = size
        module["pos"] = [x, y, z]

    return layout


def _assess_module_fit(layout_shape: Dict[str, Any], module: Dict[str, Any]) -> Dict[str, Any]:
    """Return a fit report entry if a module exceeds the habitat boundary."""

    shape_type = str(layout_shape.get("type", "cylinder")).lower()
    sx, sy, sz = [float(v) for v in module.get("size", (0.0, 0.0, 0.0))]
    x, y, z = [float(v) for v in module.get("pos", (0.0, 0.0, 0.0))]
    hx, hy, hz = _half_extents([sx, sy, sz])

    notes: List[str] = []
    needs_resize = False
    needs_reposition = False
    scale_x = 1.0
    scale_y = 1.0
    scale_z = 1.0

    if shape_type == "sphere":
        radius = float(layout_shape.get("radius", 0.0))
        if radius <= 0:
            return {}

        center_dist = math.sqrt(x * x + y * y + z * z)
        if center_dist - radius > TOLERANCE:
            needs_reposition = True
            notes.append("module center is outside the sphere radius")

        a = hx * hx + hy * hy + hz * hz
        if a > 0.0:
            b = 2.0 * (abs(x) * hx + abs(y) * hy + abs(z) * hz)
            c = x * x + y * y + z * z - radius * radius
            f1 = a + b + c
            if f1 > TOLERANCE:
                disc = b * b - 4.0 * a * c
                if disc > 0:
                    allowed_scale = (-b + math.sqrt(disc)) / (2.0 * a)
                    allowed_scale = max(0.0, min(1.0, allowed_scale))
                else:
                    allowed_scale = 0.0
                if allowed_scale < 1.0 - TOLERANCE:
                    needs_resize = True
                    scale_x = scale_y = scale_z = allowed_scale
                    overreach = math.sqrt((abs(x) + hx) ** 2 + (abs(y) + hy) ** 2 + (abs(z) + hz) ** 2) - radius
                    notes.append(f"total extent exceeds sphere by {round(overreach, 3)} m")
        else:
            if center_dist - radius > TOLERANCE:
                needs_resize = True
                scale_x = scale_y = scale_z = 0.0
                notes.append("point-sized module lies outside sphere; shrink or reposition")

    elif shape_type == "cube":
        half_width = float(layout_shape.get("width", 0.0)) * 0.5
        half_depth = float(layout_shape.get("depth", 0.0)) * 0.5
        half_height = float(layout_shape.get("height", 0.0)) * 0.5
        if min(half_width, half_depth, half_height) <= 0.0:
            return {}

        if abs(x) > half_width + TOLERANCE or abs(y) > half_depth + TOLERANCE or abs(z) > half_height + TOLERANCE:
            needs_reposition = True
            notes.append("module center lies outside cube bounds")

        def clamp_axis(coord_abs: float, half_extent: float, module_half: float, axis_name: str) -> float:
            allowable = max(0.0, half_extent - coord_abs)
            if module_half - allowable > TOLERANCE and module_half > 0.0:
                over = module_half - allowable
                notes.append(f"{axis_name}-axis extent exceeds cube by {round(over * 2.0, 3)} m")
                return max(0.0, min(1.0, allowable / module_half))
            return 1.0

        scale_x = clamp_axis(abs(x), half_width, hx, "x")
        scale_y = clamp_axis(abs(y), half_depth, hy, "y")
        scale_z = clamp_axis(abs(z), half_height, hz, "z")
        if scale_x < 1.0 - TOLERANCE or scale_y < 1.0 - TOLERANCE or scale_z < 1.0 - TOLERANCE:
            needs_resize = True

    else:  # default cylinder
        radius = float(layout_shape.get("radius", 0.0))
        length = float(layout_shape.get("length", 0.0))
        half_length = 0.5 * length
        if radius <= 0.0 or half_length <= 0.0:
            return {}

        radial_center = math.hypot(x, z)
        if radial_center - radius > TOLERANCE or abs(y) - half_length > TOLERANCE:
            needs_reposition = True
            notes.append("module center lies outside cylinder envelope")

        allowable_hy = max(0.0, half_length - abs(y))
        if hy - allowable_hy > TOLERANCE and hy > 0.0:
            scale_y = max(0.0, min(1.0, allowable_hy / hy))
            needs_resize = True
            notes.append(f"longitudinal extent exceeds cylinder by {round((hy - allowable_hy) * 2.0, 3)} m")

        a = hx * hx + hz * hz
        if a > 0.0:
            b = 2.0 * (abs(x) * hx + abs(z) * hz)
            c = x * x + z * z - radius * radius
            f1 = a + b + c
            if f1 > TOLERANCE:
                disc = b * b - 4.0 * a * c
                if disc > 0:
                    allowed_scale = (-b + math.sqrt(disc)) / (2.0 * a)
                    allowed_scale = max(0.0, min(1.0, allowed_scale))
                else:
                    allowed_scale = 0.0
                if allowed_scale < 1.0 - TOLERANCE:
                    scale_x = scale_z = allowed_scale
                    needs_resize = True
                    over = math.hypot(abs(x) + hx, abs(z) + hz) - radius
                    notes.append(f"planar footprint exceeds cylinder radius by {round(over, 3)} m")
        else:
            if math.hypot(x, z) - radius > TOLERANCE:
                needs_resize = True
                scale_x = scale_z = 0.0
                notes.append("point-sized module lies outside cylinder footprint")

    if not (needs_resize or needs_reposition):
        return {}

    suggested_size = [sx * scale_x, sy * scale_y, sz * scale_z]
    report: Dict[str, Any] = {
        "id": module.get("id", ""),
        "kind": module.get("kind", ""),
        "needs_resize": needs_resize,
        "needs_reposition": needs_reposition,
        "current_size": _round_triplet([sx, sy, sz]),
        "notes": notes,
    }
    if needs_resize:
        report["suggested_size"] = _round_triplet(suggested_size)
        report["scale_factors"] = {
            "x": round(scale_x, 3),
            "y": round(scale_y, 3),
            "z": round(scale_z, 3),
        }
        report["scale_factors_exact"] = {
            "x": scale_x,
            "y": scale_y,
            "z": scale_z,
        }
    return report


def assess_module_fit(layout: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Compute a list of modules that require resizing or repositioning."""

    issues: List[Dict[str, Any]] = []
    shape = layout.get("shape", {})
    for module in layout.get("modules", []):
        report = _assess_module_fit(shape, module)
        if report:
            issues.append(report)
    return issues


def compute_metrics(layout: Dict[str, Any]) -> Dict[str, float]:
    vol_hab, width, depth, height = _shape_dimensions(layout["shape"])

    total_module_vol = 0.0
    crew = 0
    power = 0.0
    for m in layout["modules"]:
        sx, sy, sz = [float(v) for v in m["size"]]
        total_module_vol += abs(sx * sy * sz)
        crew += KIND_CREW_CAP.get(m.get("kind", ""), 0)
        power += KIND_POWER_KW.get(m.get("kind", ""), 0.2)

    used_ratio = min(1.0, total_module_vol / max(1e-6, vol_hab))

    fit_issues = assess_module_fit(layout)
    metrics = {
        "habitat_volume_m3": round(vol_hab, 3),
        "module_volume_m3": round(total_module_vol, 3),
        "space_usage_ratio": round(used_ratio, 3),
        "crew_capacity": crew,
        "power_usage_kW": round(power, 3),
        "footprint_m": {
            "width": round(width, 3),
            "depth": round(depth, 3),
            "height": round(height, 3),
        },
    }

    metrics["module_fit"] = {
        "ok": len(fit_issues) == 0,
        "issue_count": len(fit_issues),
        "issues": fit_issues,
    }

    return metrics

# --- Renderer ---
class HabitatRenderer(ShowBase):
    def __init__(self):
        ShowBase.__init__(self)
        self.scene = self.render.attachNewNode("scene")
        self._asset_cache: Dict[str, NodePath] = {}

        # Lighting
        dlight = DirectionalLight("dlight")
        dlight.set_color(Vec4(0.9, 0.9, 0.85, 1))
        dlnp = self.render.attachNewNode(dlight)
        dlnp.set_hpr(-45, -45, 0)
        self.render.set_light(dlnp)

        alight = AmbientLight("alight")
        alight.set_color(Vec4(0.25, 0.25, 0.28, 1))
        self.render.set_light(self.render.attachNewNode(alight))

        # Camera
        self.cam.set_pos(10, -18, 9)
        self.cam.look_at(0, 0, 0)

    def build_scene(self, layout: Dict[str, Any], render_style: str = "realistic") -> None:
        # Clear
        for child in self.scene.get_children():
            child.remove_node()

        ok, err = validate_layout(layout)
        if not ok:
            raise ValueError(f"Invalid layout: {err}")

        shape = layout["shape"]
        shape_type = str(shape.get("type", "cylinder")).lower()

        if shape_type == "sphere":
            radius = float(shape.get("radius"))
            shell = self._make_sphere_wire(radius, segments=48)
            half_x = half_y = half_z = radius
        elif shape_type == "cube":
            width = float(shape.get("width"))
            depth = float(shape.get("depth"))
            height = float(shape.get("height"))
            shell = self._make_box_wire(width, depth, height)
            half_x = width * 0.5
            half_y = depth * 0.5
            half_z = height * 0.5
        else:  # default to cylinder
            radius = float(shape.get("radius"))
            length = float(shape.get("length"))
            shell = self._make_cylinder_wire(radius=radius, length=length, segments=48)
            half_x = radius
            half_y = length * 0.5
            half_z = radius

        shell.reparent_to(self.scene)
        shell.set_color(Vec4(0.6, 0.75, 0.95, 0.85))
        shell.set_transparency(TransparencyAttrib.M_alpha)

        grid = self._make_coordinate_grid(half_x, half_y)
        grid.reparent_to(self.scene)

        axes = self._make_axes(half_x, half_y, half_z)
        axes.reparent_to(self.scene)

        style_key = str(render_style or "realistic").lower()

        # Modules
        for m in layout["modules"]:
            self._add_module(m, style_key)

    def render_snapshot(self, filename: str) -> None:
        self.graphicsEngine.render_frame()
        img = PNMImage()
        if not self.win.getScreenshot(img):
            raise RuntimeError("Failed to capture screenshot")
        img.write(Filename.from_os_specific(filename))

    # --- Helpers ---
    def _make_cylinder_wire(self, radius: float, length: float, segments: int = 48) -> NodePath:
        ls = LineSegs()
        ls.set_thickness(2.0)
        hL = 0.5 * length

        for y in (-hL, +hL):
            ls.move_to(radius, y, 0.0)
            for i in range(1, segments + 1):
                a = (i / segments) * 2.0 * math.pi
                x = radius * math.cos(a)
                z = radius * math.sin(a)
                ls.draw_to(x, y, z)

        step = max(6, segments // 8)
        for i in range(0, segments, step):
            a = (i / segments) * 2.0 * math.pi
            x = radius * math.cos(a)
            z = radius * math.sin(a)
            ls.move_to(x, -hL, z)
            ls.draw_to(x, +hL, z)

        node = ls.create()
        return NodePath(node)

    def _make_coordinate_grid(self, half_x: float, half_y: float, spacing: float = 1.0) -> NodePath:
        ls = LineSegs()
        ls.set_thickness(1.0)
        ls.set_color(0.8, 0.85, 0.9, 0.6)

        if half_x <= 0 or half_y <= 0:
            return NodePath(ls.create())

        spacing = max(spacing, min(half_x, half_y) / 6.0, 0.25)

        y = -half_y
        while y <= half_y + 1e-6:
            ls.move_to(-half_x, y, 0.0)
            ls.draw_to(half_x, y, 0.0)
            y += spacing

        x = -half_x
        while x <= half_x + 1e-6:
            ls.move_to(x, -half_y, 0.0)
            ls.draw_to(x, half_y, 0.0)
            x += spacing

        return NodePath(ls.create())

    def _make_axes(self, half_x: float, half_y: float, half_z: float) -> NodePath:
        ls = LineSegs()
        ls.set_thickness(3.0)

        # X axis (red)
        extent_x = max(half_x, 1.0)
        ls.set_color(1.0, 0.2, 0.2, 1.0)
        ls.move_to(-extent_x, 0.0, 0.0)
        ls.draw_to(extent_x, 0.0, 0.0)

        # Y axis (green)
        extent_y = max(half_y, 1.0)
        ls.set_color(0.2, 0.8, 0.2, 1.0)
        ls.move_to(0.0, -extent_y, 0.0)
        ls.draw_to(0.0, extent_y, 0.0)

        # Z axis (blue)
        extent_z = max(half_z, 1.0)
        ls.set_color(0.2, 0.4, 1.0, 1.0)
        ls.move_to(0.0, 0.0, 0.0)
        ls.draw_to(0.0, 0.0, extent_z)

        return NodePath(ls.create())

    def _make_sphere_wire(self, radius: float, segments: int = 48) -> NodePath:
        ls = LineSegs()
        ls.set_thickness(2.0)

        def draw_circle(axis: str) -> None:
            if axis == "xy":
                ls.move_to(radius, 0.0, 0.0)
                for i in range(1, segments + 1):
                    a = (i / segments) * 2.0 * math.pi
                    x = radius * math.cos(a)
                    y = radius * math.sin(a)
                    ls.draw_to(x, y, 0.0)
            elif axis == "xz":
                ls.move_to(radius, 0.0, 0.0)
                for i in range(1, segments + 1):
                    a = (i / segments) * 2.0 * math.pi
                    x = radius * math.cos(a)
                    z = radius * math.sin(a)
                    ls.draw_to(x, 0.0, z)
            else:  # yz
                ls.move_to(0.0, radius, 0.0)
                for i in range(1, segments + 1):
                    a = (i / segments) * 2.0 * math.pi
                    y = radius * math.cos(a)
                    z = radius * math.sin(a)
                    ls.draw_to(0.0, y, z)

        for plane in ("xy", "xz", "yz"):
            draw_circle(plane)

        return NodePath(ls.create())

    def _make_box_wire(self, width: float, depth: float, height: float) -> NodePath:
        ls = LineSegs()
        ls.set_thickness(2.0)
        hx, hy, hz = width * 0.5, depth * 0.5, height * 0.5

        corners = {
            "lbf": (-hx, -hy, -hz),
            "lbt": (-hx, -hy, hz),
            "ltf": (-hx, hy, -hz),
            "ltt": (-hx, hy, hz),
            "rbf": (hx, -hy, -hz),
            "rbt": (hx, -hy, hz),
            "rtf": (hx, hy, -hz),
            "rtt": (hx, hy, hz),
        }

        edges = [
            ("lbf", "rbf"), ("rbf", "rtf"), ("rtf", "ltf"), ("ltf", "lbf"),
            ("lbt", "rbt"), ("rbt", "rtt"), ("rtt", "ltt"), ("ltt", "lbt"),
            ("lbf", "lbt"), ("rbf", "rbt"), ("rtf", "rtt"), ("ltf", "ltt"),
        ]

        for start, end in edges:
            ls.move_to(*corners[start])
            ls.draw_to(*corners[end])

        return NodePath(ls.create())

    def _asset_builders(self) -> Dict[str, Callable[[], NodePath]]:
        return {
            "crew_bed": self._asset_crew_bed,
            "bed": self._asset_crew_bed,
            "sleep_pod": self._asset_crew_bed,
            "treadmill": self._asset_treadmill,
            "exercise_treadmill": self._asset_treadmill,
            "workbench": self._asset_workbench,
            "lab_bench": self._asset_workbench,
        }

    def _get_asset_template(self, asset_name: str) -> Optional[NodePath]:
        key = str(asset_name).strip().lower()
        if not key:
            return None

        cached = self._asset_cache.get(key)
        if cached is not None:
            return cached

        builder = self._asset_builders().get(key)
        node: Optional[NodePath] = None
        if builder is not None:
            node = builder()
        else:
            try:
                node = self.loader.loadModel(asset_name)
            except Exception:
                node = None

        if node is None:
            return None

        node.flatten_strong()
        node.detach_node()
        self._asset_cache[key] = node
        return node

    def _asset_crew_bed(self) -> NodePath:
        root = NodePath("crew_bed_asset")

        frame = self.loader.loadModel("models/box")
        frame.reparent_to(root)
        frame.set_scale(0.94, 0.98, 0.14)
        frame.set_pos(0.0, 0.0, -0.43)
        frame.set_color(0.36, 0.26, 0.18, 1.0)

        mattress = self.loader.loadModel("models/box")
        mattress.reparent_to(root)
        mattress.set_scale(0.9, 0.94, 0.18)
        mattress.set_pos(0.0, 0.0, -0.22)
        mattress.set_color(0.82, 0.85, 0.92, 1.0)

        pillow = self.loader.loadModel("models/smiley")
        pillow.reparent_to(root)
        pillow.set_scale(0.22)
        pillow.set_pos(0.0, 0.42, -0.08)
        pillow.set_color(0.95, 0.95, 0.98, 1.0)

        headboard = self.loader.loadModel("models/box")
        headboard.reparent_to(root)
        headboard.set_scale(0.92, 0.08, 0.42)
        headboard.set_pos(0.0, 0.46, -0.08)
        headboard.set_color(0.28, 0.3, 0.34, 1.0)

        storage = self.loader.loadModel("models/box")
        storage.reparent_to(root)
        storage.set_scale(0.88, 0.18, 0.2)
        storage.set_pos(0.0, -0.42, -0.33)
        storage.set_color(0.32, 0.25, 0.18, 1.0)

        root.flatten_strong()
        return root

    def _asset_treadmill(self) -> NodePath:
        root = NodePath("treadmill_asset")

        base = self.loader.loadModel("models/box")
        base.reparent_to(root)
        base.set_scale(0.85, 0.5, 0.12)
        base.set_pos(0.0, 0.0, -0.42)
        base.set_color(0.2, 0.21, 0.24, 1.0)

        deck = self.loader.loadModel("models/box")
        deck.reparent_to(root)
        deck.set_scale(0.8, 0.46, 0.05)
        deck.set_pos(0.0, 0.0, -0.36)
        deck.set_color(0.12, 0.12, 0.14, 1.0)

        for roller_y in (-0.36, 0.36):
            roller = self.loader.loadModel("models/smiley")
            roller.reparent_to(root)
            roller.set_scale(0.08)
            roller.set_pos(0.0, roller_y, -0.36)
            roller.set_color(0.26, 0.28, 0.3, 1.0)

        handle = self.loader.loadModel("models/box")
        handle.reparent_to(root)
        handle.set_scale(0.36, 0.05, 0.05)
        handle.set_pos(0.0, 0.22, 0.16)
        handle.set_color(0.32, 0.34, 0.38, 1.0)

        for side in (-0.3, 0.3):
            upright = self.loader.loadModel("models/box")
            upright.reparent_to(root)
            upright.set_scale(0.05, 0.05, 0.5)
            upright.set_pos(side, 0.18, -0.08)
            upright.set_color(0.3, 0.32, 0.36, 1.0)

        console = self.loader.loadModel("models/box")
        console.reparent_to(root)
        console.set_scale(0.28, 0.08, 0.18)
        console.set_pos(0.0, 0.3, 0.18)
        console.set_color(0.18, 0.2, 0.28, 1.0)

        panel = self.loader.loadModel("models/box")
        panel.reparent_to(root)
        panel.set_scale(0.22, 0.04, 0.12)
        panel.set_pos(0.0, 0.32, 0.3)
        panel.set_color(0.14, 0.55, 0.74, 1.0)

        root.flatten_strong()
        return root

    def _asset_workbench(self) -> NodePath:
        root = NodePath("workbench_asset")

        surface = self.loader.loadModel("models/box")
        surface.reparent_to(root)
        surface.set_scale(0.94, 0.6, 0.08)
        surface.set_pos(0.0, 0.0, -0.12)
        surface.set_color(0.64, 0.54, 0.32, 1.0)

        shelf = self.loader.loadModel("models/box")
        shelf.reparent_to(root)
        shelf.set_scale(0.9, 0.52, 0.05)
        shelf.set_pos(0.0, -0.2, -0.36)
        shelf.set_color(0.25, 0.27, 0.3, 1.0)

        for dx in (-0.38, 0.38):
            for dy in (-0.28, 0.28):
                leg = self.loader.loadModel("models/box")
                leg.reparent_to(root)
                leg.set_scale(0.07, 0.07, 0.44)
                leg.set_pos(dx, dy, -0.36)
                leg.set_color(0.22, 0.24, 0.28, 1.0)

        backwall = self.loader.loadModel("models/box")
        backwall.reparent_to(root)
        backwall.set_scale(0.9, 0.08, 0.48)
        backwall.set_pos(0.0, 0.34, -0.02)
        backwall.set_color(0.2, 0.24, 0.3, 1.0)

        tools = self.loader.loadModel("models/smiley")
        tools.reparent_to(root)
        tools.set_scale(0.12)
        tools.set_pos(0.0, 0.34, 0.14)
        tools.set_color(0.92, 0.75, 0.32, 1.0)

        root.flatten_strong()
        return root

    def _add_module(self, m: Dict[str, Any], render_style: str = "realistic") -> None:
        shape = m.get("shape", "box")
        sx, sy, sz = [float(v) for v in m["size"]]
        x, y, z = [float(v) for v in m["pos"]]
        h, p, r = [float(v) for v in m.get("hpr", [0, 0, 0])]
        col = m.get("color", [0.7, 0.7, 0.7])

        model: Optional[NodePath] = None
        is_asset = False
        asset_name = m.get("asset")
        if asset_name:
            template = self._get_asset_template(asset_name)
            if template is not None:
                model = template.copy_to(self.scene)
                is_asset = True

        if model is None:
            if shape == "sphere":
                model = self.loader.loadModel("models/smiley")
            elif shape == "cylinder":
                model = self.loader.loadModel("models/box")
            elif shape == "capsule":
                model = NodePath("capsule")
                cyl = self.loader.loadModel("models/box")
                cyl.set_scale(0.5, 0.5, 1.0)
                cyl.reparent_to(model)

                top = self.loader.loadModel("models/smiley")
                top.set_scale(0.5)
                top.set_pos(0, 0, 1.0)
                top.reparent_to(model)

                bottom = self.loader.loadModel("models/smiley")
                bottom.set_scale(0.5)
                bottom.set_pos(0, 0, -1.0)
                bottom.reparent_to(model)
            else:
                model = self.loader.loadModel("models/box")

            model.reparent_to(self.scene)

        model.set_scale(sx, sy, sz)
        model.set_pos(x, y, z)
        model.set_hpr(h, p, r)
        base_color = Vec4(col[0], col[1], col[2], 1.0)
        if is_asset:
            model.set_color_scale(base_color)
        else:
            model.set_color(col[0], col[1], col[2], 1.0)

        self._apply_render_style(model, render_style, m, is_asset, base_color)

    def _apply_render_style(self, node: NodePath, render_style: str,
                             module: Dict[str, Any], is_asset: bool,
                             base_color: Vec4) -> None:
        style = str(render_style or "realistic").lower()
        if style != "clay":
            if is_asset:
                node.set_color_scale(base_color)
            else:
                node.clear_color_scale()
            return

        seed_source = f"{module.get('id', '')}|{module.get('kind', '')}"
        rng = random.Random(seed_source)

        # Non-uniform scale wobble (~±4%)
        jitter = [1.0 + (rng.random() - 0.5) * 0.08 for _ in range(3)]
        node.set_scale(node.get_sx() * jitter[0], node.get_sy() * jitter[1], node.get_sz() * jitter[2])

        # Soft brightness tint
        tint = 0.92 + rng.random() * 0.14
        if is_asset:
            node.set_color_scale(base_color[0] * tint, base_color[1] * tint, base_color[2] * tint, base_color[3])
        else:
            node.set_color_scale(tint, tint, tint, 1.0)

        self._apply_vertex_warp(node, rng)

    def _apply_vertex_warp(self, node: NodePath, rng: random.Random) -> None:
        freq_base = 0.35 + rng.random() * 0.35
        amp = 0.04 + rng.random() * 0.03
        phase_x = rng.random() * math.tau
        phase_y = rng.random() * math.tau
        phase_z = rng.random() * math.tau

        for geom_np in node.find_all_matches('**/+GeomNode'):
            geom_node = geom_np.node()
            for geom_index in range(geom_node.get_num_geoms()):
                geom = geom_node.modifyGeom(geom_index)
                vdata = geom.modifyVertexData()
                vertex = GeomVertexRewriter(vdata, 'vertex')
                try:
                    normal = GeomVertexRewriter(vdata, 'normal')
                except RuntimeError:
                    normal = None

                while not vertex.is_at_end():
                    x, y, z = vertex.get_data3f()
                    wave = (
                        math.sin((x * freq_base) + phase_x) +
                        math.sin((y * (freq_base * 1.17)) + phase_y) +
                        math.sin((z * (freq_base * 0.83)) + phase_z)
                    ) / 3.0
                    offset = wave * amp
                    if normal:
                        nx, ny, nz = normal.get_data3f()
                        vertex.set_data3f(x + nx * offset, y + ny * offset, z + nz * offset)
                        normal.set_data3f(nx, ny, nz)
                    else:
                        vertex.set_data3f(x + offset * 0.6, y + offset * 0.6, z + offset * 0.6)
