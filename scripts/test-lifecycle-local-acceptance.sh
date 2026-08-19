#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lifecycle-fixture-only-paths.sh"
source "$ROOT_DIR/scripts/prepare-lifecycle-systemd-fixture-images.sh"
GO_BIN="${FASED_GO_BIN:-$(command -v go || true)}"
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
IMAGE_CACHE_DIR="${FASED_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR:-$CACHE_HOME/fased-dev/lifecycle-fixture-images/local}"
PREPARE_IMAGES="${FASED_SYSTEMD_FIXTURE_PREPARE_IMAGES:-}"
PREINSTALLED_TOOLS="${FASED_SYSTEMD_FIXTURE_PREINSTALLED_TOOLS:-0}"
EXACT_CANDIDATE_REPLAY="${FASED_SYSTEMD_FIXTURE_EXACT_CANDIDATE_REPLAY:-0}"
PUBLIC_ACQUISITION="${FASED_SYSTEMD_FIXTURE_PUBLIC_ACQUISITION:-0}"
RELEASE_SEQUENCE="${FASED_LIFECYCLE_RELEASE_SEQUENCE:-1}"
SECURITY_EPOCH="${FASED_LIFECYCLE_SECURITY_EPOCH:-1}"
BUILD_ONLY="${FASED_SYSTEMD_FIXTURE_BUILD_ONLY:-0}"
ARTIFACT_OUTPUT_DIR="${FASED_SYSTEMD_FIXTURE_OUTPUT_DIR:-}"
ARTIFACT_PROFILE="${FASED_SYSTEMD_FIXTURE_ARTIFACT_PROFILE:-branch-x64}"
RECEIPT_DIR="${FASED_SYSTEMD_FIXTURE_RECEIPT_DIR:-}"
OWN_RECEIPT_DIR=0
MANAGED_PREDECESSOR_VERSION="${FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION:-}"
MANAGED_PREDECESSOR_CLASS="${FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_CLASS:-public-stable}"
PREDECESSOR_CAPSULE_DIR="${FASED_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_DIR:-}"
PREDECESSOR_CAPSULE_CACHE_DIR="${FASED_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_CACHE_DIR-$CACHE_HOME/fased/predecessor-capsules}"
PARALLEL_SCENARIOS="${FASED_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS:-1}"
SYSTEMD_START_LOCK="${FASED_LIFECYCLE_FIXTURE_START_LOCK:-${TMPDIR:-/tmp}/fased-lifecycle-systemd-start.lock}"
FIXTURE_TOOLS_DIR=""
FIXTURE_PREINSTALLED_TOOLS_DIR=""
FIXTURE_NODE_MODULES=""
FIXTURE_ARTIFACT_COMPAT_DIR=""

if [[ -z "$PREPARE_IMAGES" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    PREPARE_IMAGES=1
  else
    PREPARE_IMAGES=0
  fi
fi
[[ "$PREPARE_IMAGES" == "0" || "$PREPARE_IMAGES" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_PREPARE_IMAGES must be 0 or 1." >&2
  exit 1
}

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

[[ -n "$GO_BIN" && -x "$GO_BIN" ]] || {
  echo "Go is required for lifecycle acceptance." >&2
  exit 1
}

cleanup_before_fixture() {
  if [[ -n "$FIXTURE_ARTIFACT_COMPAT_DIR" ]]; then
    rm -rf -- "$FIXTURE_ARTIFACT_COMPAT_DIR"
  fi
  if [[ "$OWN_ARTIFACT_DIR" -eq 1 && -n "$ARTIFACT_DIR" ]]; then
    rm -rf -- "$ARTIFACT_DIR"
  fi
  if [[ -n "$ARTIFACT_CACHE_LOCK_FD" ]]; then
    flock -u "$ARTIFACT_CACHE_LOCK_FD" >/dev/null 2>&1 || true
  fi
}
trap cleanup_before_fixture EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [[ -n "$ARTIFACT_DIR" &&
  -f "$ARTIFACT_DIR/fased-candidate-fixture-overlay.json" &&
  ! -e "$ARTIFACT_DIR/fased-hosted-release-v2.json.attestation.json" &&
  ! -L "$ARTIFACT_DIR/fased-hosted-release-v2.json.attestation.json" ]]; then
  FIXTURE_ARTIFACT_COMPAT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-fixture-artifact-compat.XXXXXX")"
  cp -a --reflink=auto "$ARTIFACT_DIR/." "$FIXTURE_ARTIFACT_COMPAT_DIR/"
  printf '{"fixtureOfflineAttestation":true}\n' \
    >"$FIXTURE_ARTIFACT_COMPAT_DIR/fased-hosted-release-v2.json.attestation.json"
  ARTIFACT_DIR="$FIXTURE_ARTIFACT_COMPAT_DIR"
fi

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
  fixture_overlay="$ARTIFACT_DIR/fased-candidate-fixture-overlay.json"
  candidate_artifact_path() {
    local name="$1"
    if [[ -f "$fixture_overlay" &&
      ("$name" == "install.sh" || "$name" == "fased-bootstrap-linux-x64") ]]; then
      printf '%s\n' "$ARTIFACT_DIR/fased-candidate-original/$name"
      return
    fi
    printf '%s\n' "$ARTIFACT_DIR/$name"
  }
  if [[ -f "$fixture_overlay" ]]; then
    jq -e --arg digest "sha256:$(sha256sum "$descriptor" | awk '{print $1}')" \
      --arg install "sha256:$(sha256sum "$ARTIFACT_DIR/install.sh" | awk '{print $1}')" \
      --arg bootstrap "sha256:$(sha256sum "$ARTIFACT_DIR/fased-bootstrap-linux-x64" | awk '{print $1}')" \
      '.schemaVersion == 1 and .role == "fased-candidate-fixture-trust-overlay" and
       .publishable == false and .candidate.descriptorSha256 == $digest and
       .fixture.installSha256 == $install and .fixture.bootstrapSha256 == $bootstrap and
       .overriddenPaths == ["fased-bootstrap-linux-x64","install.sh"]' \
      "$fixture_overlay" >/dev/null || {
      echo "The candidate fixture trust overlay is not bound to the exact descriptor." >&2
      exit 1
    }
  fi
  while IFS=$'\t' read -r name expected_size expected_digest; do
    candidate="$(candidate_artifact_path "$name")"
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
[[ "$EXACT_CANDIDATE_REPLAY" == "0" || "$EXACT_CANDIDATE_REPLAY" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_EXACT_CANDIDATE_REPLAY must be 0 or 1." >&2
  exit 1
}
[[ "$PARALLEL_SCENARIOS" == "0" || "$PARALLEL_SCENARIOS" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_PARALLEL_SCENARIOS must be 0 or 1." >&2
  exit 1
}
[[ "$SYSTEMD_START_LOCK" == /* ]] || {
  echo "FASED_LIFECYCLE_FIXTURE_START_LOCK must be absolute." >&2
  exit 1
}
command -v flock >/dev/null 2>&1 || {
  echo "flock is required for serialized systemd fixture startup." >&2
  exit 1
}
mkdir -p "$(dirname "$SYSTEMD_START_LOCK")"
[[ "$PUBLIC_ACQUISITION" == "0" || "$PUBLIC_ACQUISITION" == "1" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_PUBLIC_ACQUISITION must be 0 or 1." >&2
  exit 1
}
[[ "$ARTIFACT_PROFILE" == "branch-x64" ]] || {
  echo "FASED_SYSTEMD_FIXTURE_ARTIFACT_PROFILE must be branch-x64." >&2
  echo "Full-platform candidate artifacts belong to the trusted release workflow." >&2
  exit 1
}

clear_branch_fixture_native_outputs() {
  local release_dir="$ROOT_DIR/dist-native/release"
  local stale_asset

  mkdir -p "$release_dir"
  while IFS= read -r -d '' stale_asset; do
    rm -f -- "$stale_asset"
  done < <(
    find "$release_dir" -maxdepth 1 \( -type f -o -type l \) \
      \( -name 'fased-signerd-*' -o -name 'fased-lifecycled-*' -o -name 'fased-bootstrap-*' \) \
      -print0
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
  FASED_LIFECYCLE_BUILD_COMMIT="$COMMIT" \
  FASED_LIFECYCLE_BUILD_TREE="$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
  FASED_LIFECYCLE_TARGETS="linux/amd64" \
    bash "$ROOT_DIR/scripts/build-native-release-assets.sh"
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
  node "$ROOT_DIR/scripts/stamp-release-installer.mjs" \
    --source "$ROOT_DIR/install.sh" \
    --output "$ARTIFACT_DIR/install.sh" \
    --version "$VERSION" \
    --bootstrap-x64 "$ARTIFACT_DIR/fased-bootstrap-linux-x64" \
    --architecture x64
  x64_identity="$ARTIFACT_DIR/fased-hosted-app-v2-linux-x64-v${VERSION}.tar.gz.release.json"
  x64_app="$(jq -er .app.asset "$x64_identity")"
  x64_dependency="$(jq -er .dependencies.asset "$x64_identity")"
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
    --inventory-tool "$ARTIFACT_DIR/fased-lifecycled-linux-amd64" \
    --node "$(readlink -f "$(command -v node)")" \
    --node-license "$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")/LICENSE" \
    --output-dir "$ARTIFACT_DIR" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --tree "$(git -C "$ROOT_DIR" rev-parse 'HEAD^{tree}')" \
    --architecture x64
  # Build-only mode emits the production product bytes. LOCAL0 and pre-tag P1
  # derive a separate branch-trust overlay in a new directory, preserving the
  # production installer/bootstrap for exact post-tag attestation and release.
  if [[ "$PUBLIC_ACQUISITION" == "1" && "$BUILD_ONLY" == "0" ]]; then
    issued_at="$(node -e '
      process.stdout.write(new Date(process.argv[1]).toISOString());
    ' "$(git -C "$ROOT_DIR" show -s --format=%cI "$COMMIT")")"
    fixture_inventory="$(mktemp "${TMPDIR:-/tmp}/fased-branch-inventory.XXXXXX")"
    tar -xOf \
      "$ARTIFACT_DIR/fased-generation-linux-x64-v${VERSION}.tar.gz" \
      generation/inventory.json >"$fixture_inventory"
    fixture_generation_digest="$(
      tar -xOf \
        "$ARTIFACT_DIR/fased-generation-linux-x64-v${VERSION}.tar.gz" \
        generation/generation.json | jq -er .generation.artifactSetDigest
    )"
    fixture_plugin_lock_digest="sha256:$(
      tar -xOf \
        "$ARTIFACT_DIR/fased-generation-linux-x64-v${VERSION}.tar.gz" \
        generation/payload/runtime/plugin.lock.json |
        jq -cj '{schemaVersion,type,entries:[.entries[]|{id,origin,digest,apiCapability,required}]}' |
        sha256sum | awk '{print $1}'
    )"
    GOTMPDIR="$fixture_go_tmp" GOCACHE="$fixture_go_cache" \
      go -C "$ROOT_DIR/tools/fased-lifecycled" run ./cmd/fased-branch-trust \
        --artifact-dir "$ARTIFACT_DIR" \
        --inventory "$fixture_inventory" \
        --version "$VERSION" \
        --commit "$COMMIT" \
        --tree "$TREE" \
        --artifact-set-digest "$fixture_generation_digest" \
        --plugin-lock-digest "$fixture_plugin_lock_digest" \
        --release-sequence "$RELEASE_SEQUENCE" \
        --security-epoch "$SECURITY_EPOCH" \
        --issued-at "$issued_at"
    rm -f "$fixture_inventory"
    fixture_root_pin="$(tr -d '\n' <"$ARTIFACT_DIR/fased-branch-root.sha256")"
    fixture_metadata_base="https://github.com/fased-ai/fased/releases/download/v${VERSION}"
    (
      cd "$ROOT_DIR/tools/fased-lifecycled"
      CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO_BIN" build \
        -buildvcs=false -trimpath \
        -ldflags="-s -w -buildid= -X main.branchFixtureMetadataBase=${fixture_metadata_base} -X main.branchFixturePinnedRootSHA256=${fixture_root_pin}" \
        -o "$ARTIFACT_DIR/fased-bootstrap-linux-x64" ./cmd/fased-bootstrap
    )
    chmod 0755 "$ARTIFACT_DIR/fased-bootstrap-linux-x64"
    node "$ROOT_DIR/scripts/stamp-release-installer.mjs" \
      --source "$ROOT_DIR/install.sh" \
      --output "$ARTIFACT_DIR/install.sh" \
      --version "$VERSION" \
      --bootstrap-x64 "$ARTIFACT_DIR/fased-bootstrap-linux-x64" \
      --architecture x64
    for attested_asset in \
      fased-hosted-release-v2.json \
      install.sh; do
      printf '{"fixtureOfflineAttestation":true}\n' \
        >"$ARTIFACT_DIR/${attested_asset}.attestation.json"
    done
  fi
  printf '{"schemaVersion":1,"profile":"branch-x64","publishable":false,"platforms":["linux-x64"]}\n' \
    >"$ARTIFACT_DIR/fased-branch-proof-x64.json"
  echo "branch-x64 artifacts are fixture-only and cannot be published"
  install -m 0644 \
    "$ROOT_DIR/config/lifecycle-acceptance.v2.json" \
    "$ARTIFACT_DIR/fased-lifecycle-acceptance-v2.json"
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
    install.sh \
    fased-bootstrap-linux-x64 \
    fased-hosted-release-v2.json \
    fased-lifecycle-acceptance-v2.json \
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
[[ -f "$ARTIFACT_DIR/fased-hosted-app-v2-linux-x64-v${VERSION}.tar.gz" ]] || {
  echo "The protected Local fixture requires the exact x64 generation application artifact." >&2
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
    fased-lifecycle-acceptance-v2.json \
    fased-lifecycle-release-compatibility-v1.json \
    fased-hosting-candidate.json \
    fased-hosting-candidate.json.attestation.json \
    "fased-generation-linux-x64-v${VERSION}.tar.gz"; do
    [[ -f "$ARTIFACT_DIR/$required_asset" && ! -L "$ARTIFACT_DIR/$required_asset" ]] || {
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
  [[ "$MANAGED_PREDECESSOR_CLASS" == "public-stable" ||
    "$MANAGED_PREDECESSOR_CLASS" == "canonical-managed" ]] || {
    echo "The managed-update fixture requires an explicit supported predecessor class." >&2
    exit 1
  }
  [[ "$MANAGED_PREDECESSOR_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
    echo "The managed-update fixture requires FASED_SYSTEMD_FIXTURE_MANAGED_PREDECESSOR_VERSION." >&2
    exit 1
  }
  if [[ -z "$PREDECESSOR_CAPSULE_DIR" && -f "$ARTIFACT_DIR/fased-branch-proof-x64.json" ]]; then
    [[ "$PREDECESSOR_CAPSULE_CACHE_DIR" == /* ]] || {
      echo "FASED_SYSTEMD_FIXTURE_PREDECESSOR_CAPSULE_CACHE_DIR must be absolute." >&2
      exit 1
    }
    PREDECESSOR_CAPSULE_DIR="$(bash "$ROOT_DIR/scripts/prepare-branch-predecessor-capsule.sh" \
      protected-local "$MANAGED_PREDECESSOR_VERSION" "$COMMIT" "$TREE" \
      "$PREDECESSOR_CAPSULE_CACHE_DIR" "$MANAGED_PREDECESSOR_CLASS")"
  fi
  [[ "$PREDECESSOR_CAPSULE_DIR" == /* && -d "$PREDECESSOR_CAPSULE_DIR" ]] || {
    echo "The managed update fixture requires one absolute predecessor capsule directory." >&2
    exit 1
  }
  capsule_descriptor="$PREDECESSOR_CAPSULE_DIR/fased-predecessor-capsule.json"
  capsule_descriptor_attestation="$capsule_descriptor.attestation.json"
  [[ -f "$capsule_descriptor" && ! -L "$capsule_descriptor" ]] || {
    echo "The predecessor capsule descriptor is required." >&2
    exit 1
  }
  capsule_archive="$(jq -er .archive.name "$capsule_descriptor")"
  capsule_archive_attestation="$PREDECESSOR_CAPSULE_DIR/${capsule_archive}.attestation.json"
  [[ -f "$PREDECESSOR_CAPSULE_DIR/$capsule_archive" && ! -L "$PREDECESSOR_CAPSULE_DIR/$capsule_archive" ]] || {
    echo "The predecessor capsule archive is required." >&2
    exit 1
  }
  node "$ROOT_DIR/scripts/lifecycle-installed-state-capsule.mjs" verify \
    --descriptor "$capsule_descriptor" >/dev/null
  jq -e --arg version "$MANAGED_PREDECESSOR_VERSION" --arg installationClass "$MANAGED_PREDECESSOR_CLASS" \
    '.profile == "protected-local" and .release.version == $version and
     .installationClass.kind == $installationClass' \
    "$capsule_descriptor" >/dev/null
  predecessor_branch_proof="$PREDECESSOR_CAPSULE_DIR/fased-predecessor-branch-proof.json"
  if [[ -f "$predecessor_branch_proof" ]]; then
    test -f "$ARTIFACT_DIR/fased-branch-proof-x64.json"
    jq -e --arg commit "$COMMIT" --arg tree "$TREE" \
      '.role == "fased-predecessor-capsule-branch-proof" and
       .publishable == false and .profile == "protected-local" and
       .builder.commit == $commit and .builder.tree == $tree' \
      "$predecessor_branch_proof" >/dev/null
    test "$(jq -er .descriptor.sha256 "$predecessor_branch_proof")" = \
      "sha256:$(sha256sum "$capsule_descriptor" | awk '{print $1}')"
    test "$(jq -er .archive.sha256 "$predecessor_branch_proof")" = \
      "sha256:$(sha256sum "$PREDECESSOR_CAPSULE_DIR/$capsule_archive" | awk '{print $1}')"
  else
    [[ -s "$capsule_descriptor_attestation" && ! -L "$capsule_descriptor_attestation" &&
      -s "$capsule_archive_attestation" && ! -L "$capsule_archive_attestation" ]] || {
      echo "Candidate P1 requires capsule descriptor and archive attestations." >&2
      exit 1
    }
    GH_PROMPT_DISABLED=1 gh attestation verify "$capsule_descriptor" \
      --repo fased-ai/fased --bundle "$capsule_descriptor_attestation" \
      --deny-self-hosted-runners >/dev/null
    GH_PROMPT_DISABLED=1 gh attestation verify "$PREDECESSOR_CAPSULE_DIR/$capsule_archive" \
      --repo fased-ai/fased --bundle "$capsule_archive_attestation" \
      --deny-self-hosted-runners >/dev/null
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

preserve_partial_receipt() {
  local name="$1"
  local distro="$2"
  local scenario="$3"
  local source="/var/lib/fased-protected-local-fixture/lifecycle-acceptance-${scenario}.json"
  local destination="$RECEIPT_DIR/${distro}-${scenario}.partial.json"

  if run_container exec "$name" test -f "$source" >/dev/null 2>&1; then
    run_container cp "$name:$source" "$destination" >/dev/null 2>&1 || return 0
    printf 'preserved partial lifecycle receipt: %s\n' "$destination" >&2
  fi
}

cleanup() {
  local name
  local preserved_fixture=0
  for name in "${cleanup_names[@]}"; do
    if [[ "${FASED_SYSTEMD_FIXTURE_PRESERVE_FAILURE:-0}" == "1" ]] &&
      run_container container exists "$name" >/dev/null 2>&1; then
      printf 'preserved failed fixture: %s\n' "$name" >&2
      preserved_fixture=1
      continue
    fi
    run_container rm -f "$name" >/dev/null 2>&1 || true
  done
  if [[ "$OWN_ARTIFACT_DIR" -eq 1 ]]; then
    rm -rf -- "$ARTIFACT_DIR"
  fi
  if [[ -n "$FIXTURE_TOOLS_DIR" && "$preserved_fixture" -eq 0 ]]; then
    rm -rf -- "$FIXTURE_TOOLS_DIR"
  elif [[ -n "$FIXTURE_TOOLS_DIR" ]]; then
    printf 'preserved failed fixture support directory: %s\n' "$FIXTURE_TOOLS_DIR" >&2
  fi
  if [[ "$OWN_RECEIPT_DIR" -eq 1 && "$preserved_fixture" -eq 0 ]]; then
    rm -rf -- "$RECEIPT_DIR"
  fi
}
trap cleanup EXIT

if [[ -z "$RECEIPT_DIR" ]]; then
  RECEIPT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-lifecycle-acceptance-receipts.XXXXXX")"
  OWN_RECEIPT_DIR=1
else
  mkdir -p "$RECEIPT_DIR"
fi

FIXTURE_TOOLS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fased-lifecycle-fixture-tools.XXXXXX")"
FIXTURE_PREINSTALLED_TOOLS_DIR="$FIXTURE_TOOLS_DIR/preinstalled-tools"
mkdir -p "$FIXTURE_PREINSTALLED_TOOLS_DIR"
if [[ "$PREINSTALLED_TOOLS" == "1" ]]; then
  GH_BIN="$(command -v gh || true)"
  [[ "$GH_BIN" == /* && -f "$GH_BIN" && ! -L "$GH_BIN" && -x "$GH_BIN" ]] || {
    echo "Preinstalled-tool lifecycle proof requires one regular GitHub CLI binary." >&2
    exit 1
  }
  [[ "$(stat -Lc '%u' "$GH_BIN")" == "0" &&
    "$((8#$(stat -Lc '%a' "$GH_BIN") & 8#022))" == "0" ]] || {
    echo "Preinstalled-tool lifecycle proof requires a root-owned, non-writable GitHub CLI." >&2
    exit 1
  }
  "$GH_BIN" attestation verify --help >/dev/null
  cp --reflink=auto "$GH_BIN" "$FIXTURE_PREINSTALLED_TOOLS_DIR/gh"
  chmod 0755 "$FIXTURE_PREINSTALLED_TOOLS_DIR/gh"
fi
FIXTURE_SOURCE_COMMIT="$COMMIT"
if [[ "$EXACT_CANDIDATE_REPLAY" == "1" ]]; then
  [[ -n "$ARTIFACT_DIR" &&
    ! -e "$ARTIFACT_DIR/fased-branch-proof-x64.json" &&
    ! -e "$ARTIFACT_DIR/fased-candidate-fixture-overlay.json" ]] || {
    echo "Exact candidate replay requires an unmodified candidate artifact directory." >&2
    exit 1
  }
  unexpected_fixture_changes="$(lifecycle_unexpected_fixture_changes \
    "$ROOT_DIR" "$COMMIT" HEAD)"
  [[ -z "$unexpected_fixture_changes" ]] || {
    echo "Exact candidate replay rejected product changes:" >&2
    printf '%s\n' "$unexpected_fixture_changes" >&2
    exit 1
  }
  FIXTURE_SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  echo "exact candidate replay: product=$COMMIT fixture=$FIXTURE_SOURCE_COMMIT"
elif [[ -f "$ARTIFACT_DIR/fased-branch-proof-x64.json" ||
  -f "$ARTIFACT_DIR/fased-candidate-fixture-overlay.json" ]]; then
  unexpected_fixture_changes="$(lifecycle_unexpected_fixture_changes \
    "$ROOT_DIR" "$COMMIT" HEAD)"
  [[ -z "$unexpected_fixture_changes" ]] || {
    echo "Branch artifact reuse rejected product changes:" >&2
    printf '%s\n' "$unexpected_fixture_changes" >&2
    exit 1
  }
  FIXTURE_SOURCE_COMMIT="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  echo "branch artifact reuse: product=$COMMIT fixture=$FIXTURE_SOURCE_COMMIT"
fi
git -C "$ROOT_DIR" archive "$FIXTURE_SOURCE_COMMIT" -- \
  scripts/build-hosted-release-manifest.mjs \
  scripts/signer-protocol-v2.generated.mjs \
  scripts/lifecycle-acceptance-contract.mjs \
  scripts/lifecycle-receipt-verifier.mjs \
  scripts/lifecycle-installed-state-capsule.mjs \
  scripts/predecessor-capsule.mjs \
  scripts/restore-predecessor-capsule.mjs \
  scripts/docker/protected-local-systemd/lifecycle-acceptance.sh | tar -x -C "$FIXTURE_TOOLS_DIR"
FIXTURE_NODE_MODULES="$(readlink -f "$ROOT_DIR/node_modules")"
[[ -d "$FIXTURE_NODE_MODULES" ]] || {
  echo "The lifecycle fixture requires the frozen dependency directory." >&2
  exit 1
}
ln -s "$ROOT_DIR/node_modules" "$FIXTURE_TOOLS_DIR/scripts/node_modules"

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
  local start_lock_fd=""
  local predecessor_capsule_dir="$ARTIFACT_DIR"
  local predecessor_version=""
  if [[ "$scenario" == "managed-update" ]]; then
    predecessor_capsule_dir="$PREDECESSOR_CAPSULE_DIR"
    predecessor_version="$MANAGED_PREDECESSOR_VERSION"
  fi

  exec {start_lock_fd}>"$SYSTEMD_START_LOCK"
  flock "$start_lock_fd"
  if ! run_container run -d \
    --name "$name" \
    --privileged \
    --systemd=always \
    --tmpfs /run:rw,noexec \
    --tmpfs /tmp \
    -e "FASED_FIXTURE_VERSION=$VERSION" \
    -e "FASED_FIXTURE_COMMIT=$COMMIT" \
    -e "FASED_FIXTURE_PREDECESSOR_VERSION=$predecessor_version" \
    -e "FASED_FIXTURE_PREDECESSOR_CLASS=$MANAGED_PREDECESSOR_CLASS" \
    -e "FASED_FIXTURE_PREINSTALLED_TOOLS=$PREINSTALLED_TOOLS" \
    -e "FASED_FIXTURE_PUBLIC_ACQUISITION=$PUBLIC_ACQUISITION" \
    -v "$FIXTURE_TOOLS_DIR/scripts:/fixture-tools:ro,z" \
    -v "$FIXTURE_PREINSTALLED_TOOLS_DIR:/fixture-preinstalled-tools:ro,z" \
    -v "$FIXTURE_NODE_MODULES:$ROOT_DIR/node_modules:ro,z" \
    -v "$FIXTURE_TOOLS_DIR/scripts/docker/protected-local-systemd/lifecycle-acceptance.sh:/usr/local/bin/fased-protected-local-systemd-fixture:ro,z" \
    -v "$ARTIFACT_DIR:/artifacts:ro,z" \
    -v "$predecessor_capsule_dir:/predecessor-capsule:ro,z" \
    "$image" >/dev/null; then
    flock -u "$start_lock_fd"
    exec {start_lock_fd}>&-
    echo "$distro systemd fixture container failed to start: $name" >&2
    return 1
  fi
  for _ in {1..200}; do
    state="$(run_container exec "$name" systemctl is-system-running 2>/dev/null || true)"
    if [[ "$state" == "running" || "$state" == "degraded" ]]; then
      ready=1
      break
    fi
    if [[ "$(run_container inspect "$name" --format '{{.State.Running}}' 2>/dev/null || true)" == "false" ]]; then
      break
    fi
    sleep 0.1
  done
  flock -u "$start_lock_fd"
  exec {start_lock_fd}>&-
  [[ "$ready" -eq 1 ]] || {
    echo "$distro systemd fixture did not become ready: $name" >&2
    run_container inspect "$name" --format \
      'status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' >&2 2>/dev/null || true
    run_container logs "$name" >&2 2>/dev/null || true
    return 1
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
    preserve_partial_receipt "$name" "$distro" "$scenario"
    if [[ "${FASED_SYSTEMD_FIXTURE_COMPACT_DIAGNOSTICS:-0}" == "1" ]]; then
      run_container exec "$name" /bin/bash -lc '
        for log in \
           /tmp/fresh-install.err \
           /tmp/fresh-install.out \
           /tmp/fresh-noop-installer.err \
           /tmp/fresh-noop-installer.out \
           /tmp/fresh-noop-update.err \
           /tmp/fresh-noop-update.out \
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
    preserve_partial_receipt "$name" "$distro" "$scenario"
    dump_fixture_failure "$name"
    exit 1
  fi
  receipt="$RECEIPT_DIR/${distro}-${scenario}.json"
  run_container cp \
    "$name:/var/lib/fased-protected-local-fixture/lifecycle-acceptance-${scenario}.json" \
    "$receipt"
  descriptor_digest="sha256:$(sha256sum "$ARTIFACT_DIR/fased-hosting-candidate.json" | awk '{print $1}')"
  capsule_digest=""
  installation_class_digest=""
  if [[ "$scenario" == "managed-update" ]]; then
    capsule_digest="sha256:$(sha256sum "$PREDECESSOR_CAPSULE_DIR/fased-predecessor-capsule.json" | awk '{print $1}')"
    installation_class_digest="$(jq -er .installationClassDigest "$PREDECESSOR_CAPSULE_DIR/fased-predecessor-capsule.json")"
  fi
  node "$ROOT_DIR/scripts/lifecycle-receipt-verifier.mjs" \
    --contract "$ARTIFACT_DIR/fased-lifecycle-acceptance-v2.json" \
    --receipt "$receipt" \
    --profile protected-local \
    --scenario "$scenario" \
    --version "$VERSION" \
    --commit "$COMMIT" \
    --candidate-descriptor-digest "$descriptor_digest" \
    --predecessor-capsule-digest "$capsule_digest" \
    --predecessor-installation-class "$([[ "$scenario" == "managed-update" ]] && printf '%s' "$MANAGED_PREDECESSOR_CLASS" || true)" \
    --predecessor-installation-class-digest "$installation_class_digest" \
    --evidence-class PASS \
    --acquisition-evidence-class SUPPORTING >/dev/null
  printf 'branch lifecycle product receipt verified; acquisition supporting: %s\n' "$receipt"
  if [[ "$scenario" == "managed-update" ]]; then
    plugin_receipt="$receipt.plugins"
    run_container cp \
      "$name:/var/lib/fased-protected-local-fixture/managed-plugin-transaction.json" \
      "$plugin_receipt"
    jq -e --arg commit "$COMMIT" --arg version "$VERSION" \
      '.schemaVersion == 1 and .role == "fased-managed-plugin-transaction-acceptance" and
       .status == "PASS" and .evidenceClass == "PASS" and .commit == $commit and
       .version == $version and .dataPreserved == true and
       ([.catalogDigest,.candidateLockDigest,.readinessDigest,.generationId,
         .installedOutputDigest,.noopOutputDigest] | all(test("^sha256:[0-9a-f]{64}$")))' \
      "$plugin_receipt" >/dev/null
    printf 'managed plugin transaction receipt verified: %s\n' "$plugin_receipt"
    if ! run_container exec "$name" /bin/bash \
      /usr/local/bin/fased-protected-local-systemd-fixture verify-operations; then
      dump_fixture_failure "$name"
      exit 1
    fi
    operations_receipt="$receipt.operations"
    run_container cp \
      "$name:/var/lib/fased-protected-local-fixture/lifecycle-operations.json" \
      "$operations_receipt"
    jq -e --arg commit "$COMMIT" --arg predecessor_class "$MANAGED_PREDECESSOR_CLASS" \
      '.status == "PASS" and .evidenceClass == "PASS" and .commit == $commit and
       .predecessorClass == $predecessor_class and
       .repair.status == "PASS" and .repair.exactUnitRestored == true and
       .uninstall.status == "PASS" and .uninstall.managedAuthorityRemoved == true' \
      "$operations_receipt" >/dev/null
    printf 'managed operations receipt verified: %s\n' "$operations_receipt"
  fi
  run_container rm -f "$name" >/dev/null
}

if [[ "$PREPARE_IMAGES" == "1" ]]; then
  FASED_CONTAINER_RUNTIME="$RUNTIME" \
  FASED_CONTAINER_OCI_RUNTIME="$OCI_RUNTIME" \
  FASED_SYSTEMD_FIXTURE_PROFILE=local \
  FASED_SYSTEMD_FIXTURE_DISTROS="$DISTROS" \
  FASED_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR="$IMAGE_CACHE_DIR" \
    bash "$ROOT_DIR/scripts/prepare-lifecycle-systemd-fixture-images.sh"
fi

for distro in "${distro_list[@]}"; do
  image_digest="$(fased_fixture_image_digest local "$distro")"
  image="$(fased_fixture_image_ref local "$distro" "$image_digest")"
  image_started="$SECONDS"
  archive=""
  image_cache_lock_fd=""
  if [[ -n "$IMAGE_CACHE_DIR" ]]; then
    mkdir -p "$IMAGE_CACHE_DIR"
    archive="$(fased_fixture_image_archive "$IMAGE_CACHE_DIR" local "$distro" "$image_digest")"
    exec {image_cache_lock_fd}>"${archive}.lock"
    flock "$image_cache_lock_fd"
  fi
  if ! run_container image exists "$image" && [[ -n "$archive" && -s "$archive" ]]; then
    run_container load --input "$archive" >/dev/null
  fi
  run_container image exists "$image" || {
    echo "Fixture image is unavailable; prepare it explicitly:" >&2
    echo "  FASED_SYSTEMD_FIXTURE_PROFILE=local FASED_SYSTEMD_FIXTURE_DISTROS=$distro FASED_SYSTEMD_FIXTURE_IMAGE_CACHE_DIR=$IMAGE_CACHE_DIR bash scripts/prepare-lifecycle-systemd-fixture-images.sh" >&2
    exit 1
  }
  fased_fixture_verify_image "$image" "$image_digest"
  printf 'fixture timing: distro=%s stage=image-reuse elapsed=%ss image=%s\n' \
    "$distro" "$((SECONDS - image_started))" "$image"
  if [[ -n "$image_cache_lock_fd" ]]; then
    flock -u "$image_cache_lock_fd"
    exec {image_cache_lock_fd}>&-
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
  image_digest="$(fased_fixture_image_digest local "$distro")"
  image="$(fased_fixture_image_ref local "$distro" "$image_digest")"
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
    if [[ -z "$completed_pid" ]]; then
      for fixture_pid in "${fixture_pids[@]}"; do
        if ! kill -0 "$fixture_pid" 2>/dev/null; then
          completed_pid="$fixture_pid"
          break
        fi
      done
    fi
    [[ -n "$completed_pid" ]] || {
      echo "Parallel protected Local proof could not identify the completed scenario." >&2
      exit 1
    }
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
