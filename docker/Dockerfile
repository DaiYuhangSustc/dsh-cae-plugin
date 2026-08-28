# dsh-cae stage runtime: everything the Python stages need, nothing else.
# Build from the repo root:  docker build -f docker/Dockerfile -t dsh-cae-e2e:dev .
# Base is Canonical's official ECR publish of Ubuntu (docker.io is unreachable
# on some networks; no '# syntax=' pin for the same reason — buildx's bundled
# frontend supports RUN --mount).

FROM public.ecr.aws/ubuntu/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget xz-utils bzip2 git gpg software-properties-common \
      libxft2 libxrender1 libxext6 libxi6 libxinerama1 libxrandr2 libxcursor1 \
      libxfixes3 libgl1 libglu1-mesa libfontconfig1 libdbus-1-3 libxkbcommon0 \
    && rm -rf /var/lib/apt/lists/*

# OpenFOAM Foundation 13 (official openfoam.org apt repo) -> /opt/openfoam13,
# where the python-side bashrc auto-detection already looks. Repo URL stays
# http: the .deb fetch redirects to a sourceforge http mirror, and apt refuses
# the https→http downgrade; integrity is covered by the gpg-signed repo.
RUN wget -qO- https://dl.openfoam.org/gpg.key | gpg --dearmor > /etc/apt/trusted.gpg.d/openfoam.gpg \
    && add-apt-repository -y "http://dl.openfoam.org/ubuntu" \
    && apt-get update && apt-get install -y --no-install-recommends openfoam13 \
    && rm -rf /var/lib/apt/lists/*

# micromamba env mirroring the local-conda route (same env name: dsh-cae).
# Package-route notes (verified against conda-forge repodata 2026-08):
#  - conda provides only python, ccx (package "calculix"), and pytest. Everything
#    Python-level comes from pip, because conda-forge build123d drags in the
#    qt build of vtk (X-only window classes — no EGL/OSMesa, headless rendering
#    impossible), and a conda-installed vtk can't even be upgraded by pip (no
#    uninstall metadata). pip build123d depends on cadquery-ocp-novtk, which
#    brings no vtk at all.
#  - no conda "osmesa" or "ccx2paraview" packages exist (osmesa was removed
#    upstream; ccx2paraview ships on PyPI) — ccx2paraview comes via pip.
#  - conda "gmsh" is the C binary only, no Python module; the gmsh API wheel
#    (which bundles its own libgmsh) is installed via pip instead.
#  - vtk is pinned to 9.6.2: the pip wheel bundles vtkEGLRenderWindow (see
#    VTK_DEFAULT_OPENGL_WINDOW below) — the headless route this image needs.
ENV MAMBA_ROOT_PREFIX=/opt/mamba
# MAMBA_DOWNLOAD_SPEED_LIMIT=0 (disable micromamba's download throttle) is
# scoped to this RUN so it never leaks into the runtime environment.
RUN MAMBA_DOWNLOAD_SPEED_LIMIT=0 \
    curl -Ls --retry 5 --retry-delay 5 -o /tmp/micromamba.tar.bz2 \
      https://micro.mamba.pm/api/micromamba/linux-64/latest \
    && tar -xjf /tmp/micromamba.tar.bz2 -C /usr/local/bin --strip-components=1 bin/micromamba \
    && rm /tmp/micromamba.tar.bz2 \
    && micromamba create -y -n dsh-cae -c conda-forge \
         python=3.11 calculix pytest \
    && micromamba run -n dsh-cae pip install --no-cache-dir \
         build123d gmsh ccx2paraview pyvista 'vtk==9.6.2' \
    && micromamba clean -y --all

# LD_LIBRARY_PATH mirrors what `conda activate` would set: this image runs the
# env's python bare (PATH only), and without it the loader resolves the older
# system libexpat first — python 3.11.16's pyexpat then dies on a missing
# symbol inside build123d's import chain.
ENV PATH=/opt/mamba/envs/dsh-cae/bin:$PATH \
    LD_LIBRARY_PATH=/opt/mamba/envs/dsh-cae/lib \
    PYVISTA_OFF_SCREEN=true \
    VTK_DEFAULT_OPENGL_WINDOW=vtkEGLRenderWindow

# EGL runtime for vtk's headless render window (dlopen'd by vtkEGLRenderWindow;
# without it VTK silently falls back to X and dies on display-less hosts).
RUN apt-get update && apt-get install -y --no-install-recommends libegl1 \
    && rm -rf /var/lib/apt/lists/*

# Build-time gate: the full pytest suite must pass inside this image.
# bind mounts keep the validation copy out of the final layers (the image never
# ships dsh_cae — the runner mounts the plugin's python/ at run time).
RUN --mount=type=bind,source=python,target=/tmp/validate/python \
    --mount=type=bind,source=pytest,target=/tmp/validate/pytest \
    cd /tmp/validate && PYTHONPATH=/tmp/validate/python pytest pytest -q
