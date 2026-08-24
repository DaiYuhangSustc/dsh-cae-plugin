import pytest

pytest.importorskip("pyvista")


def _synthetic_vtu(path):
    import pyvista as pv
    # pyvista >= 0.46 refuses .save('.vtu') on ImageData (no matching XML
    # writer); the synthetic fixture is point-data-only, so cast to an
    # unstructured grid first.
    grid = pv.ImageData(dimensions=(11, 3, 3), spacing=(10, 10, 10), origin=(0, 0, 0)).cast_to_unstructured_grid()
    import numpy as np
    disp = np.zeros((grid.n_points, 3))
    disp[:, 2] = np.linspace(0, 0.5, grid.n_points)  # growing z deflection
    grid.point_data["displacement"] = disp
    grid.point_data["stressXX"] = np.linspace(0, 100, grid.n_points)
    grid.save(path)


def test_post_extracts_max_and_probe(stage, workdir, parse_receipt):
    vtu = workdir / "syn.vtu"
    _synthetic_vtu(vtu)
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn",
                 "--max", "displacement", "--max", "stressXX",
                 "--probe", "displacement,0,0,0")
    receipt = parse_receipt(proc)
    maxima = {v["field"]: v["value"] for v in receipt["values"] if v["kind"] == "max"}
    probes = {v["field"]: v["value"] for v in receipt["values"] if v["kind"] == "probe"}
    assert abs(maxima["displacement"] - 0.5) < 1e-9
    assert abs(maxima["stressXX"] - 100.0) < 1e-9
    units = {v["field"]: v["unit"] for v in receipt["values"] if v["kind"] == "max"}
    assert units["displacement"] == "mm"
    assert abs(probes["displacement"] - 0.0) < 1e-9  # synthetic field grows from 0 at origin
    probe_entries = [v for v in receipt["values"] if v["kind"] == "probe"]
    assert all("atMm" in v for v in probe_entries)


def _synthetic_cfd_vtk(path):
    import numpy as np
    import pyvista as pv
    grid = pv.ImageData(dimensions=(41, 5, 5), spacing=(0.025, 0.005, 0.005),
                        origin=(0, 0, 0)).cast_to_unstructured_grid()
    u = np.zeros((grid.n_points, 3))
    u[:, 0] = 0.02
    grid.point_data["U"] = u
    grid.point_data["p"] = np.linspace(2.8e-3, 0.0, grid.n_points)  # kinematic m²/s²
    grid.save(path)


def test_post_reads_cfd_velocity_and_pressure_with_density(stage, workdir, parse_receipt):
    vtk = workdir / "duct.vtk"
    _synthetic_cfd_vtk(vtk)
    proc = stage(workdir, "post", "--vtu", str(vtk), "--png-stem", "duct",
                 "--density-kg-m3", "1000",
                 "--max", "velocity", "--max", "pressure",
                 "--probe", "pressure,0.9,0.01,0.01", "--probe", "velocity,0.5,0.01,0.01",
                 "--plot", "pressure")
    receipt = parse_receipt(proc)
    maxima = {v["field"]: v for v in receipt["values"] if v["kind"] == "max"}
    assert maxima["velocity"]["value"] == pytest.approx(0.02)
    assert maxima["velocity"]["unit"] == "m/s"
    assert maxima["velocity"]["atM"] == [0.0, 0.0, 0.0]  # uniform field: argmax is point 0
    assert "atMm" not in maxima["velocity"]
    assert maxima["pressure"]["unit"] == "Pa"
    # kinematic p × 1000 → Pa; max sits at x=0 where p=2.8e-3
    assert maxima["pressure"]["value"] == pytest.approx(2.8)
    probed = [v for v in receipt["values"] if v["kind"] == "probe" and v["field"] == "pressure"][0]
    assert probed["atM"][0] == pytest.approx(0.9, abs=0.026)
    # the plot loop scales pressure by the same density as the extractions
    plot = [p for p in receipt["plots"] if p["field"] == "pressure"][0]
    assert plot["path"] is not None and plot["path"].endswith("duct.pressure.png")


def test_post_pressure_without_density_is_kinematic(stage, workdir, parse_receipt):
    vtk = workdir / "duct.vtk"
    _synthetic_cfd_vtk(vtk)
    proc = stage(workdir, "post", "--vtu", str(vtk), "--png-stem", "duct",
                 "--max", "pressure")
    receipt = parse_receipt(proc)
    assert receipt["values"][0]["value"] == pytest.approx(2.8e-3)
    assert receipt["values"][0]["unit"] == "Pa"


def test_post_unknown_and_missing_fields_list_available(stage, workdir):
    vtu = workdir / "syn.vtu"
    _synthetic_vtu(vtu)
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn", "--max", "banana")
    assert proc.returncode == 1
    assert "unknown field 'banana'" in proc.stderr
    assert "available point data" in proc.stderr
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn", "--max", "velocity")
    assert proc.returncode == 1
    assert "field 'velocity' not found" in proc.stderr
    assert "available point data" in proc.stderr


def test_post_structural_locations_stay_atMm(stage, workdir, parse_receipt):
    vtu = workdir / "syn.vtu"
    _synthetic_vtu(vtu)
    proc = stage(workdir, "post", "--vtu", str(vtu), "--png-stem", "syn", "--max", "stressXX")
    receipt = parse_receipt(proc)
    assert receipt["values"][0]["atMm"] is not None
    assert "atM" not in receipt["values"][0]
