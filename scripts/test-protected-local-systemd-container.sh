#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${FASED_CONTAINER_RUNTIME:-podman}"
OCI_RUNTIME="${FASED_CONTAINER_OCI_RUNTIME:-}"
DISTROS="${FASED_SYSTEMD_FIXTURE_DISTROS:-ubuntu,rocky}"
SCENARIOS="${FASED_SYSTEMD_FIXTURE_SCENARIOS:-fresh-install,managed-update}"
FIXTURE_DIR="$ROOT_DIR/scripts/docker/protected-local-systemd"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT_DIR/package.json")"
COMMIT="${FASED_SYSTEMD_FIXTURE_COMMIT:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || {
  echo "The protected Local fixture requires an exact 40-character commit." >&2
  exit 1
}
TREE="$(git -C "$ROOT_DIR" rev-parse "${COMMIT}^{tree}")"
LOCKFILE_DIGEST="sha256:$(git -C "$ROOT_DIR" show "${COMMIT}:pnpm-lock.yaml" | sha256sum | awk '{print $1}')"
CACHE_HOME="${XDG_CACHE_HOME:-${HOME:-${TMPDIR:-/tmp}}/.cache}"
ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_ARTIFACT_DIR:-}"
OWN_ARTIFACT_DIR=0
ARTIFACT_CACHE_DIR="${FASED_SYSTEMD_FIXTURE_ARTIFACT_CACHE_DIR-$CACHE_HOME/fased/protected-local-artifacts}"
ARTIFACT_CACHE_TARGET=""
ARTIFACT_CACHE_LOCK_FD=""
IMAGE_CACHE_DIR="${FASED_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR:-}"
PREINSTALLED_TOOLS="${FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS:-0}"
PUBLIC_ACQUISITION="${FASED_SYSTEMD_FIXTURE_PUBLIC_ACQUISITION:-0}"
BUILD_ONLY="${FASED_SYSTEMD_FIXTURE_BUILD_ONLY:-0}"
ARTIFACT_OUTPUT_DIR="${FASED_SYSTEMD_FIXTURE_OUTPUT_DIR:-}"
ARTIFACT_PROFILE="${FASED_SYSTEMD_FIXTURE_ARTIFACT_PROFILE:-branch-x64}"
RECEIPT_DIR="${FASED_SYSTEMD_FIXTURE_RECEIPT_DIR:-}"
OWN_RECEIPT_DIR=0
MANAGED_PREDECESSOR_VERSION="${FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION:-}"
MANAGED_PREDECESSOR_ARTIFACT_DIR="${FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_ARTIFACT_DIR:-}"
MANAGED_PREDECESSOR_CACHE_DIR="${FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_CACHE_DIR-$CACHE_HOME/fased/predecessor-artifacts}"
OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR=0
PARALLEL_SCENARIOS="${FASED_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS:-1}"
SOURCE_REPO_DIR=""
OWN_SOURCE_REPO_DIR=0
SOURCE_REPO_MOUNT_OPTIONS="ro,z"

if [[ -z "$ARTIFACT_DIR" && "$BUILD_ONLY" == "0" && -n "$ARTIFACT_CACHE_DIR" ]]; then
  [[ "$ARTIFACT_CACHE_DIR" == /* ]] || {
    echo "FASED_SYSTEMD_FIXTURE_ARTIFACT_CACHE_DIR must be absolute or empty." >&2
    exit 1
  }
  command -v flock >/dev/null 2>&1 || {
    echo "flock is required for the shared branch artifact cache." >&2
    exit 1
  }
  artifact_cache_key="${COMMIT}-${TREE}-${LOCKFILE_DIGEST#sha256:}"
  mkdir -p "$ARTIFACT_CACHE_DIR/branch-x64"
  ARTIFACT_CACHE_TARGET="$ARTIFACT_CACHE_DIR/branch-x64/$artifact_cache_key"
  exec {ARTIFACT_CACHE_LOCK_FD}>"$ARTIFACT_CACHE_DIR/branch-x64/.${artifact_cache_key}.lock"
  flock "$ARTIFACT_CACHE_LOCK_FD"
  if [[ -e "$ARTIFACT_CACHE_TARGET" ]]; then
    [[ -d "$ARTIFACT_CACHE_TARGET" &&
      -f "$ARTIFACT_CACHE_TARGET/fased-hosting-candidate.json" ]] || {
      echo "The branch artifact cache contains an incomplete entry: $ARTIFACT_CACHE_TARGET" >&2
      exit 1
    }
    ARTIFACT_DIR="$ARTIFACT_CACHE_TARGET"
    ARTIFACT_CACHE_TARGET=""
    flock -u "$ARTIFACT_CACHE_LOCK_FD"
    exec {ARTIFACT_CACHE_LOCK_FD}>&-
    ARTIFACT_CACHE_LOCK_FD=""
    echo "branch artifact cache hit: commit=$COMMIT tree=$TREE lock=$LOCKFILE_DIGEST"
  fi
fi

cleanup_before_fixture() {
  if [[ "$OWN_ARTIFACT_DIR" -eq 1 && -n "$ARTIFACT_DIR" ]]; then
    rm -rf -- "$ARTIFACT_DIR"
  fi
  if [[ "$OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR" -eq 1 &&
    -n "$MANAGED_PREDECESSOR_ARTIFACT_DIR" ]]; then
    rm -rf -- "$MANAGED_PREDECESSOR_ARTIFACT_DIR"
  fi
  if [[ -n "$ARTIFACT_CACHE_LOCK_FD" ]]; then
    flock -u "$ARTIFACT_CACHE_LOCK_FD" >/dev/null 2>&1 || true
  fi
}
trap cleanup_before_fixture EXIT INT TERM HUP

if [[ -n "$ARTIFACT_DIR" ]]; then
  descriptor="$ARTIFACT_DIR/fased-hosting-candidate.json"
  identity="$ARTIFACT_DIR/fased-lifecycled-release.json"
  [[ -f "$descriptor" && ! -L "$descriptor" && -f "$identity" && ! -L "$identity" ]] || {
    echo "The candidate descriptor and lifecycle identity are required." >&2
    exit 1
  }
  VERSION="$(jq -er .version "$identity")"
  COMMIT="$(jq -er .commit "$identity")"
  TREE="$(jq -er .tree "$identity")"
  LOCKFILE_DIGEST="sha256:$(git -C "$ROOT_DIR" show "${COMMIT}:pnpm-lock.yaml" | sha256sum | awk '{print $1}')"
  [[ "$VERSION" == "$(jq -er .version "$descriptor")" &&
    "$COMMIT" == "$(jq -er .commit "$descriptor")" &&
    "$TREE" == "$(jq -er .tree "$descriptor")" &&
    "$LOCKFILE_DIGEST" == "$(jq -er .lockfileDigest "$descriptor")" ]] || {
    echo "The candidate descriptor and lifecycle identity disagree." >&2
    exit 1
  }
  while IFS=$'\t' read -r name expected_size expected_digest; do
    candidate="$ARTIFACT_DIR/$name"
    [[ -f "$candidate" && ! -L "$candidate" ]] || {
      echo "Candidate artifact is missing or unsafe: $name" >&2
      exit 1
    }
    [[ "$(stat -c %s "$candidate")" == "$expected_size" ]] || {
      echo "Candidate artifact size mismatch: $name" >&2
      exit 1
    }
    [[ "sha256:$(sha256sum "$candidate" | awk '{print $1}')" == "$expected_digest" ]] || {
      echo "Candidate artifact digest mismatch: $name" >&2
      exit 1
    }
  done < <(jq -er '.artifacts[] | [.name, (.size|tostring), .sha256] | @tsv' "$descriptor")
  PUBLIC_ACQUISITION=1
fi

[[ "$BUILD_ONLY" == "0" || "$BUILD_ONLY" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_BUILD_ONLY must be 0 or 1." >&2
  exit 1
}
if [[ "$BUILD_ONLY" == "1" ]]; then
  [[ -z "$ARTIFACT_DIR" && "$ARTIFACT_OUTPUT_DIR" == /* ]] || {
    echo "Build-only mode requires one absolute FASED_SYSTEMD_FIXTURE_OUTPUT_DIR." >&2
    exit 1
  }
  mkdir -p "$ARTIFACT_OUTPUT_DIR"
  [[ -d "$ARTIFACT_OUTPUT_DIR" && -z "$(find "$ARTIFACT_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]] || {
    echo "The protected Local fixture output directory must be empty." >&2
    exit 1
  }
else
  command -v "$RUNTIME" >/dev/null 2>&1 || {
    echo "Podman is required for the protected Local systemd fixtures." >&2
    exit 1
  }
  [[ "$RUNTIME" == "podman" ]] || {
    echo "The protected Local systemd fixtures currently require Podman." >&2
    exit 1
  }
  if [[ -z "$OCI_RUNTIME" ]] && command -v runc >/dev/null 2>&1; then
    OCI_RUNTIME="$(command -v runc)"
  fi
fi
run_container() {
  if [[ -n "$OCI_RUNTIME" ]]; then
    "$RUNTIME" --runtime "$OCI_RUNTIME" "$@"
    return
  fi
  "$RUNTIME" "$@"
}
[[ "$PREINSTALLED_TOOLS" == "0" || "$PREINSTALLED_TOOLS" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS must be 0 or 1." >&2
  exit 1
}
[[ "$PARALLEL_SCENARIOS" == "0" || "$PARALLEL_SCENARIOS" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS must be 0 or 1." >&2
  exit 1
}
[[ "$PUBLIC_ACQUISITION" == "0" || "$PUBLIC_ACQUISITION" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_PUBLIC_ACQUISITION must be 0 or 1." >&2
  exit 1
}
[[ "$ARTIFACT_PROFILE" == "branch-x64" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_ARTIFACT_PROFILE must be branch-x64." >&2
  echo "Full-platform candidate artifacts belong to the trusted release workflow." >&2
  exit 1
}

copy_branch_x64_fixture_aliases() {
  local release_dir="$ROOT_DIR/dist-native/release"
  local signer_source="$release_dir/fased-signerd-linux-amd64"
  local lifecycle_source="$release_dir/fased-lifecycled-linux-amd64"
  local alias

  [[ -f "$signer_source" && ! -L "$signer_source" &&
    -f "$lifecycle_source" && ! -L "$lifecycle_source" ]] || {
    echo "The branch-x64 fixture requires exact Linux amd64 lifecycle binaries." >&2
    exit 1
  }
  for alias in \
    fased-signerd-linux-arm64 \
    fased-signerd-darwin-amd64 \
    fased-signerd-darwin-arm64; do
    rm -f -- "$release_dir/$alias"
    cp --reflink=auto "$signer_source" "$release_dir/$alias"
  done
  rm -f -- "$release_dir/fased-lifecycled-linux-arm64"
  cp --reflink=auto "$lifecycle_source" "$release_dir/fased-lifecycled-linux-arm64"
  echo "branch-x64 artifacts are fixture-only and cannot be published"
}

clear_branch_fixture_native_outputs() {
  local release_dir="$ROOT_DIR/dist-native/release"
  local stale_asset

  mkdir -p "$release_dir"
  while IFS= read -r -d '' stale_asset; do
    rm -f -- "$stale_asset"
  done < <(
    find "$release_dir" -maxdepth 1 \( -type f -o -type l \) \
      \( -name 'fased-signerd-*' -o -name 'fased-lifecycled-*' \) -print0
  )
}

if [[ -z "$ARTIFACT_DIR" ]]; then
  PUBLIC_ACQUISITION=1
  [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$COMMIT" &&
    -z "$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=normal)" ]] || {
    echo "The branch artifact builder requires one exact clean product commit." >&2
    echo "Fixture-only changes must reuse its cached artifact instead of rebuilding." >&2
    exit 1
  }
  [[ -x "$ROOT_DIR/node_modules/.bin/tsdown" &&
    -x "$ROOT_DIR/ui/node_modules/.bin/vite" ]] || {
    echo "The protected Local fixture requires a complete frozen development install." >&2
    echo "Run pnpm install --frozen-lockfile from the repository root, then retry." >&2
    exit 1
  }
  if [[ ! -f "$ROOT_DIR/dist/build-info.json" ]] ||
    [[ "$(jq -r .version "$ROOT_DIR/dist/build-info.json")" != "$VERSION" ]] ||
    [[ "$(jq -r .commit "$ROOT_DIR/dist/build-info.json")" != "$COMMIT" ]]; then
    pnpm --dir "$ROOT_DIR" build
  fi
  [[ "$(jq -r .version "$ROOT_DIR/dist/build-info.json")" == "$VERSION" &&
    "$(jq -r .commit "$ROOT_DIR/dist/build-info.json")" == "$COMMIT" ]] || {
    echo "The protected Local fixture refuses stale dist identity." >&2
    exit 1
  }
  fixture_go_tmp="${GOTMPDIR:-${TMPDIR:-/tmp}/fased-go-tmp}"
  fixture_go_cache="${GOCACHE:-${TMPDIR:-/tmp}/fased-go-cache}"
  mkdir -p "$fixture_go_tmp" "$fixture_go_cache"
  clear_branch_fixture_native_outputs
  GOTMPDIR="$fixture_go_tmp" \
  GOCACHE="$fixture_go_cache" \
  FASED_SIGNER_BUILD_COMMIT="$COMMIT" \
  FASED_SIGNER_TARGETS="linux/amd64" \
    bash "$ROOT_DIR/scripts/release-fased-signerd.sh"
  GOTMPDIR="$fixture_go_tmp" \
  GOCACHE="$fixture_go_cache" \
  FASED_LIFECYCLE_BUILD_COMMIT="$COMMIT" \
  FASED_LIFECYCLE_BUILD_TREE="$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
  FASED_LIFECYCLE_TARGETS="linux/amd64" \
    bash "$ROOT_DIR/scripts/release-fased-lifecycled.sh"
  copy_branch_x64_fixture_aliases
  if [[ "$BUILD_ONLY" == "1" ]]; then
    ARTIFACT_DIR="$ARTIFACT_OUTPUT_DIR"
  elif [[ -n "$ARTIFACT_CACHE_TARGET" ]]; then
    ARTIFACT_DIR="$(mktemp -d "$ARTIFACT_CACHE_DIR/branch-x64/.${artifact_cache_key}.building.XXXXXX")"
    OWN_ARTIFACT_DIR=1
  else
    ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-artifact.XXXXXX")"
    OWN_ARTIFACT_DIR=1
  fi
  pnpm --dir "$ROOT_DIR" hosted:artifact:from-dist --output "$ARTIFACT_DIR"
  cp -a "$ROOT_DIR/dist-native/release/." "$ARTIFACT_DIR/"
  x64_identity="$ARTIFACT_DIR/fased-hosted-app-linux-x64-v${VERSION}.tar.gz.release.json"
  arm64_app="fased-hosted-app-v2-linux-arm64-v${VERSION}.tar.gz"
  x64_app="$(jq -er .app.asset "$x64_identity")"
  x64_dependency="$(jq -er .dependencies.asset "$x64_identity")"
  dependency_hash="$(jq -er .dependencyHash "$x64_identity")"
  arm64_dependency="fased-hosted-deps-linux-arm64-${dependency_hash}.tar.gz"
  cp --reflink=auto "$ARTIFACT_DIR/$x64_app" "$ARTIFACT_DIR/$arm64_app"
  cp --reflink=auto "$ARTIFACT_DIR/$x64_dependency" "$ARTIFACT_DIR/$arm64_dependency"
  cp --reflink=auto \
    "$ARTIFACT_DIR/fased-hosted-components-linux-x64-v${VERSION}.spdx.json" \
    "$ARTIFACT_DIR/fased-hosted-components-linux-arm64-v${VERSION}.spdx.json"
  jq \
    --arg architecture arm64 \
    --arg app "$arm64_app" \
    --arg app_sha "$(sha256sum "$ARTIFACT_DIR/$arm64_app" | awk '{print $1}')" \
    --arg dependencies "$arm64_dependency" \
    --arg dependencies_sha "$(sha256sum "$ARTIFACT_DIR/$arm64_dependency" | awk '{print $1}')" \
    '.architecture = $architecture |
     .app.asset = $app |
     .app.sha256 = $app_sha |
     .dependencies.asset = $dependencies |
     .dependencies.sha256 = $dependencies_sha' \
    "$x64_identity" \
    >"$ARTIFACT_DIR/fased-hosted-app-linux-arm64-v${VERSION}.tar.gz.release.json"
  node "$ROOT_DIR/scripts/build-hosted-release-manifest.mjs" \
    --assets "$ARTIFACT_DIR" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --output "$ARTIFACT_DIR/fased-hosted-release-v2.json"
  node "$ROOT_DIR/scripts/assemble-lifecycle-generation.mjs" \
    --runtime-archive "$ARTIFACT_DIR/$x64_app" \
    --dependency-archive "$ARTIFACT_DIR/$x64_dependency" \
    --release-manifest "$ARTIFACT_DIR/fased-hosted-release-v2.json" \
    --signer "$ARTIFACT_DIR/fased-signerd-linux-amd64" \
    --lifecycled "$ARTIFACT_DIR/fased-lifecycled-linux-amd64" \
    --output-dir "$ARTIFACT_DIR" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --tree "$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
    --architecture x64
  if [[ "$PUBLIC_ACQUISITION" == "1" ]]; then
    node "$ROOT_DIR/scripts/stamp-release-installer.mjs" \
      --source "$ROOT_DIR/install.sh" \
      --output "$ARTIFACT_DIR/install.sh" \
      --version "$VERSION"
    install -m 0755 \
      "$ROOT_DIR/scripts/privileged-release-evidence.mjs" \
      "$ARTIFACT_DIR/fased-privileged-release-evidence.mjs"
    issued_at="$(node -e '
      process.stdout.write(new Date(process.argv[1]).toISOString());
    ' "$(git -C "$ROOT_DIR" show -s --format=%cI "$COMMIT")")"
    expires_at="$(node -e '
      const issued = new Date(process.argv[1]);
      process.stdout.write(new Date(issued.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString());
    ' "$issued_at")"
    node "$ROOT_DIR/scripts/privileged-release-evidence.mjs" build \
      --assets "$ARTIFACT_DIR" \
      --version "$VERSION" \
      --commit "$COMMIT" \
      --issued-at "$issued_at" \
      --vex-decisions "$ROOT_DIR/release/vulnerability-decisions-v1.json" \
      --output-dir "$ARTIFACT_DIR"
    node "$ROOT_DIR/scripts/build-lifecycle-trust-metadata.mjs" \
      --assets "$ARTIFACT_DIR" \
      --root-policy "$ROOT_DIR/release/lifecycle-trust/root-v1/fased-lifecycle-root-v1.json" \
      --version "$VERSION" \
      --commit "$COMMIT" \
      --issued-at "$issued_at" \
      --expires-at "$expires_at" \
      --output "$ARTIFACT_DIR/fased-lifecycle-trust-v1.json"
    for attested_asset in \
      fased-hosted-release-v2.json \
      fased-lifecycle-trust-v1.json \
      fased-privileged-provenance-v1.intoto.json \
      fased-signerd-release \
      install.sh; do
      printf '{"fixtureOfflineAttestation":true}\n' \
        >"$ARTIFACT_DIR/${attested_asset}.attestation.json"
    done
  fi
  printf '{"schemaVersion":1,"profile":"branch-x64","publishable":false}\n' \
    >"$ARTIFACT_DIR/fased-branch-proof-x64.json"
  install -m 0644 \
    "$ROOT_DIR/config/lifecycle-acceptance.v1.json" \
    "$ARTIFACT_DIR/fased-lifecycle-acceptance-v1.json"
  node "$ROOT_DIR/scripts/lifecycle-release-compatibility.mjs" build \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --tree "$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
    --output "$ARTIFACT_DIR/fased-lifecycle-release-compatibility-v1.json"
  node "$ROOT_DIR/scripts/release-artifact-set.mjs" build \
    --directory "$ARTIFACT_DIR" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --tree "$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
    --lockfile-digest "sha256:$(sha256sum "$ROOT_DIR/pnpm-lock.yaml" | awk '{print $1}')" \
    --source-ref "refs/tags/v${VERSION}" \
    --workflow-run-id 1 \
    --workflow-run-attempt 1
  printf '{"fixtureOfflineAttestation":true}\n' \
    >"$ARTIFACT_DIR/fased-hosting-candidate.json.attestation.json"
  if [[ -n "$ARTIFACT_CACHE_TARGET" ]]; then
    [[ ! -e "$ARTIFACT_CACHE_TARGET" ]] || {
      echo "The branch artifact cache target appeared during the locked build." >&2
      exit 1
    }
    mv "$ARTIFACT_DIR" "$ARTIFACT_CACHE_TARGET"
    ARTIFACT_DIR="$ARTIFACT_CACHE_TARGET"
    ARTIFACT_CACHE_TARGET=""
    OWN_ARTIFACT_DIR=0
    flock -u "$ARTIFACT_CACHE_LOCK_FD"
    exec {ARTIFACT_CACHE_LOCK_FD}>&-
    ARTIFACT_CACHE_LOCK_FD=""
    echo "branch artifact cache stored: commit=$COMMIT tree=$TREE lock=$LOCKFILE_DIGEST"
  fi
fi
if [[ "$BUILD_ONLY" == "1" ]]; then
  for required_asset in \
    fased-hosted-release-v2.json \
    fased-lifecycle-acceptance-v1.json \
    fased-lifecycle-release-compatibility-v1.json \
    fased-hosting-candidate.json \
    fased-hosting-candidate.json.attestation.json \
    "fased-generation-linux-x64-v${VERSION}.tar.gz"; do
    [[ -s "$ARTIFACT_DIR/$required_asset" ]] || {
      echo "The protected Local fixture artifact is missing $required_asset." >&2
      exit 1
    }
  done
  printf '%s\n' "$ARTIFACT_DIR"
  exit 0
fi
[[ -f "$ARTIFACT_DIR/fased-hosted-linux-x64-v${VERSION}.tar.gz" ]] || {
  echo "The protected Local fixture requires the exact x64 packaged runtime artifact." >&2
  exit 1
}
[[ -f "$ARTIFACT_DIR/fased-signerd-linux-amd64" &&
  -f "$ARTIFACT_DIR/fased-signerd-release.json" ]] || {
  echo "The protected Local fixture requires the exact signer artifact and identity." >&2
  exit 1
}
if [[ "$PUBLIC_ACQUISITION" == "1" ]]; then
  for required_asset in \
    install.sh \
    fased-hosted-release-v2.json \
    fased-hosted-release-v2.json.attestation.json \
    fased-lifecycle-acceptance-v1.json \
    fased-lifecycle-release-compatibility-v1.json \
    fased-lifecycle-trust-v1.json \
    fased-lifecycle-trust-v1.json.attestation.json \
    fased-privileged-provenance-v1.intoto.json \
    fased-privileged-provenance-v1.intoto.json.attestation.json \
    fased-signerd-release.attestation.json \
    fased-hosting-candidate.json \
    fased-hosting-candidate.json.attestation.json \
    "fased-generation-linux-x64-v${VERSION}.tar.gz"; do
    [[ -f "$ARTIFACT_DIR/$required_asset" ]] || {
      echo "The public-acquisition fixture is missing $required_asset." >&2
      exit 1
    }
  done
  grep -Fqx \
    "install_entry_release_identity=\"${VERSION}\"" \
    "$ARTIFACT_DIR/install.sh" || {
    echo "The public-acquisition fixture requires the exact stamped installer identity." >&2
    exit 1
  }
  jq -e --arg version "$VERSION" --arg commit "$COMMIT" \
    '.release.version == $version and
      .release.tag == ("v" + $version) and
      .release.commit == $commit' \
    "$ARTIFACT_DIR/fased-hosted-release-v2.json" >/dev/null || {
    echo "The public-acquisition fixture requires the exact candidate manifest identity." >&2
    exit 1
  }
fi
if [[ ",$SCENARIOS," == *,managed-update,* ]]; then
  [[ "$MANAGED_PREDECESSOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
    echo "The managed-update fixture requires FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION." >&2
    exit 1
  }
  if [[ -z "$MANAGED_PREDECESSOR_ARTIFACT_DIR" ]]; then
    if [[ -n "$MANAGED_PREDECESSOR_CACHE_DIR" ]]; then
      [[ "$MANAGED_PREDECESSOR_CACHE_DIR" == /* ]] || {
        echo "FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_CACHE_DIR must be absolute or empty." >&2
        exit 1
      }
      mkdir -p "$MANAGED_PREDECESSOR_CACHE_DIR"
      managed_predecessor_cache_target="$MANAGED_PREDECESSOR_CACHE_DIR/v$MANAGED_PREDECESSOR_VERSION"
      if [[ -d "$managed_predecessor_cache_target" ]]; then
        MANAGED_PREDECESSOR_ARTIFACT_DIR="$managed_predecessor_cache_target"
        echo "predecessor artifact cache hit: v$MANAGED_PREDECESSOR_VERSION"
      else
        MANAGED_PREDECESSOR_ARTIFACT_DIR="$(
          mktemp -d "$MANAGED_PREDECESSOR_CACHE_DIR/.v${MANAGED_PREDECESSOR_VERSION}.downloading.XXXXXX"
        )"
        OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR=1
      fi
    else
      MANAGED_PREDECESSOR_ARTIFACT_DIR="$(
        mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-managed-predecessor-artifact.XXXXXX"
      )"
      OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR=1
    fi
  fi
  managed_predecessor_manifest="$MANAGED_PREDECESSOR_ARTIFACT_DIR/fased-hosted-release-v2.json"
  if [[ ! -f "$MANAGED_PREDECESSOR_ARTIFACT_DIR/install.sh" ||
    ! -f "$managed_predecessor_manifest" ]]; then
    [[ "$OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR" -eq 1 ]] || {
      echo "The immutable predecessor cache entry is incomplete." >&2
      exit 1
    }
    command -v gh >/dev/null 2>&1 || {
      echo "GitHub CLI is required when the immutable predecessor cache is empty." >&2
      exit 1
    }
    gh release download "v$MANAGED_PREDECESSOR_VERSION" \
      --repo fased-ai/fased \
      --dir "$MANAGED_PREDECESSOR_ARTIFACT_DIR"
    chmod 0755 "$MANAGED_PREDECESSOR_ARTIFACT_DIR"
    managed_predecessor_manifest="$MANAGED_PREDECESSOR_ARTIFACT_DIR/fased-hosted-release-v2.json"
  fi
  [[ -f "$MANAGED_PREDECESSOR_ARTIFACT_DIR/install.sh" && -f "$managed_predecessor_manifest" ]] || {
    echo "The managed Protected Local update fixture requires a complete predecessor release." >&2
    exit 1
  }
  jq -e --arg version "$MANAGED_PREDECESSOR_VERSION" \
    '.release.version == $version and .release.tag == ("v" + $version)' \
    "$managed_predecessor_manifest" >/dev/null
  if [[ "$OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR" -eq 1 &&
    -n "${managed_predecessor_cache_target:-}" ]]; then
    [[ ! -e "$managed_predecessor_cache_target" ]] || {
      echo "The predecessor cache target appeared during download." >&2
      exit 1
    }
    mv "$MANAGED_PREDECESSOR_ARTIFACT_DIR" "$managed_predecessor_cache_target"
    MANAGED_PREDECESSOR_ARTIFACT_DIR="$managed_predecessor_cache_target"
    OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR=0
    echo "predecessor artifact cache stored: v$MANAGED_PREDECESSOR_VERSION"
  fi
fi
cleanup_names=()
dump_fixture_failure() {
  local name="$1"
  echo "Protected Local fixture diagnostics: $name" >&2
  run_container exec "$name" /bin/bash -lc '
    systemctl --failed --no-pager >&2 || true
    systemctl cat "fased-gateway-*" >&2 || true
    find /var/lib/fased-local -maxdepth 4 -printf "%M %u:%g %p\n" >&2 2>/dev/null || true
    find /home/testop/.fased/wallet /home/testop/.fased/identity /home/testop/.fased \
      -maxdepth 1 -printf "%M %u:%g %p\n" >&2 2>/dev/null || true
    journalctl -u "fased-gateway-*" -u "fased-signerd-*" -u "fased-local-controller-*" -n 160 --no-pager >&2 || true
    for log in /var/lib/fased-local/*/signer/audit.jsonl /home/testop/.fased/logs/*.log /tmp/*.err /tmp/*.out /tmp/*.json; do
      [[ -f "$log" ]] || continue
      echo "==> $log" >&2
      tail -n 100 "$log" >&2 || true
    done
  ' || true
}

cleanup() {
  local name
  for name in "${cleanup_names[@]}"; do
    if [[ "${FASED_SYSTEMD_FIXTURE_PRESERVE_FAILURE:-0}" == "1" ]] &&
      run_container container exists "$name" >/dev/null 2>&1; then
      printf 'preserved failed fixture: %s\n' "$name" >&2
      continue
    fi
    run_container rm -f "$name" >/dev/null 2>&1 || true
  done
  if [[ "$OWN_ARTIFACT_DIR" -eq 1 ]]; then
    rm -rf -- "$ARTIFACT_DIR"
  fi
  if [[ "$OWN_MANAGED_PREDECESSOR_ARTIFACT_DIR" -eq 1 ]]; then
    rm -rf -- "$MANAGED_PREDECESSOR_ARTIFACT_DIR"
  fi
  if [[ "$OWN_SOURCE_REPO_DIR" -eq 1 ]]; then
    rm -rf -- "$SOURCE_REPO_DIR"
  fi
  if [[ "$OWN_RECEIPT_DIR" -eq 1 ]]; then
    rm -rf -- "$RECEIPT_DIR"
  fi
}
trap cleanup EXIT INT TERM HUP

if [[ -z "$RECEIPT_DIR" ]]; then
  RECEIPT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-lifecycle-acceptance-receipts.XXXXXX")"
  OWN_RECEIPT_DIR=1
else
  mkdir -p "$RECEIPT_DIR"
fi

if [[ "$(git -C "$ROOT_DIR" rev-parse HEAD)" == "$COMMIT" &&
  -z "$(git -C "$ROOT_DIR" status --porcelain=v1 --untracked-files=normal)" ]] &&
  { ! command -v selinuxenabled >/dev/null 2>&1 || ! selinuxenabled; }; then
  SOURCE_REPO_DIR="$ROOT_DIR"
  SOURCE_REPO_MOUNT_OPTIONS="ro"
  echo "fixture source reuse: exact clean commit $COMMIT"
else
  SOURCE_REPO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-protected-local-source.XXXXXX")"
  OWN_SOURCE_REPO_DIR=1
  git clone --quiet --no-hardlinks "$ROOT_DIR" "$SOURCE_REPO_DIR"
  git -C "$SOURCE_REPO_DIR" checkout --quiet --detach "$COMMIT"
fi
[[ "$(git -C "$SOURCE_REPO_DIR" rev-parse HEAD)" == "$COMMIT" ]] || {
  echo "The protected Local fixture failed to materialize the exact source commit." >&2
  exit 1
}

IFS=',' read -r -a distro_list <<<"$DISTROS"
IFS=',' read -r -a scenario_list <<<"$SCENARIOS"
run_fixture_scenario() {
  local distro="$1"
  local image="$2"
  local scenario="$3"
  local name="$4"
  local fixture_command_pid=""
  local fixture_command_started=""
  local fixture_command_status=0
  local fixture_memory=""
  local ready=0
  local state=""
  local predecessor_artifact_dir="$ARTIFACT_DIR"
  local predecessor_version=""
  if [[ "$scenario" == "managed-update" ]]; then
    predecessor_artifact_dir="$MANAGED_PREDECESSOR_ARTIFACT_DIR"
    predecessor_version="$MANAGED_PREDECESSOR_VERSION"
  fi

  run_container run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$VERSION" \
    -e "FASED_FIXTURE_COMMIT=$COMMIT" \
    -e "FASED_FIXTURE_PREDECESSOR_VERSION=$predecessor_version" \
    -e "FASED_FIXTURE_PREINSTALLED_TOOLS=$PREINSTALLED_TOOLS" \
    -e "FASED_FIXTURE_PUBLIC_ACQUISITION=$PUBLIC_ACQUISITION" \
    -v "$SOURCE_REPO_DIR:/repo:$SOURCE_REPO_MOUNT_OPTIONS" \
    -v "$FIXTURE_DIR/run.sh:/usr/local/bin/fased-protected-local-systemd-fixture:ro,z" \
    -v "$ARTIFACT_DIR:/artifacts:ro,z" \
    -v "$predecessor_artifact_dir:/predecessor-artifacts:ro,z" \
    "$image" >/dev/null
  for _ in {1..200}; do
    state="$(run_container exec "$name" systemctl is-system-running 2>/dev/null || true)"
    if [[ "$state" == "running" || "$state" == "degraded" ]]; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [[ "$ready" -eq 1 ]] || {
    echo "$distro systemd fixture did not become ready." >&2
    exit 1
  }
  fixture_command_started="$SECONDS"
  run_container exec "$name" /bin/bash \
    /usr/local/bin/fased-protected-local-systemd-fixture "$scenario" &
  fixture_command_pid="$!"
  while kill -0 "$fixture_command_pid" 2>/dev/null; do
    sleep 15
    if kill -0 "$fixture_command_pid" 2>/dev/null; then
      fixture_memory="$(
        run_container stats --no-stream --format '{{.MemUsage}}' "$name" 2>/dev/null || true
      )"
      printf \
        'fixture heartbeat: distro=%s scenario=%s stage=product-lifecycle elapsed=%ss memory=%s\n' \
        "$distro" \
        "$scenario" \
        "$((SECONDS - fixture_command_started))" \
        "${fixture_memory:-unavailable}"
    fi
  done
  wait "$fixture_command_pid" || fixture_command_status="$?"
  if [[ "$fixture_command_status" -ne 0 ]]; then
    if [[ "${FASED_SYSTEMD_FIXTURE_COMPACT_DIAGNOSTICS:-0}" == "1" ]]; then
      run_container exec "$name" /bin/bash -lc '
        for log in \
          /tmp/fresh-install.err \
          /tmp/fresh-install.out \
          /tmp/stable-bridge-failure.err \
          /tmp/stable-bridge-failure.out \
          /tmp/stable-bridge-noop.err \
          /tmp/stable-bridge-noop.out; do
          [[ -f "$log" ]] || continue
          echo "==> $log" >&2
          cat "$log" >&2
        done
      ' || true
    else
      dump_fixture_failure "$name"
    fi
    return "$fixture_command_status"
  fi
  run_container stop "$name" >/dev/null
  run_container start "$name" >/dev/null
  ready=0
  for _ in {1..200}; do
    state="$(run_container exec "$name" systemctl is-system-running 2>/dev/null || true)"
    if [[ "$state" == "running" || "$state" == "degraded" ]]; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [[ "$ready" -eq 1 ]] || {
    echo "$distro systemd fixture did not recover after container reboot." >&2
    exit 1
  }
  if ! run_container exec "$name" /bin/bash \
    /usr/local/bin/fased-protected-local-systemd-fixture verify-reboot; then
    dump_fixture_failure "$name"
    exit 1
  fi
  receipt="$RECEIPT_DIR/${distro}-${scenario}.json"
  run_container cp \
    "$name:/var/lib/fased-protected-local-fixture/lifecycle-acceptance-${scenario}.json" \
    "$receipt"
  descriptor_digest="sha256:$(sha256sum "$ARTIFACT_DIR/fased-hosting-candidate.json" | awk '{print $1}')"
  node "$ROOT_DIR/scripts/lifecycle-acceptance-contract.mjs" verify-receipt \
    --contract "$ARTIFACT_DIR/fased-lifecycle-acceptance-v1.json" \
    --receipt "$receipt" \
    --scenario "$scenario" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --candidate-descriptor-digest "$descriptor_digest" >/dev/null
  printf 'lifecycle acceptance receipt verified: %s\n' "$receipt"
  run_container rm -f "$name" >/dev/null
}

for distro in "${distro_list[@]}"; do
  containerfile="$FIXTURE_DIR/Containerfile.$distro"
  [[ -f "$containerfile" ]] || {
    echo "Unsupported protected Local fixture distro: $distro" >&2
    exit 1
  }
  image="fased-protected-local-systemd-${distro}:local"
  image_started="$SECONDS"
  archive=""
  if [[ -n "$IMAGE_CACHE_DIR" ]]; then
    mkdir -p "$IMAGE_CACHE_DIR"
    archive="$IMAGE_CACHE_DIR/${distro}.oci.tar"
  fi
  if [[ -n "$archive" && -s "$archive" ]]; then
    run_container load --input "$archive" >/dev/null
    run_container image exists "$image"
    printf 'fixture timing: distro=%s stage=image-cache-load elapsed=%ss\n' \
      "$distro" "$((SECONDS - image_started))"
  else
    run_container build -f "$containerfile" -t "$image" "$FIXTURE_DIR"
    if [[ -n "$archive" ]]; then
      run_container save --format oci-archive --output "$archive" "$image"
    fi
    printf 'fixture timing: distro=%s stage=image-build elapsed=%ss\n' \
      "$distro" "$((SECONDS - image_started))"
  fi
done

for scenario in "${scenario_list[@]}"; do
  case "$scenario" in
    fresh-install|managed-update) ;;
    *)
      echo "Unsupported protected Local fixture scenario: $scenario" >&2
      exit 1
      ;;
  esac
done

for distro in "${distro_list[@]}"; do
  image="fased-protected-local-systemd-${distro}:local"
  if [[ "$PARALLEL_SCENARIOS" == "0" || "${#scenario_list[@]}" -eq 1 ]]; then
    for scenario in "${scenario_list[@]}"; do
      name="fased-protected-local-${distro}-${scenario}-$$"
      cleanup_names+=("$name")
      fixture_started="$SECONDS"
      run_fixture_scenario "$distro" "$image" "$scenario" "$name"
      printf 'fixture timing: distro=%s scenario=%s stage=complete elapsed=%ss\n' \
        "$distro" "$scenario" "$((SECONDS - fixture_started))"
    done
    continue
  fi

  fixture_pids=()
  for scenario in "${scenario_list[@]}"; do
    name="fased-protected-local-${distro}-${scenario}-$$"
    cleanup_names+=("$name")
    (
      fixture_started="$SECONDS"
      run_fixture_scenario "$distro" "$image" "$scenario" "$name"
      printf 'fixture timing: distro=%s scenario=%s stage=complete elapsed=%ss\n' \
        "$distro" "$scenario" "$((SECONDS - fixture_started))"
    ) &
    fixture_pids+=("$!")
  done

  while [[ "${#fixture_pids[@]}" -gt 0 ]]; do
    completed_pid=""
    if wait -n -p completed_pid "${fixture_pids[@]}"; then
      fixture_status=0
    else
      fixture_status="$?"
    fi
    remaining_pids=()
    for fixture_pid in "${fixture_pids[@]}"; do
      [[ "$fixture_pid" == "$completed_pid" ]] || remaining_pids+=("$fixture_pid")
    done
    fixture_pids=("${remaining_pids[@]}")
    if [[ "$fixture_status" -ne 0 ]]; then
      for fixture_pid in "${fixture_pids[@]}"; do
        kill "$fixture_pid" >/dev/null 2>&1 || true
      done
      for fixture_pid in "${fixture_pids[@]}"; do
        wait "$fixture_pid" >/dev/null 2>&1 || true
      done
      echo "Parallel protected Local proof stopped on the first failed scenario." >&2
      exit "$fixture_status"
    fi
  done
done

echo "Protected Local systemd fixtures passed: distros=$DISTROS scenarios=$SCENARIOS"
