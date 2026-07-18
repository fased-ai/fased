#!/usr/bin/env bash
set -euo pipefail

install_entry_source="${BASH_SOURCE[0]:-}"
install_entry_is_stream=0
case "$install_entry_source" in
  ""|bash|-|/dev/stdin) install_entry_is_stream=1 ;;
esac
install_entry_hosting=0
install_entry_verified_bundle=""
install_entry_legacy_ts_authkey=0
install_entry_args=("$@")
for ((install_entry_index = 0; install_entry_index < ${#install_entry_args[@]}; install_entry_index++)); do
  case "${install_entry_args[$install_entry_index]}" in
    --hosting|--repair-hosting)
      install_entry_hosting=1
      ;;
    --host-profile)
      if [[ "${install_entry_args[$((install_entry_index + 1))]:-}" == "hosting" ]]; then
        install_entry_hosting=1
      fi
      ;;
    --verified-hosting-bundle)
      install_entry_verified_bundle="${install_entry_args[$((install_entry_index + 1))]:-}"
      ;;
    --ts-authkey)
      install_entry_legacy_ts_authkey=1
      ;;
  esac
done

if [[ "$install_entry_legacy_ts_authkey" -eq 1 ]]; then
  echo "Refusing --ts-authkey because command arguments can expose the Tailscale secret." >&2
  echo "Place it in a root-only 0600 file and pass --ts-authkey-file /root/path instead." >&2
  exit 1
fi

# A Hosting request always enters the attest-and-extract bootstrap unless it is
# the exact inner invocation carrying the root-owned verified bundle marker.
# This applies equally to stdin and to a standalone install.sh that the
# operator downloaded and verified before execution.
if [[ "$install_entry_is_stream" -eq 1 || \
  ( "$install_entry_hosting" -eq 1 && -z "$install_entry_verified_bundle" ) ]]; then
  install_repo_url="${FASED_INSTALL_REPO:-https://github.com/fased-ai/fased.git}"
  install_base_dir="${FASED_INSTALL_DIR:-$HOME/fased}"
  auto_install=1
  hosting_bootstrap=0
  hosting_repair_bootstrap=0
  hosting_release=""
  verified_hosting_bundle=""
  args=("$@")

  for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[$i]}" in
      --install-dir)
        if (( i + 1 >= ${#args[@]} )); then
          echo "Missing value for --install-dir" >&2
          exit 1
        fi
        install_base_dir="${args[$((i + 1))]}"
        ;;
      --no-auto-install)
        auto_install=0
        ;;
      --hosting)
        hosting_bootstrap=1
        ;;
      --repair-hosting)
        hosting_bootstrap=1
        hosting_repair_bootstrap=1
        ;;
      --host-profile)
        if (( i + 1 < ${#args[@]} )) && [[ "${args[$((i + 1))]}" == "hosting" ]]; then
          hosting_bootstrap=1
        fi
        ;;
      --release)
        if (( i + 1 >= ${#args[@]} )); then
          echo "Missing value for --release" >&2
          exit 1
        fi
        hosting_release="${args[$((i + 1))]}"
        ;;
      --verified-hosting-bundle)
        if (( i + 1 >= ${#args[@]} )); then
          echo "Missing value for --verified-hosting-bundle" >&2
          exit 1
        fi
        verified_hosting_bundle="${args[$((i + 1))]}"
        ;;
    esac
  done

  if [[ "$install_entry_is_stream" -eq 1 && "$hosting_bootstrap" -eq 1 && "$hosting_repair_bootstrap" -eq 0 && -z "$hosting_release" ]]; then
    hosting_release="latest"
  fi

  bootstrap_as_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
      "$@"
      return
    fi
    if command -v sudo >/dev/null 2>&1; then
      sudo "$@"
      return
    fi
    echo "Administrator access is required to install bootstrap dependencies." >&2
    return 1
  }

  install_current_github_cli_bootstrap() {
    if command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1; then
      return 0
    fi
    [[ "$auto_install" -eq 1 ]] || return 1
    if command -v apt-get >/dev/null 2>&1; then
      bootstrap_as_root apt-get update
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
      local keyring_tmp=""
      local source_tmp=""
      keyring_tmp="$(mktemp)"
      source_tmp="$(mktemp)"
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$keyring_tmp"
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" >"$source_tmp"
      bootstrap_as_root install -d -m 0755 /etc/apt/keyrings
      bootstrap_as_root install -m 0644 "$keyring_tmp" /etc/apt/keyrings/githubcli-archive-keyring.gpg
      bootstrap_as_root install -m 0644 "$source_tmp" /etc/apt/sources.list.d/github-cli.list
      rm -f -- "$keyring_tmp" "$source_tmp"
      bootstrap_as_root apt-get update
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y gh
    elif command -v dnf >/dev/null 2>&1 || command -v dnf5 >/dev/null 2>&1; then
      local dnf_cmd="dnf"
      command -v dnf >/dev/null 2>&1 || dnf_cmd="dnf5"
      bootstrap_as_root "$dnf_cmd" install -y 'dnf-command(config-manager)' >/dev/null 2>&1 || true
      bootstrap_as_root "$dnf_cmd" config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null 2>&1 || true
      bootstrap_as_root "$dnf_cmd" install -y gh
    elif command -v yum >/dev/null 2>&1; then
      bootstrap_as_root yum install -y yum-utils >/dev/null 2>&1 || true
      bootstrap_as_root yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null 2>&1 || true
      bootstrap_as_root yum install -y gh
    elif command -v zypper >/dev/null 2>&1; then
      bootstrap_as_root zypper --non-interactive install gh
    elif command -v apk >/dev/null 2>&1; then
      bootstrap_as_root apk add --no-cache github-cli
    elif command -v pacman >/dev/null 2>&1; then
      bootstrap_as_root pacman -Sy --needed --noconfirm github-cli
    elif command -v brew >/dev/null 2>&1; then
      brew install gh || brew upgrade gh
    else
      return 1
    fi
    hash -r 2>/dev/null || true
    command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1
  }

  resolve_public_latest_release_tag() {
    curl -fsSL --proto '=https' --tlsv1.2 \
      -H 'Accept: application/vnd.github+json' \
      -H 'X-GitHub-Api-Version: 2022-11-28' \
      -H 'User-Agent: fased-installer' \
      https://api.github.com/repos/fased-ai/fased/releases/latest \
      | jq -er '.tag_name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))'
  }

  bootstrap_hosting_attested_bundle() {
    if [[ "$(id -u)" -ne 0 ]]; then
      echo "VPS Hosting bootstrap must start in the provider's root console." >&2
      echo "Do not grant the Fased app account sudo access." >&2
      exit 1
    fi
    if [[ -n "$verified_hosting_bundle" ]]; then
      echo "Refusing a caller-supplied verified bundle marker." >&2
      exit 1
    fi
    if [[ -z "$hosting_release" ]]; then
      echo "VPS Hosting requires an explicit tagged release." >&2
      echo "Pass --release vX.Y.Z (recommended) or --release latest." >&2
      exit 1
    fi

    install_hosting_bootstrap_tools() {
      [[ "$auto_install" -eq 1 ]] || return 0
      if command -v apt-get >/dev/null 2>&1; then
        apt-get update
        env DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates tar coreutils findutils gawk jq util-linux
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y curl ca-certificates tar coreutils findutils gawk jq util-linux
      elif command -v dnf5 >/dev/null 2>&1; then
        dnf5 install -y curl ca-certificates tar coreutils findutils gawk jq util-linux
      elif command -v yum >/dev/null 2>&1; then
        yum install -y curl ca-certificates tar coreutils findutils gawk jq util-linux
      elif command -v zypper >/dev/null 2>&1; then
        zypper --non-interactive install curl ca-certificates tar coreutils findutils gawk jq util-linux
      fi
    }
    if ! command -v gh >/dev/null 2>&1 || ! gh attestation verify --help >/dev/null 2>&1; then
      install_hosting_bootstrap_tools
      install_current_github_cli_bootstrap
    fi
    for command in curl tar sha256sum awk jq stat find grep flock; do
      if ! command -v "$command" >/dev/null 2>&1; then
        echo "Missing required Hosting bootstrap command: $command" >&2
        echo "Install curl, jq, tar, coreutils, and findutils from the provider console, then retry." >&2
        exit 1
      fi
    done
    if ! command -v gh >/dev/null 2>&1 || ! gh attestation verify --help >/dev/null 2>&1; then
      echo "GitHub CLI with 'gh attestation verify' is required before privileged Hosting setup." >&2
      echo "Install GitHub CLI from the provider console, then retry the exact release command." >&2
      exit 1
    fi

    local release_version="${hosting_release#v}"
    if [[ "$hosting_release" == "latest" ]]; then
      local latest_tag=""
      latest_tag="$(resolve_public_latest_release_tag 2>/dev/null || true)"
      release_version="${latest_tag#v}"
    fi
    if [[ ! "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Hosting release must resolve to a stable vX.Y.Z GitHub release." >&2
      exit 1
    fi

    local architecture=""
    case "$(uname -m)" in
      x86_64|amd64) architecture="x64" ;;
      aarch64|arm64) architecture="arm64" ;;
      *)
        echo "Unsupported Hosting architecture: $(uname -m)" >&2
        exit 1
        ;;
    esac
    local asset="fased-hosted-app-linux-${architecture}-v${release_version}.tar.gz"
    local release_url="https://github.com/fased-ai/fased/releases/download/v${release_version}"
    local release_parent="/var/lib/fased-installer/releases/v${release_version}"
    local staging="${release_parent}/.staging.$$"
    local preflight=""
    preflight="$(mktemp -d "${TMPDIR:-/tmp}/fased-hosting-bootstrap.XXXXXX")"
    local archive="${preflight}/${asset}"
    local release_manifest="${preflight}/fased-hosted-release-v2.json"
    local expected=""
    local actual=""
    local manifest_digest=""
    local manifest_commit=""
    local manifest_signer_commit=""

    umask 077
    trap 'rm -rf -- "${preflight:-}" "${staging:-}"' EXIT
    curl -fL --proto '=https' --tlsv1.2 "$release_url/fased-hosted-release-v2.json" -o "$release_manifest"
    GH_PROMPT_DISABLED=1 gh attestation verify "$release_manifest" \
      --repo fased-ai/fased \
      --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
      --source-ref "refs/tags/v${release_version}" \
      --deny-self-hosted-runners >/dev/null
    local manifest_selection=""
    manifest_selection="$(jq -er --arg version "$release_version" --arg architecture "$architecture" '
      if .schemaVersion == 2 and
        (.release.version == $version) and (.release.tag == ("v" + $version)) and
        (.release.commit | test("^[a-f0-9]{40}$")) and
        (.signer.release.version == $version) and
        (.signer.release.commit == .release.commit) and
        (.signer.release.development == false) and
        (.signer.release.buildInputDigest | test("^sha256:[a-f0-9]{64}$")) and
        (.application.linux[$architecture].artifact.asset | test("^[A-Za-z0-9][A-Za-z0-9._-]+$")) and
        (.application.linux[$architecture].artifact.sha256 | test("^[a-f0-9]{64}$"))
      then [
        .release.commit,
        .signer.release.commit,
        .application.linux[$architecture].artifact.asset,
        .application.linux[$architecture].artifact.sha256
      ] | @tsv
      else error("invalid hosted release manifest") end
    ' "$release_manifest")" || {
      echo "Hosted release manifest does not bind this exact app and signer release." >&2
      exit 1
    }
    IFS=$'\t' read -r manifest_commit manifest_signer_commit asset expected <<<"$manifest_selection"
    [[ "$manifest_commit" == "$manifest_signer_commit" && "$asset" == "fased-hosted-app-linux-${architecture}-v${release_version}.tar.gz" ]] || {
      echo "Hosted release manifest selects a mixed commit or unexpected app artifact." >&2
      exit 1
    }
    archive="${preflight}/${asset}"
    curl -fL --proto '=https' --tlsv1.2 "$release_url/$asset" -o "$archive"
    actual="$(sha256sum "$archive" | awk '{print tolower($1)}')"
    manifest_digest="$(sha256sum "$release_manifest" | awk '{print tolower($1)}')"
    if [[ ! "$expected" =~ ^[a-f0-9]{64}$ || "$actual" != "$expected" ]]; then
      echo "Hosted release checksum verification failed." >&2
      exit 1
    fi
    GH_PROMPT_DISABLED=1 gh attestation verify "$archive" \
      --repo fased-ai/fased \
      --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
      --source-ref "refs/tags/v${release_version}" \
      --deny-self-hosted-runners >/dev/null
    # Only after the exact unified manifest and selected app artifact are both
    # attested and digest-bound may the bootstrap create persistent root state.
    install -d -m 0700 -o root -g root /var/lib/fased-installer /var/lib/fased-installer/releases "$release_parent"
    exec 9>/var/lib/fased-installer/install.lock
    chmod 0600 /var/lib/fased-installer/install.lock
    flock -x 9
    rm -rf -- "$staging"
    install -d -m 0700 -o root -g root "$staging"
    local root_store="${release_parent}/${actual}"
    local existing_root="${root_store}/extract/package"
    local existing_commit=""
    if [[ -f "$existing_root/dist/build-info.json" && ! -L "$existing_root/dist/build-info.json" ]]; then
      existing_commit="$(awk -F'"' '/^[[:space:]]*"commit"[[:space:]]*:/ { print $4; exit }' "$existing_root/dist/build-info.json")"
    fi
    if [[ -f "$existing_root/.fased-hosting-bundle-verified" && \
      ! -L "$existing_root/.fased-hosting-bundle-verified" ]] && \
      grep -Fxq "version=${release_version}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "sha256=${actual}" "$existing_root/.fased-hosting-bundle-verified" && \
      grep -Fxq "release_manifest_sha256=${manifest_digest}" "$existing_root/.fased-hosting-bundle-verified" && \
      [[ "$existing_commit" =~ ^[a-f0-9]{40}$ ]] && \
      grep -Fxq "commit=${existing_commit}" "$existing_root/.fased-hosting-bundle-verified" && \
      ! find "$root_store" -xdev \( ! -user root -o -perm /022 \) -print -quit | grep -q . && \
      ! find "$existing_root" -xdev ! -type f ! -type d -print -quit | grep -q . && \
      ! find "$existing_root" -xdev -type f -links +1 -print -quit | grep -q .; then
      rm -rf -- "$staging"
      rm -rf -- "$preflight"
      trap - EXIT
      flock -u 9
      exec 9>&-
      echo "Reusing verified tagged Hosting bundle v${release_version} (${actual})."
      exec bash "$existing_root/install.sh" "$@" \
        --release "$release_version" \
        --verified-hosting-bundle "$existing_root"
    fi
    if [[ -e "$root_store" ]]; then
      echo "An existing Hosting bundle at ${root_store} failed immutable verification; refusing to replace it." >&2
      echo "Inspect or quarantine it from the provider root console, then retry." >&2
      exit 1
    fi

    local entry=""
    while IFS= read -r entry; do
      entry="${entry%/}"
      if [[ -z "$entry" || "$entry" == /* || "$entry" == *\\* || \
        ( "$entry" != "package" && "$entry" != package/* ) || \
        "$entry" == *"/../"* || "$entry" == ../* || "$entry" == */.. || \
        "$entry" == *"/./"* || "$entry" == ./* || "$entry" == */. ]]; then
        echo "Hosted release archive contains an unsafe path: $entry" >&2
        exit 1
      fi
    done < <(tar -tzf "$archive")

    install -d -m 0700 -o root -g root "$staging/extract"
    tar -xzf "$archive" -C "$staging/extract" --no-same-owner --no-same-permissions
    local package_root="$staging/extract/package"
    [[ -f "$package_root/install.sh" && -f "$package_root/package.json" && ! -L "$package_root/install.sh" ]] || {
      echo "Attested Hosting bundle is incomplete." >&2
      exit 1
    }
    local packaged_version=""
    packaged_version="$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "$package_root/package.json")"
    [[ "$packaged_version" == "$release_version" ]] || {
      echo "Attested Hosting bundle version does not match v${release_version}." >&2
      exit 1
    }
    [[ -f "$package_root/dist/build-info.json" && ! -L "$package_root/dist/build-info.json" ]] || {
      echo "Attested Hosting bundle is missing immutable build identity." >&2
      exit 1
    }
    local packaged_commit=""
    local build_info_version=""
    packaged_commit="$(awk -F'"' '/^[[:space:]]*"commit"[[:space:]]*:/ { print $4; exit }' "$package_root/dist/build-info.json")"
    build_info_version="$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "$package_root/dist/build-info.json")"
    [[ "$packaged_commit" =~ ^[a-f0-9]{40}$ && "$build_info_version" == "$release_version" ]] || {
      echo "Attested Hosting bundle build identity is invalid or does not match v${release_version}." >&2
      exit 1
    }
    [[ "$packaged_commit" == "$manifest_commit" ]] || {
      echo "Attested Hosting application commit does not match the unified release manifest." >&2
      exit 1
    }
    if find "$package_root" -xdev ! -type f ! -type d -print -quit | grep -q . || \
      find "$package_root" -xdev -type f -links +1 -print -quit | grep -q .; then
      echo "Attested Hosting bundle contains a symlink, special file, or hardlinked regular file." >&2
      exit 1
    fi
    chown -R root:root "$staging"
    chmod -R go-w "$staging"
    if find "$staging" -xdev \( ! -user root -o -perm /022 \) -print -quit | grep -q .; then
      echo "Could not secure the verified Hosting bundle as root-owned and non-writable." >&2
      exit 1
    fi
    printf 'version=%s\nsha256=%s\nrelease_manifest_sha256=%s\ncommit=%s\n' \
      "$release_version" "$actual" "$manifest_digest" "$packaged_commit" >"$package_root/.fased-hosting-bundle-verified"
    chmod 0600 "$package_root/.fased-hosting-bundle-verified"
    sync -f "$package_root/.fased-hosting-bundle-verified" "$package_root" "$staging/extract" 2>/dev/null || true
    mv "$staging" "$root_store"
    rm -rf -- "$preflight"
    trap - EXIT
    flock -u 9
    exec 9>&-

    local final_root="$root_store/extract/package"
    echo "Verified tagged Hosting bundle v${release_version}; entering the root-owned installer."
    exec bash "$final_root/install.sh" "$@" \
      --release "$release_version" \
      --verified-hosting-bundle "$final_root"
  }

  if [[ "$hosting_bootstrap" -eq 1 ]]; then
    bootstrap_hosting_attested_bundle "$@"
  fi

  run_as_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
      "$@"
    elif command -v sudo >/dev/null 2>&1; then
      sudo "$@"
    else
      echo "Missing required command: git" >&2
      echo "Install git, or rerun on a host where sudo is available." >&2
      exit 1
    fi
  }

  install_bootstrap_git() {
    if [[ "$auto_install" -ne 1 ]]; then
      return 1
    fi
    if command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root apt-get install -y git curl ca-certificates
    elif command -v dnf >/dev/null 2>&1; then
      run_as_root dnf install -y git curl ca-certificates
    elif command -v yum >/dev/null 2>&1; then
      run_as_root yum install -y git curl ca-certificates
    elif command -v zypper >/dev/null 2>&1; then
      run_as_root zypper --non-interactive install git curl ca-certificates
    elif command -v apk >/dev/null 2>&1; then
      run_as_root apk add --no-cache bash git curl ca-certificates
    elif command -v pacman >/dev/null 2>&1; then
      run_as_root pacman -Sy --noconfirm git curl ca-certificates
    elif command -v pkg >/dev/null 2>&1; then
      run_as_root pkg install -y bash git curl ca_root_nss
    elif command -v brew >/dev/null 2>&1; then
      brew install git
    else
      return 1
    fi
  }

  install_local_release_verification_tools() {
    if command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$auto_install" -ne 1 ]]; then
      return 1
    fi
    if command -v apt-get >/dev/null 2>&1; then
      bootstrap_as_root apt-get update
      bootstrap_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y jq curl ca-certificates
    elif command -v dnf >/dev/null 2>&1; then
      bootstrap_as_root dnf install -y jq curl ca-certificates
    elif command -v dnf5 >/dev/null 2>&1; then
      bootstrap_as_root dnf5 install -y jq curl ca-certificates
    elif command -v yum >/dev/null 2>&1; then
      bootstrap_as_root yum install -y jq curl ca-certificates
    elif command -v zypper >/dev/null 2>&1; then
      bootstrap_as_root zypper --non-interactive install jq curl ca-certificates
    elif command -v apk >/dev/null 2>&1; then
      bootstrap_as_root apk add --no-cache jq curl ca-certificates
    elif command -v pacman >/dev/null 2>&1; then
      bootstrap_as_root pacman -Sy --needed --noconfirm jq curl ca-certificates
    elif command -v brew >/dev/null 2>&1; then
      brew install jq || brew upgrade jq
    else
      return 1
    fi
    install_current_github_cli_bootstrap || return 1
    hash -r 2>/dev/null || true
    command -v gh >/dev/null 2>&1 && gh attestation verify --help >/dev/null 2>&1 && command -v jq >/dev/null 2>&1
  }

  resolve_attested_local_release_commit() {
    local release_version="$1"
    install_local_release_verification_tools || {
      echo "Exact Local repair requires GitHub CLI with attestation support and jq." >&2
      echo "Install current gh and jq, then rerun the exact release command." >&2
      return 1
    }
    local release_url="https://github.com/fased-ai/fased/releases/download/v${release_version}"
    local verification_dir=""
    verification_dir="$(mktemp -d "${TMPDIR:-/tmp}/fased-local-release.XXXXXX")"
    chmod 0700 "$verification_dir"
    local manifest="$verification_dir/fased-hosted-release-v2.json"
    local bundle="$verification_dir/fased-hosted-release-v2.json.attestation.json"
    curl -fL --proto '=https' --tlsv1.2 "$release_url/fased-hosted-release-v2.json" -o "$manifest"
    curl -fL --proto '=https' --tlsv1.2 "$release_url/fased-hosted-release-v2.json.attestation.json" -o "$bundle"
    GH_PROMPT_DISABLED=1 gh attestation verify "$manifest" \
      --repo fased-ai/fased \
      --bundle "$bundle" \
      --signer-workflow fased-ai/fased/.github/workflows/hosted-runtime-release.yml \
      --source-ref "refs/tags/v${release_version}" \
      --deny-self-hosted-runners >/dev/null
    local release_commit=""
    release_commit="$(jq -er --arg version "$release_version" '
      if .schemaVersion == 2 and
        .release.version == $version and
        .release.tag == ("v" + $version) and
        (.release.commit | test("^[a-f0-9]{40}$")) and
        .signer.release.version == $version and
        .signer.release.commit == .release.commit and
        .signer.release.development == false
      then .release.commit
      else error("invalid unified release manifest") end
    ' "$manifest")" || {
      rm -rf -- "$verification_dir"
      echo "Attested release manifest does not bind one exact Local source commit." >&2
      return 1
    }
    rm -rf -- "$verification_dir"
    printf '%s\n' "$release_commit"
  }

  if ! command -v git >/dev/null 2>&1; then
    echo "git is missing; installing bootstrap dependencies first."
    install_bootstrap_git || {
      echo "git is required to bootstrap the repository checkout." >&2
      exit 1
    }
    hash -r 2>/dev/null || true
  fi

  local_bootstrap_release=""
  local_bootstrap_commit=""
  if [[ "$hosting_bootstrap" -eq 0 && -z "$hosting_release" ]]; then
    install_local_release_verification_tools || {
      echo "Local install requires GitHub CLI with attestation support and jq." >&2
      echo "Install current gh and jq, then rerun the installer." >&2
      exit 1
    }
    latest_local_tag="$(resolve_public_latest_release_tag 2>/dev/null || true)"
    if [[ ! "$latest_local_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Could not resolve one stable tagged Local release." >&2
      exit 1
    fi
    hosting_release="$latest_local_tag"
  fi
  if [[ "$hosting_bootstrap" -eq 0 && -n "$hosting_release" ]]; then
    local_bootstrap_release="${hosting_release#v}"
    if [[ ! "$local_bootstrap_release" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Local --release requires one exact stable vX.Y.Z version." >&2
      exit 1
    fi
    local_bootstrap_commit="$(resolve_attested_local_release_commit "$local_bootstrap_release")"
    if [[ ! "$local_bootstrap_commit" =~ ^[a-f0-9]{40}$ ]]; then
      echo "Could not resolve the attested Local release commit." >&2
      exit 1
    fi
  fi

  if [[ ! -e "$install_base_dir" ]]; then
    mkdir -p "$(dirname "$install_base_dir")"
    if [[ -n "$local_bootstrap_release" ]]; then
      git clone --no-checkout "$install_repo_url" "$install_base_dir"
    else
      git clone "$install_repo_url" "$install_base_dir"
    fi
  elif [[ -d "$install_base_dir/.git" ]]; then
    if [[ -z "$local_bootstrap_release" ]]; then
      git -C "$install_base_dir" pull --ff-only origin main
    fi
  else
    echo "Refusing to overwrite existing path: $install_base_dir" >&2
    echo "Set --install-dir to a new directory or clean the existing one, then rerun." >&2
    exit 1
  fi

  if [[ -n "$local_bootstrap_release" ]]; then
    git -C "$install_base_dir" fetch --force origin \
      "refs/tags/v${local_bootstrap_release}:refs/fased-installer/v${local_bootstrap_release}"
    local fetched_release_commit=""
    fetched_release_commit="$(git -C "$install_base_dir" rev-parse "refs/fased-installer/v${local_bootstrap_release}^{commit}")"
    if [[ "$fetched_release_commit" != "$local_bootstrap_commit" ]]; then
      echo "Release tag commit does not match the attested unified release manifest." >&2
      exit 1
    fi
    git -C "$install_base_dir" checkout --detach "$local_bootstrap_commit"
    if [[ "$(git -C "$install_base_dir" rev-parse HEAD)" != "$local_bootstrap_commit" ]]; then
      echo "Local release checkout did not land on the attested commit." >&2
      exit 1
    fi
  fi

  if ( : < /dev/tty ) 2>/dev/null; then
    exec bash "$install_base_dir/install.sh" "$@" < /dev/tty
  fi
  exec bash "$install_base_dir/install.sh" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FASED_DIR="$SCRIPT_DIR"
EARLY_HOSTING_REQUESTED=0
EARLY_HOSTING_RELEASE=""
EARLY_VERIFIED_HOSTING_BUNDLE=""
EARLY_ARGS=("$@")
for ((early_index = 0; early_index < ${#EARLY_ARGS[@]}; early_index++)); do
  case "${EARLY_ARGS[$early_index]}" in
    --hosting|--repair-hosting) EARLY_HOSTING_REQUESTED=1 ;;
    --host-profile)
      [[ "${EARLY_ARGS[$((early_index + 1))]:-}" == "hosting" ]] && EARLY_HOSTING_REQUESTED=1
      ;;
    --release) EARLY_HOSTING_RELEASE="${EARLY_ARGS[$((early_index + 1))]:-}" ;;
    --verified-hosting-bundle)
      EARLY_VERIFIED_HOSTING_BUNDLE="${EARLY_ARGS[$((early_index + 1))]:-}"
      ;;
  esac
done
if [[ "$(id -u)" -eq 0 && "$EARLY_HOSTING_REQUESTED" -eq 1 ]]; then
  EARLY_HOSTING_RELEASE="${EARLY_HOSTING_RELEASE#v}"
  early_source="$(readlink -f "$FASED_DIR" 2>/dev/null || true)"
  early_bundle="$(readlink -f "$EARLY_VERIFIED_HOSTING_BUNDLE" 2>/dev/null || true)"
  if [[ ! "$EARLY_HOSTING_RELEASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || \
    -z "$early_source" || "$early_source" != "$early_bundle" || \
    ! "$early_source" =~ ^/var/lib/fased-installer/releases/v${EARLY_HOSTING_RELEASE}/[a-f0-9]{64}/extract/package$ || \
    -e "$early_source/.git" || ! -f "$early_source/.fased-hosting-bundle-verified" || \
    -L "$early_source/.fased-hosting-bundle-verified" || \
    "$(stat -c '%u:%a:%h' "$early_source/.fased-hosting-bundle-verified" 2>/dev/null || true)" != "0:600:1" ]] || \
    find "$early_source" -xdev \( ! -user root -o -perm /022 \) -print -quit | grep -q . || \
    find "$early_source" -xdev ! -type f ! -type d -print -quit | grep -q . || \
    find "$early_source" -xdev -type f -links +1 -print -quit | grep -q .; then
    echo "Refusing to load privileged Hosting assets from an app-owned, Git, dirty, writable, or unverified source tree." >&2
    echo "Start from the provider root console with the exact tagged, attested Hosting bootstrap." >&2
    exit 1
  fi
fi
# shellcheck source=scripts/install-runtime-profile.sh
. "$FASED_DIR/scripts/install-runtime-profile.sh"
SAT_RUNTIME_ENV_FILE="${FASED_SAT_RUNTIME_ENV_FILE:-$FASED_DIR/config/sat-runtime.env}"
INSTALL_REPO_URL="${FASED_INSTALL_REPO:-https://github.com/fased-ai/fased.git}"
INSTALL_BASE_DIR="${FASED_INSTALL_DIR:-$HOME/fased}"
FASED_STATE_DIR_EXPLICIT="${FASED_STATE_DIR+x}"
FASED_CONFIG_DIR_EXPLICIT="${FASED_CONFIG_DIR+x}"
FASED_CONFIG_PATH_EXPLICIT="${FASED_CONFIG_PATH+x}"
FASED_CONFIG_DIR="${FASED_CONFIG_DIR:-${FASED_STATE_DIR:-$HOME/.fased}}"
INSTALL_MARKER_PATH="$FASED_CONFIG_DIR/install-complete.json"
INSTALL_CACHE_DIR="$FASED_CONFIG_DIR/install-cache"
INSTALL_LOG_DIR="$FASED_CONFIG_DIR/logs"
INSTALL_VERBOSE="${FASED_INSTALL_VERBOSE:-0}"
INSTALL_GIT_UPDATE="${FASED_INSTALL_GIT_UPDATE:-1}"
RELEASE_NPM_PACKAGE="${FASED_RUNTIME_NPM_PACKAGE:-${FASED_HOSTING_NPM_PACKAGE:-@fased/fased@latest}}"
AUTO_INSTALL=1
RUN_ONBOARD=1
HOSTING_REQUESTED=0
HOSTING_REPAIR_REQUESTED=0
LOCAL_REPAIR_REQUESTED=0
SOURCE_INSTALL_REQUESTED=0
HOSTING_RELEASE=""
VERIFIED_HOSTING_BUNDLE=""
TAILSCALE_AUTHKEY_FILE=""
REQUESTED_SWAP_GB=""
FASED_CLI_PATH=""
PREBUILT_RUNTIME_INSTALLED=0
GATEWAY_SERVICE_REFRESHED=0
GATEWAY_RUNTIME_HEALTH_VERIFIED=0
LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=0
HOST_SIGNER_TRANSACTION_ACTIVE=0
HOST_SIGNER_DURABLE_COMMIT_DECISION=0
HOST_SIGNER_TRANSACTION_ID=""
HOST_SIGNER_TRANSACTION_VERSION=""
LOW_MEMORY_SWAP_THRESHOLD_MB=2304
LOW_MEMORY_SWAP_GB=4
HOSTING_SWAP_GB=2

rollback_pending_host_signer_transaction_on_exit() {
  local captured_status=$?
  local status="${1:-$captured_status}"
  trap - EXIT
  if [[ "$HOST_SIGNER_TRANSACTION_ACTIVE" -eq 1 && -n "$HOST_SIGNER_TRANSACTION_VERSION" ]]; then
    if [[ "$HOST_SIGNER_DURABLE_COMMIT_DECISION" -eq 1 ]]; then
      echo "Hosted health passed; completing the durable signer commit decision..." >&2
      if node /usr/local/libexec/fased-host-updaterctl.mjs \
        "$HOST_SIGNER_TRANSACTION_VERSION" --commit-only >/dev/null; then
        HOST_SIGNER_TRANSACTION_ACTIVE=0
      else
        echo "Signer commit cleanup remains pending. Rerun the exact tagged repair from the provider root console; never run an app-owned checkout as root." >&2
        status=1
      fi
    else
      echo "Hosted install did not commit; restoring the previous signer transaction..." >&2
      if ! node /usr/local/libexec/fased-host-updaterctl.mjs \
        "$HOST_SIGNER_TRANSACTION_VERSION" --rollback-only >/dev/null; then
        echo "Signer rollback remains pending. Rerun the exact tagged repair from the provider root console; never run an app-owned checkout as root." >&2
        status=1
      fi
      local target_user="${FASED_INSTALL_USER:-app}"
      local target_home
      target_home="$(getent passwd "$target_user" 2>/dev/null | cut -d: -f6)"
      [[ -n "$target_home" ]] || target_home="/home/$target_user"
      if [[ ! -f "$target_home/.fased/hosted-update-transaction.json" ]] && \
        systemctl list-unit-files fased-gateway.service --no-legend 2>/dev/null | grep -q '^fased-gateway.service'; then
        systemctl start fased-gateway.service >/dev/null 2>&1 || status=1
      fi
    fi
  fi
  exit "$status"
}

ORIGINAL_INSTALL_ARGS=("$@")
pass_args=()

supports_color() {
  if [[ "${FORCE_COLOR:-}" == "0" ]]; then
    return 1
  fi
  if [[ -n "${NO_COLOR:-}" && "${FORCE_COLOR:-}" != "1" ]]; then
    return 1
  fi
  [[ -t 1 || -n "${FORCE_COLOR:-}" ]]
}

if supports_color; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_GRAY=$'\033[90m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_GRAY=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
fi

color_cyan() { printf '%s%s%s' "$C_CYAN" "$1" "$C_RESET"; }
color_green() { printf '%s%s%s' "$C_GREEN" "$1" "$C_RESET"; }
color_yellow() { printf '%s%s%s' "$C_YELLOW" "$1" "$C_RESET"; }
color_red() { printf '%s%s%s' "$C_RED" "$1" "$C_RESET"; }
color_dim() { printf '%s%s%s' "$C_DIM" "$1" "$C_RESET"; }
color_gray() { printf '%s%s%s' "$C_GRAY" "$1" "$C_RESET"; }

INSTALL_BLOCK_CONTENT_WIDTH=72
INSTALL_STATUS_FRAME_OPEN=0
INSTALL_STATUS_SECTION_COUNT=0

repeat_char() {
  local char="$1"
  local count="$2"
  local out=""
  local i
  for ((i = 0; i < count; i++)); do
    out+="$char"
  done
  printf '%s' "$out"
}

visible_length() {
  printf '%s' "$1" | sed -E $'s/\x1B\\[[0-9;]*[A-Za-z]//g' | wc -m | tr -d ' '
}

block_top() {
  local title="$1"
  local title_width
  local rule_width
  title_width="$(visible_length "$title")"
  rule_width=$((INSTALL_BLOCK_CONTENT_WIDTH + 2 - title_width - 3))
  if (( rule_width < 0 )); then
    rule_width=0
  fi
  printf '\n  %s%s%s%s%s\n' \
    "$(color_gray "╭─ ")" \
    "$(color_gray "${C_BOLD}${title}${C_RESET}")" \
    "$(color_gray " ")" \
    "$(color_gray "$(repeat_char "─" "$rule_width")")" \
    "$(color_gray "╮")"
}

block_line() {
  local text="${1:-}"
  local width
  local padding
  width="$(visible_length "$text")"
  padding=$((INSTALL_BLOCK_CONTENT_WIDTH - width))
  if (( padding < 0 )); then
    padding=0
  fi
  printf '  %s %s%s %s\n' \
    "$(color_gray "│")" \
    "$text" \
    "$(repeat_char " " "$padding")" \
    "$(color_gray "│")"
}

block_bottom() {
  printf '  %s\n' "$(color_gray "╰$(repeat_char "─" $((INSTALL_BLOCK_CONTENT_WIDTH + 2)))╯")"
}

status_frame_start() {
  block_top "INSTALLER STATUS"
  INSTALL_STATUS_FRAME_OPEN=1
  INSTALL_STATUS_SECTION_COUNT=0
}

status_frame_end() {
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    block_bottom
    INSTALL_STATUS_FRAME_OPEN=0
    printf '\n'
  fi
}

print_installer_banner() {
  local version="$1"
  local profile="Local"
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    profile="VPS Hosting"
  fi
  block_top "FASED AGENT"
  block_line
  block_line "$(color_gray "  _____   _     ____   _____  ____")"
  block_line "$(color_gray " |  ___| / \\   / ___| | ____||  _ \\")"
  block_line "$(color_gray " | |_   / _ \\  \\___ \\ |  _|  | | | |")"
  block_line "$(color_gray " |  _| / ___ \\  ___) || |___ | |_| |")"
  block_line "$(color_gray " |_|  /_/   \\_\\|____/ |_____||____/")"
  block_line
  block_line "Fased Agent v${version}"
  block_line "$(color_yellow "Mode")  ${profile}"
  block_line "$(color_yellow "Logs")  ${INSTALL_LOG_DIR}"
  block_line
  block_bottom
}

section() {
  local label="$1"
  local display="${label^^}"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    if [[ "$INSTALL_STATUS_SECTION_COUNT" -gt 0 ]]; then
      block_line
    fi
    block_line "$(color_yellow "${C_BOLD}${display}${C_RESET}")"
    INSTALL_STATUS_SECTION_COUNT=$((INSTALL_STATUS_SECTION_COUNT + 1))
  else
    printf '\n%s\n' "$(color_gray "${C_BOLD}${display}${C_RESET}")"
  fi
}

if [[ -f "$SAT_RUNTIME_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  . "$SAT_RUNTIME_ENV_FILE"
  set +a
fi

usage() {
  cat <<'USAGE'
Fased installer (single path): install.sh -> fased onboard --install-daemon

Usage: ./install.sh [options] [-- <extra onboard args>]

Options:
  --auto-install   install missing deps with apt/dnf/yum/zypper/apk/pacman/pkg or Homebrew (default)
  --no-auto-install  Disable automatic dependency installation
  --install-dir <path>  Checkout/install directory (default: $HOME/fased)
  --hosting       VPS/always-on server profile. Requires Tailscale; applies hosted
                  onboarding defaults and may change SSH/firewall behavior.
  --repair-hosting  Repair an existing VPS runtime and root-managed gateway service
                  without rerunning onboarding or changing persistent user state.
  --release <vX.Y.Z|latest>  Pin a Local repair to vX.Y.Z. Required for VPS Hosting;
                  its root phase runs only from the exact attested tagged bundle.
  --ts-authkey-file <path>  Read a Tailscale auth key from a root-owned mode-0600
                  file. The secret is copied to a one-use /run file, never argv.
  --repair-local  Repair an existing Linux Local or WSL runtime and user Gateway
                  service without rerunning onboarding or changing user state.
  --local         Laptop/desktop profile. Tailscale is optional; on a VPS this does
                  not apply hosting SSH/firewall hardening.
  --source-install  Build from the checkout instead of using the verified Linux
                  release runtime. Intended for contributors and source testing.
  --swap-gb <n>   Override automatic install-time swap size on small Linux hosts
  --no-git-update  Do not fast-forward the checkout from origin before install
  --no-onboard     Skip running onboard (install deps only)
  --verbose       Show build/install command output instead of logging it
  -h, --help       Show this help

All other args are forwarded to:
  fased onboard --install-daemon ...

Remote client mode only connects to an existing Gateway. To use it, install
the CLI and run or pass: fased onboard --mode remote
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto-install)
      AUTO_INSTALL=1
      ;;
    --no-auto-install)
      AUTO_INSTALL=0
      ;;
    --install-dir)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --install-dir" >&2
        exit 1
      fi
      INSTALL_BASE_DIR="$1"
      ;;
    --hosting)
      HOSTING_REQUESTED=1
      pass_args+=(--mode local --host-profile hosting --gateway-bind loopback --tailscale serve)
      ;;
    --repair-hosting)
      HOSTING_REQUESTED=1
      HOSTING_REPAIR_REQUESTED=1
      RUN_ONBOARD=0
      pass_args+=(--mode local --host-profile hosting --gateway-bind loopback --tailscale serve)
      ;;
    --repair-local)
      LOCAL_REPAIR_REQUESTED=1
      RUN_ONBOARD=0
      pass_args+=(--mode local --host-profile local --tailscale off)
      ;;
    --local)
      pass_args+=(--mode local --host-profile local --tailscale off)
      ;;
    --source-install)
      SOURCE_INSTALL_REQUESTED=1
      ;;
    --release)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --release" >&2
        exit 1
      fi
      HOSTING_RELEASE="${1#v}"
      ;;
    --verified-hosting-bundle)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --verified-hosting-bundle" >&2
        exit 1
      fi
      VERIFIED_HOSTING_BUNDLE="$1"
      ;;
    --ts-authkey)
      echo "Refusing a Tailscale auth key in process arguments." >&2
      echo "Store the key in a root-owned mode-0600 file and pass --ts-authkey-file /root/path." >&2
      exit 1
      ;;
    --ts-authkey-file)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --ts-authkey-file" >&2
        exit 1
      fi
      TAILSCALE_AUTHKEY_FILE="$1"
      ;;
    --swap-gb)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --swap-gb" >&2
        exit 1
      fi
      REQUESTED_SWAP_GB="$1"
      pass_args+=(--swap-gb "$1")
      ;;
    --no-git-update)
      INSTALL_GIT_UPDATE=0
      ;;
    --no-onboard)
      RUN_ONBOARD=0
      ;;
    --verbose)
      INSTALL_VERBOSE=1
      ;;
    --host-security-capable)
      pass_args+=(--host-security-capable)
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        pass_args+=("$1")
        shift
      done
      break
      ;;
    *)
      pass_args+=("$1")
      ;;
  esac
  shift
done

for ((i = 0; i < ${#pass_args[@]}; i++)); do
  if [[ "${pass_args[$i]}" == "--host-profile" && "${pass_args[$((i + 1))]:-}" == "hosting" ]]; then
    HOSTING_REQUESTED=1
    break
  fi
done

is_windows_posix_shell() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

is_wsl_environment() {
  [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]] || return 1
  grep -Eqi '(microsoft|wsl)' /proc/sys/kernel/osrelease /proc/version 2>/dev/null
}

is_wsl2_environment() {
  is_wsl_environment || return 1
  uname -r 2>/dev/null | grep -Eqi '(microsoft-standard|wsl2)'
}

systemd_is_pid_one() {
  [[ "$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]')" == "systemd" ]] &&
    command -v systemctl >/dev/null 2>&1
}

validate_install_platform() {
  if is_windows_posix_shell; then
    cat >&2 <<'EOF_NATIVE_WINDOWS'
Native Windows Node.js, PowerShell, Git Bash, MSYS2, and Cygwin installs are not supported.
Fased and fased-signerd use Unix sockets. Install Ubuntu in WSL2, enable systemd,
open the Ubuntu terminal, and run the Fased installer there.
See: docs/platforms/windows.md
EOF_NATIVE_WINDOWS
    exit 1
  fi

  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    if [[ "$(uname -s 2>/dev/null || true)" != "Linux" ]]; then
      echo "--hosting requires a supported Linux VPS with systemd." >&2
      exit 1
    fi
    if is_wsl_environment; then
      echo "--hosting is for a Linux VPS, not WSL. Use --local inside WSL2." >&2
      exit 1
    fi
    if [[ "$(id -u)" -ne 0 ]]; then
      echo "--hosting must run as root so the isolated signer and Gateway services can be installed." >&2
      echo "Open the VPS provider's root console and follow the one-command Hosting guide:" >&2
      echo "  https://docs.fased.ai/install/vps" >&2
      echo "The Hosting bootstrap selects and verifies the tagged release before privileged Fased installation." >&2
      echo "Never run the app-owned checkout with sudo or grant the app account sudo access." >&2
      exit 1
    fi
    if ! systemd_is_pid_one; then
      echo "--hosting requires systemd as PID 1; no host changes were started." >&2
      echo "Use a supported VPS image with systemd, then rerun the installer." >&2
      exit 1
    fi
  elif is_wsl_environment; then
    if ! is_wsl2_environment; then
      echo "WSL1 is not supported. Convert this distribution to WSL2, then rerun inside Ubuntu." >&2
      echo "From PowerShell: wsl --set-version <DistributionName> 2" >&2
      exit 1
    fi
    if ! systemd_is_pid_one; then
      cat >&2 <<'EOF_WSL_SYSTEMD'
Fased on WSL2 requires systemd for reliable Gateway and signer startup.
Inside Ubuntu, add this to /etc/wsl.conf:
  [boot]
  systemd=true
Then run `wsl --shutdown` from PowerShell, reopen Ubuntu, and rerun the installer.
EOF_WSL_SYSTEMD
      exit 1
    fi
  fi
}

validate_install_platform

set_installer_state_dir() {
  local state_dir="$1"
  case "$state_dir" in
    "~")
      state_dir="$HOME"
      ;;
    "~/"*)
      state_dir="$HOME/${state_dir#"~/"}"
      ;;
  esac
  FASED_CONFIG_DIR="$state_dir"
  FASED_STATE_DIR="$state_dir"
  export FASED_CONFIG_DIR FASED_STATE_DIR
  if [[ -z "${FASED_CONFIG_PATH_EXPLICIT:-}" ]]; then
    FASED_CONFIG_PATH="$state_dir/fased.json"
    export FASED_CONFIG_PATH
  fi
  INSTALL_MARKER_PATH="$FASED_CONFIG_DIR/install-complete.json"
  INSTALL_CACHE_DIR="$FASED_CONFIG_DIR/install-cache"
  INSTALL_LOG_DIR="$FASED_CONFIG_DIR/logs"
}

backup_existing_local_file() {
  local file="$1"
  local suffix="$2"
  if [[ ! -e "$file" ]]; then
    return 0
  fi
  local backup="${file}.bak-${suffix}"
  local index=1
  while [[ -e "$backup" ]]; do
    backup="${file}.bak-${suffix}-${index}"
    index=$((index + 1))
  done
  mv "$file" "$backup"
  printf '%s\n' "$backup"
}

handle_existing_local_state() {
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    set_installer_state_dir "$FASED_CONFIG_DIR"
    return 0
  fi
  if [[ -n "${FASED_STATE_DIR_EXPLICIT:-}" || -n "${FASED_CONFIG_DIR_EXPLICIT:-}" ]]; then
    set_installer_state_dir "$FASED_CONFIG_DIR"
    return 0
  fi
  if [[ ! -d "$FASED_CONFIG_DIR" ]]; then
    set_installer_state_dir "$FASED_CONFIG_DIR"
    return 0
  fi
  if [[ "$RUN_ONBOARD" -eq 0 ]]; then
    set_installer_state_dir "$FASED_CONFIG_DIR"
    return 0
  fi

  local action="${FASED_EXISTING_DATA_ACTION:-}"
  if [[ -z "$action" && ( ! -t 0 || ! -t 1 ) ]]; then
    action="keep"
  fi

  if [[ -z "$action" ]]; then
    action="keep"
  fi

  case "$action" in
    keep)
      set_installer_state_dir "$FASED_CONFIG_DIR"
      ;;
    reset-config)
      local suffix
      suffix="$(date -u +%Y%m%dT%H%M%SZ)"
      local backed_up=()
      local backup
      backup="$(backup_existing_local_file "$FASED_CONFIG_DIR/fased.json" "local-reset-$suffix" || true)"
      [[ -n "$backup" ]] && backed_up+=("$backup")
      backup="$(backup_existing_local_file "$INSTALL_MARKER_PATH" "local-reset-$suffix" || true)"
      [[ -n "$backup" ]] && backed_up+=("$backup")
      set_installer_state_dir "$FASED_CONFIG_DIR"
      if [[ ${#backed_up[@]} -gt 0 ]]; then
        echo "Backed up local config metadata:"
        printf '  %s\n' "${backed_up[@]}"
      else
        echo "No local config file or install marker needed backup."
      fi
      ;;
    separate-state)
      local separate_dir="${FASED_EXISTING_DATA_DIR:-}"
      if [[ -z "$separate_dir" && -t 0 && -t 1 ]]; then
        printf "State directory [$HOME/.fased-local]: "
        read -r separate_dir || separate_dir=""
      fi
      separate_dir="${separate_dir:-$HOME/.fased-local}"
      set_installer_state_dir "$separate_dir"
      mkdir -p "$FASED_CONFIG_DIR"
      chmod 700 "$FASED_CONFIG_DIR" 2>/dev/null || true
      echo "Using separate Fased state directory: $FASED_CONFIG_DIR"
      ;;
    *)
      echo "Unknown FASED_EXISTING_DATA_ACTION=$action; expected keep, reset-config, or separate-state." >&2
      exit 1
      ;;
  esac
}

resolve_requested_swap_gb() {
  if [[ -n "$REQUESTED_SWAP_GB" ]]; then
    printf '%s\n' "$REQUESTED_SWAP_GB"
    return 0
  fi

  local profile
  profile="$(resolved_host_profile || true)"
  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb || true)"

  if [[ "$profile" == "hosting" ]]; then
    if [[ -z "$total_mem_mb" || "$total_mem_mb" -eq 0 || "$total_mem_mb" -le "$LOW_MEMORY_SWAP_THRESHOLD_MB" ]]; then
      printf '%s\n' "$LOW_MEMORY_SWAP_GB"
      return 0
    fi
    printf '%s\n' "$HOSTING_SWAP_GB"
    return 0
  fi

  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 && "$total_mem_mb" -le "$LOW_MEMORY_SWAP_THRESHOLD_MB" ]]; then
    printf '%s\n' "$LOW_MEMORY_SWAP_GB"
    return 0
  fi

  printf '0\n'
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

node_runtime_ok_for() {
  local node_bin="$1"
  [[ -n "$node_bin" && -x "$node_bin" ]] || return 1
  "$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 14)) process.exit(2); try { require("node:sqlite"); } catch { process.exit(3); }' >/dev/null 2>&1
}

node_runtime_ok() {
  need_cmd node || return 1
  node_runtime_ok_for "$(command -v node)"
}

node_runtime_is_user_managed() {
  need_cmd node || return 1
  local node_bin
  node_bin="$(command -v node)"
  case "$node_bin" in
    "$HOME"/.nvm/*|"$HOME"/.fnm/*|"$HOME"/.volta/*|"$HOME"/.asdf/*|"$HOME"/.local/share/mise/*)
      return 0
      ;;
  esac
  return 1
}

node_runtime_issue() {
  if ! need_cmd node; then
    printf 'node is not installed'
    return 0
  fi
  local node_bin
  node_bin="$(command -v node)"
  local version
  version="$(node -v 2>/dev/null || printf 'unknown')"
  if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 14) ? 0 : 1);' >/dev/null 2>&1; then
    printf 'node %s at %s is too old; need Node 24 recommended or Node >=22.14.0 with node:sqlite' "$version" "$node_bin"
    return 0
  fi
  if ! node -e 'require("node:sqlite")' >/dev/null 2>&1; then
    printf 'node %s at %s was built without node:sqlite' "$version" "$node_bin"
    return 0
  fi
  printf 'node runtime is compatible'
}

print_node_runtime_help() {
  cat >&2 <<EOF_NODE
Node runtime is incompatible: $(node_runtime_issue)

Fased needs Node 24 recommended, or Node >=22.14.0, with the built-in node:sqlite module for full memory support.
EOF_NODE
  if node_runtime_is_user_managed; then
    cat >&2 <<'EOF_NODE'
Your active node appears to be managed by a user-level version manager, so install.sh will not replace it with a system package manager automatically.

For nvm:
  nvm install 24
  nvm use 24
  corepack enable
EOF_NODE
  else
    cat >&2 <<'EOF_NODE'
Install Node 24 with your system package manager or fix PATH so install.sh uses a compatible node.
EOF_NODE
  fi
  cat >&2 <<'EOF_NODE'

Quick check:
  node -e 'require("node:sqlite"); console.log("node:sqlite ok")'
EOF_NODE
}

prefer_compatible_user_node_if_available() {
  local candidate
  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node \
    "$HOME"/.asdf/shims/node \
    "$HOME"/.local/share/mise/shims/node; do
    [[ -e "$candidate" ]] || continue
    if node_runtime_ok_for "$candidate"; then
      export PATH="$(dirname "$candidate"):$PATH"
      hash -r 2>/dev/null || true
      return 0
    fi
  done
  return 1
}

prefer_compatible_system_node_if_available() {
  local candidate
  for candidate in /usr/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do
    if node_runtime_ok_for "$candidate"; then
      export PATH="$(dirname "$candidate"):$PATH"
      hash -r 2>/dev/null || true
      return 0
    fi
  done
  return 1
}

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif need_cmd sudo; then
    sudo "$@"
  else
    echo "sudo is required for system dependency installation." >&2
    return 1
  fi
}

desired_pnpm_version() {
  local version=""
  if [[ -f "$FASED_DIR/package.json" ]]; then
    version="$(
      awk -F'"' '/"packageManager"[[:space:]]*:[[:space:]]*"pnpm@/ {
        sub(/^pnpm@/, "", $4);
        print $4;
        exit
      }' "$FASED_DIR/package.json" 2>/dev/null || true
    )"
  fi
  printf '%s\n' "${version:-10.23.0}"
}

install_pnpm_for_active_node() {
  local npm_prefix="${FASED_NPM_GLOBAL_PREFIX:-$INSTALL_CACHE_DIR/npm-global}"
  if [[ -d "$npm_prefix/bin" ]]; then
    export PATH="$npm_prefix/bin:$PATH"
    hash -r 2>/dev/null || true
  fi
  if need_cmd pnpm; then
    return 0
  fi
  if ! node_runtime_ok; then
    return 1
  fi

  local pnpm_version
  pnpm_version="$(desired_pnpm_version)"
  if need_cmd corepack; then
    corepack enable || run_as_root corepack enable || true
    corepack prepare "pnpm@${pnpm_version}" --activate || true
  fi
  if ! need_cmd pnpm && need_cmd npm; then
    mkdir -p "$npm_prefix"
    npm_config_prefix="$npm_prefix" npm install -g --prefix "$npm_prefix" "pnpm@${pnpm_version}" || {
      echo "User-local pnpm install failed." >&2
      echo "Install pnpm manually or rerun with FASED_INSTALL_VERBOSE=1 for npm details." >&2
      return 1
    }
    export PATH="$npm_prefix/bin:$PATH"
  fi
  hash -r 2>/dev/null || true
  need_cmd pnpm
}

install_nodesource_node_apt() {
  local setup_script
  setup_script="$(mktemp)"
  if curl -fsSL https://deb.nodesource.com/setup_24.x -o "$setup_script" && \
    run_as_root bash "$setup_script" && \
    run_as_root apt-get install -y nodejs; then
    rm -f "$setup_script"
    return 0
  fi
  rm -f "$setup_script"
  echo "NodeSource Node 24 install failed; trying distro nodejs/npm packages as fallback." >&2
  run_as_root apt-get update
  run_as_root apt-get install -y nodejs npm
}

install_nodesource_node_rpm() {
  local pkg_cmd="$1"
  local setup_script
  setup_script="$(mktemp)"
  curl -fsSL https://rpm.nodesource.com/setup_24.x -o "$setup_script"
  run_as_root bash "$setup_script"
  rm -f "$setup_script"
  run_as_root "$pkg_cmd" install -y nodejs
}

linux_os_summary() {
  if [[ -r /etc/os-release ]]; then
    local pretty=""
    local id=""
    local version=""
    # shellcheck source=/dev/null
    . /etc/os-release
    pretty="${PRETTY_NAME:-}"
    id="${ID:-}"
    version="${VERSION_ID:-}"
    if [[ -n "$pretty" ]]; then
      printf '%s\n' "$pretty"
      return 0
    fi
    printf '%s %s\n' "$id" "$version"
    return 0
  fi
  uname -a
}

install_linux_system_dependencies() {
  local install_pnpm="${1:-1}"
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 1
  fi

  if need_cmd apt-get; then
    run_as_root apt-get update
    run_as_root apt-get install -y git curl ca-certificates jq
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      install_nodesource_node_apt
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  elif need_cmd dnf || need_cmd dnf5; then
    local dnf_cmd="dnf"
    if ! need_cmd dnf && need_cmd dnf5; then
      dnf_cmd="dnf5"
    fi
    run_as_root "$dnf_cmd" install -y git curl ca-certificates jq
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      run_as_root "$dnf_cmd" install -y nodejs24-bin nodejs24-npm-bin || \
        run_as_root "$dnf_cmd" install -y nodejs24 npm || \
        run_as_root "$dnf_cmd" install -y nodejs22-bin nodejs22-npm-bin || \
        install_nodesource_node_rpm "$dnf_cmd" || \
        run_as_root "$dnf_cmd" install -y nodejs npm
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  elif need_cmd yum; then
    run_as_root yum install -y git curl ca-certificates jq
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      install_nodesource_node_rpm yum || \
        run_as_root yum install -y nodejs npm
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  elif need_cmd apk; then
    run_as_root apk add --no-cache git curl ca-certificates jq nodejs npm
    hash -r 2>/dev/null || true
  elif need_cmd pacman; then
    run_as_root pacman -Sy --needed --noconfirm git curl ca-certificates jq nodejs npm
    hash -r 2>/dev/null || true
  elif need_cmd zypper; then
    run_as_root zypper --non-interactive refresh || true
    run_as_root zypper --non-interactive install --no-recommends git curl ca-certificates jq
    hash -r 2>/dev/null || true
    if ! node_runtime_ok; then
      run_as_root zypper --non-interactive install --no-recommends nodejs24 npm24 || \
        run_as_root zypper --non-interactive install --no-recommends nodejs22 npm22 || \
        run_as_root zypper --non-interactive install --no-recommends nodejs npm
      hash -r 2>/dev/null || true
      prefer_compatible_system_node_if_available || true
    fi
  else
    echo "Unsupported Linux package manager for --auto-install." >&2
    echo "Detected system: $(linux_os_summary)" >&2
    echo "Supported auto-install package managers: apt-get, dnf, dnf5, yum, zypper, apk, pacman." >&2
    echo "Install git, curl, jq, Node 24, and pnpm manually, then rerun ./install.sh." >&2
    return 1
  fi

  if ! node_runtime_ok; then
    print_node_runtime_help
    return 1
  fi
  if [[ "$install_pnpm" == "1" ]]; then
    install_pnpm_for_active_node
  fi
}

github_cli_supports_attestations() {
  need_cmd gh && gh attestation verify --help >/dev/null 2>&1
}

install_github_cli_for_attestations() {
  if github_cli_supports_attestations; then
    return 0
  fi
  if [[ "$AUTO_INSTALL" -ne 1 ]]; then
    echo "GitHub CLI with 'gh attestation verify' is required for official release assets." >&2
    echo "Install a current GitHub CLI, then rerun the installer." >&2
    return 1
  fi

  echo "Installing GitHub CLI for release attestation verification..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if ! need_cmd brew; then
      echo "Automatic GitHub CLI installation on macOS requires Homebrew." >&2
      echo "Install Homebrew from https://brew.sh, then rerun the installer." >&2
      return 1
    fi
    brew install gh || brew upgrade gh
  elif [[ "$(uname -s)" != "Linux" ]]; then
    echo "Automatic GitHub CLI installation is unavailable on $(uname -s)." >&2
    echo "Install a current GitHub CLI, then rerun the installer." >&2
    return 1
  elif need_cmd apt-get; then
    local keyring_tmp
    keyring_tmp="$(mktemp)"
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "$keyring_tmp"
    run_as_root install -d -m 0755 /etc/apt/keyrings
    run_as_root install -m 0644 "$keyring_tmp" /etc/apt/keyrings/githubcli-archive-keyring.gpg
    rm -f "$keyring_tmp"
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" \
      | run_as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    run_as_root apt-get update
    run_as_root apt-get install -y gh
  elif need_cmd dnf || need_cmd dnf5; then
    local dnf_cmd="dnf"
    need_cmd dnf || dnf_cmd="dnf5"
    run_as_root "$dnf_cmd" install -y 'dnf-command(config-manager)' >/dev/null 2>&1 || true
    run_as_root "$dnf_cmd" config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null 2>&1 || true
    run_as_root "$dnf_cmd" install -y gh
  elif need_cmd yum; then
    run_as_root yum install -y yum-utils >/dev/null 2>&1 || true
    run_as_root yum-config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo >/dev/null 2>&1 || true
    run_as_root yum install -y gh
  elif need_cmd pacman; then
    run_as_root pacman -Sy --needed --noconfirm github-cli
  elif need_cmd apk; then
    run_as_root apk add --no-cache github-cli
  elif need_cmd zypper; then
    run_as_root zypper --non-interactive install --no-recommends gh
  else
    echo "Automatic GitHub CLI installation is unavailable on this distribution." >&2
    return 1
  fi
  hash -r 2>/dev/null || true
  github_cli_supports_attestations || {
    echo "Installed GitHub CLI does not support attestation verification." >&2
    return 1
  }
}

install_freebsd_system_dependencies() {
  if [[ "$(uname -s)" != "FreeBSD" ]]; then
    return 1
  fi
  if ! need_cmd pkg; then
    echo "FreeBSD auto-install needs pkg." >&2
    echo "Install git, curl, ca_root_nss, Node 24, npm, and pnpm manually, then rerun ./install.sh." >&2
    return 1
  fi

  run_as_root pkg update -f || true
  run_as_root pkg install -y git curl ca_root_nss
  hash -r 2>/dev/null || true
  if ! node_runtime_ok; then
    run_as_root pkg install -y node24 npm-node24 || \
      run_as_root pkg install -y node22 npm-node22 || \
      run_as_root pkg install -y node npm
    hash -r 2>/dev/null || true
    prefer_compatible_system_node_if_available || true
  fi

  if ! node_runtime_ok; then
    print_node_runtime_help
    return 1
  fi
  install_pnpm_for_active_node
}

install_macos_system_dependencies() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 1
  fi
  if ! need_cmd brew; then
    cat >&2 <<'EOF_MACOS'
macOS auto-install needs Homebrew.

Install Homebrew from https://brew.sh, then rerun:
  ./install.sh

Or install Node 24 manually from https://nodejs.org, enable pnpm with Corepack,
and rerun:
  corepack enable
  corepack prepare pnpm@10.23.0 --activate
  ./install.sh
EOF_MACOS
    return 1
  fi

  if ! need_cmd git; then
    brew install git
  fi
  if ! need_cmd curl; then
    brew install curl
  fi
  if ! node_runtime_ok; then
    brew install node || brew upgrade node
    hash -r 2>/dev/null || true
    prefer_compatible_system_node_if_available || true
  fi
  if ! need_cmd pnpm; then
    brew install pnpm || install_pnpm_for_active_node
    hash -r 2>/dev/null || true
  fi

  if ! node_runtime_ok; then
    print_node_runtime_help
    return 1
  fi
  if ! need_cmd pnpm; then
    install_pnpm_for_active_node
  fi
  return 0
}

install_supported_system_dependencies() {
  case "$(uname -s)" in
    Linux)
      install_linux_system_dependencies
      ;;
    Darwin)
      install_macos_system_dependencies
      ;;
    FreeBSD)
      install_freebsd_system_dependencies
      ;;
    *)
      echo "Unsupported operating system for --auto-install: $(uname -s)" >&2
      echo "Supported auto-install targets: Linux with apt-get/dnf/dnf5/yum/zypper/apk/pacman, FreeBSD with pkg, or macOS with Homebrew." >&2
      echo "Install git, curl, Node 24, and pnpm manually, then rerun ./install.sh." >&2
      return 1
      ;;
  esac
}

root_has_active_time_sync_service() {
  if [[ "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]] || ! need_cmd systemctl; then
    return 1
  fi
  systemctl is-active --quiet systemd-timesyncd || \
    systemctl is-active --quiet chronyd || \
    systemctl is-active --quiet chrony
}

best_effort_enable_root_host_time_sync() {
  if [[ "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]]; then
    return 0
  fi

  echo "== Ensure host clock sync for managed public runtime =="
  if need_cmd timedatectl; then
    timedatectl set-ntp true >/dev/null 2>&1 || true
  fi

  if need_cmd systemctl; then
    systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || \
      systemctl restart systemd-timesyncd >/dev/null 2>&1 || true
  fi

  if root_has_active_time_sync_service; then
    return 0
  fi

  if need_cmd apt-get; then
    apt-get install -y chrony >/dev/null 2>&1 || true
  fi
  if need_cmd systemctl; then
    systemctl enable --now chrony >/dev/null 2>&1 || \
      systemctl enable --now chronyd >/dev/null 2>&1 || \
      systemctl restart chrony >/dev/null 2>&1 || \
      systemctl restart chronyd >/dev/null 2>&1 || true
  fi
  if need_cmd chronyc; then
    chronyc -a makestep >/dev/null 2>&1 || true
  fi
}

is_fased_repo_dir() {
  local dir="$1"
  [[ -f "$dir/package.json" && -d "$dir/src" ]]
}

resolve_fased_dir_from_base() {
  local base="$1"
  if is_fased_repo_dir "$base"; then
    printf '%s\n' "$base"
    return 0
  fi
  return 1
}

shell_quote() {
  printf "%q" "$1"
}

ensure_checkout_origin_remote() {
  local repo_dir="$1"
  local origin_url=""

  if [[ ! -d "$repo_dir/.git" ]]; then
    return 0
  fi

  origin_url="$(git -C "$repo_dir" remote get-url origin 2>/dev/null || true)"
  if [[ -z "$origin_url" ]]; then
    git -C "$repo_dir" remote add origin "$INSTALL_REPO_URL"
    return 0
  fi

  case "$origin_url" in
    /*|file://*)
      git -C "$repo_dir" remote set-url origin "$INSTALL_REPO_URL"
      ;;
  esac
}

refresh_checkout_from_origin() {
  local repo_dir="$1"
  local label="${2:-Installer}"
  local branch=""
  local remote_ref=""
  local before=""
  local after=""

  if [[ "$INSTALL_GIT_UPDATE" == "0" || ! -d "$repo_dir/.git" ]] || ! need_cmd git; then
    return 0
  fi

  ensure_checkout_origin_remote "$repo_dir"

  branch="$(git -C "$repo_dir" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -z "$branch" ]]; then
    echo "== $label: detached checkout detected, skipping git update =="
    return 0
  fi

  if ! git -C "$repo_dir" diff --quiet --ignore-submodules -- || ! git -C "$repo_dir" diff --cached --quiet --ignore-submodules --; then
    echo "== $label: local checkout has changes, skipping git update =="
    return 0
  fi

  remote_ref="origin/$branch"
  git -C "$repo_dir" fetch --quiet origin "$branch" || {
    echo "== $label: could not fetch $remote_ref, continuing with local checkout =="
    return 0
  }

  if ! git -C "$repo_dir" merge-base --is-ancestor HEAD "$remote_ref" >/dev/null 2>&1; then
    echo "== $label: $repo_dir is not a fast-forward from $remote_ref, skipping git update =="
    return 0
  fi

  before="$(git -C "$repo_dir" rev-parse --short HEAD 2>/dev/null || true)"
  after="$(git -C "$repo_dir" rev-parse --short "$remote_ref" 2>/dev/null || true)"
  if [[ -n "$before" && -n "$after" && "$before" != "$after" ]]; then
    echo "== $label: updating $repo_dir from $remote_ref ($before -> $after) =="
    git -C "$repo_dir" merge --ff-only "$remote_ref"
  fi
}

refresh_current_checkout_and_reexec_if_needed() {
  local repo_dir=""
  local before=""
  local after=""

  if [[ "$INSTALL_GIT_UPDATE" == "0" || "${FASED_INSTALL_REEXECED_AFTER_UPDATE:-0}" == "1" ]] || ! need_cmd git; then
    return 0
  fi
  if ! is_fased_repo_dir "$FASED_DIR" || [[ ! -d "$FASED_DIR/.git" ]]; then
    return 0
  fi

  repo_dir="$(cd "$FASED_DIR" && pwd)"
  before="$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)"
  refresh_checkout_from_origin "$repo_dir" "Installer"
  after="$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || true)"

  if [[ -n "$before" && -n "$after" && "$before" != "$after" ]]; then
    echo "== Installer: restarting after source update =="
    cd "$repo_dir"
    FASED_INSTALL_REEXECED_AFTER_UPDATE=1 exec ./install.sh "${ORIGINAL_INSTALL_ARGS[@]}"
  fi
}

install_user_cli_path_snippet() {
  local bin_dir="$1"
  local file="$2"
  [[ -n "$bin_dir" && -n "$file" ]] || return 0
  if [[ -f "$file" ]] && grep -F "$bin_dir" "$file" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -e "$file" && ! -w "$file" ]]; then
    return 0
  fi
  {
    printf '\n# Fased CLI\n'
    printf 'case ":$PATH:" in\n'
    printf '  *":%s:"*) ;;\n' "$bin_dir"
    printf '  *) export PATH="%s:$PATH" ;;\n' "$bin_dir"
    printf 'esac\n'
  } >>"$file"
}

install_fased_cli_launcher() {
  local launcher="$FASED_DIR/fased.mjs"
  local bin_dir="${FASED_CLI_BIN_DIR:-$HOME/.local/bin}"
  local target="$bin_dir/fased"

  if [[ ! -f "$launcher" ]]; then
    echo "CLI launcher missing: $launcher" >&2
    exit 1
  fi

  mkdir -p "$bin_dir"
  chmod 755 "$launcher" 2>/dev/null || true

  local launcher_real=""
  local target_real=""
  launcher_real="$(readlink -f "$launcher" 2>/dev/null || true)"
  if [[ -e "$target" || -L "$target" ]]; then
    target_real="$(readlink -f "$target" 2>/dev/null || true)"
  fi

  if [[ -n "$launcher_real" && "$target_real" == "$launcher_real" ]]; then
    :
  elif ! ln -sfn "$launcher" "$target" 2>/dev/null; then
    target_real=""
    if [[ -e "$target" || -L "$target" ]]; then
      target_real="$(readlink -f "$target" 2>/dev/null || true)"
    fi
    if [[ -n "$launcher_real" && "$target_real" == "$launcher_real" ]]; then
      :
    else
      rm -f "$target"
      {
        printf '#!/usr/bin/env bash\n'
        printf 'exec %s "$@"\n' "$(shell_quote "$launcher")"
      } >"$target"
      chmod 755 "$target"
    fi
  fi

  export PATH="$bin_dir:$PATH"
  hash -r 2>/dev/null || true
  FASED_CLI_PATH="$target"

  install_user_cli_path_snippet "$bin_dir" "$HOME/.profile"
  install_user_cli_path_snippet "$bin_dir" "$HOME/.bashrc"
  install_user_cli_path_snippet "$bin_dir" "$HOME/.zshrc"

  if ! "$FASED_CLI_PATH" --version >/dev/null 2>&1; then
    echo "Installed CLI did not start correctly: $FASED_CLI_PATH" >&2
    echo "Check $INSTALL_LOG_DIR and rerun ./install.sh --verbose." >&2
    exit 1
  fi

  step_done "CLI installed"
}

use_prebuilt_release_runtime() {
  fased_should_use_prebuilt_release_runtime \
    "$(resolved_host_profile)" \
    "$SOURCE_INSTALL_REQUESTED" \
    "${FASED_SOURCE_INSTALL:-0}" \
    "${FASED_HOSTING_SOURCE_INSTALL:-0}" \
    "$(uname -s 2>/dev/null || true)" \
    "$(uname -m 2>/dev/null || true)"
}

install_prebuilt_release_runtime() {
  local runtime_profile
  runtime_profile="$(resolved_host_profile)"
  local package_spec="${RELEASE_NPM_PACKAGE:-@fased/fased@latest}"
  if [[ -n "$HOSTING_RELEASE" ]]; then
    if [[ ! "$HOSTING_RELEASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Managed release installation requires one exact stable --release vX.Y.Z." >&2
      return 1
    fi
    package_spec="@fased/fased@${HOSTING_RELEASE}"
  elif [[ "$runtime_profile" == "hosting" ]]; then
    echo "Maintained Hosting requires one exact stable --release vX.Y.Z." >&2
    return 1
  fi
  local npm_prefix="${FASED_NPM_GLOBAL_PREFIX:-$INSTALL_CACHE_DIR/npm-global}"
  local bin_dir="$npm_prefix/bin"
  local target="$bin_dir/fased"
  local install_log
  install_log="$(install_log_path "npm prebuilt install")"

  mkdir -p "$npm_prefix" "$npm_config_cache"
  spinner_start "Install prebuilt runtime"
  local artifact_result=0
  bash "$FASED_DIR/scripts/install-hosted-runtime.sh" \
    --package "$package_spec" \
    --prefix "$npm_prefix" \
    --cache "$INSTALL_CACHE_DIR" \
    --state-dir "$FASED_CONFIG_DIR" \
    --profile "$runtime_profile" || artifact_result=$?
  if [[ "$artifact_result" -eq 20 ]]; then
    spinner_failed "Install prebuilt runtime"
    return 1
  fi
  if [[ "$artifact_result" -ne 0 ]]; then
    if [[ "$runtime_profile" == "hosting" ]]; then
      spinner_failed "Install prebuilt runtime"
      echo "Exact attested Hosting app/dependency assets for ${package_spec} are unavailable; the current installation was not changed." >&2
      echo "Maintained Hosting never falls back to npm." >&2
      return 1
    fi
    if [[ "$INSTALL_VERBOSE" == "1" ]]; then
      echo "Release runtime artifact unavailable; using npm fallback."
      npm_config_prefix="$npm_prefix" npm_config_cache="$npm_config_cache" \
        npm install -g --prefix "$npm_prefix" "$package_spec" --no-audit --no-fund
    else
      npm_config_prefix="$npm_prefix" npm_config_cache="$npm_config_cache" \
        npm install -g --prefix "$npm_prefix" "$package_spec" --no-audit --no-fund >"$install_log" 2>&1 || {
          spinner_failed "Install prebuilt runtime"
          echo "Failed: release runtime and npm fallback install" >&2
          echo "Package: $package_spec" >&2
          echo "Log: $install_log" >&2
          tail -n 80 "$install_log" >&2 || true
          return 1
      }
    fi
  fi

  local installed_package_root="$npm_prefix/lib/node_modules/@fased/fased"
  if [[ "$artifact_result" -ne 0 ]]; then
    local -a managed_install_args=(
      --package-root "$installed_package_root"
      --state-dir "$FASED_CONFIG_DIR"
      --prefix "$npm_prefix"
      --profile "$(resolved_host_profile)"
    )
    if [[ -n "${FASED_HOST_UPDATE_TRANSACTION_ID:-}" ]]; then
      managed_install_args+=(
        --host-transaction-id "$FASED_HOST_UPDATE_TRANSACTION_ID"
        --host-transaction-version "${FASED_HOST_UPDATE_TRANSACTION_VERSION:-}"
      )
    fi
    node "$installed_package_root/scripts/install-managed-runtime.mjs" \
      "${managed_install_args[@]}" || {
        spinner_failed "Install prebuilt runtime"
        echo "Failed to install the stable Fased updater layout." >&2
        return 1
      }
  fi

  export PATH="$bin_dir:$PATH"
  hash -r 2>/dev/null || true
  FASED_CLI_PATH="$target"

  if ! node "$FASED_DIR/scripts/install-managed-cli-alias.mjs" \
    --target "$target" \
    --source-launcher "$FASED_DIR/fased.mjs"; then
    spinner_failed "Install prebuilt runtime"
    echo "Failed to reconcile the managed Fased CLI launcher." >&2
    return 1
  fi

  install_user_cli_path_snippet "$bin_dir" "$HOME/.profile"
  install_user_cli_path_snippet "$bin_dir" "$HOME/.bashrc"
  install_user_cli_path_snippet "$bin_dir" "$HOME/.zshrc"

  if [[ ! -x "$FASED_CLI_PATH" ]] || ! "$FASED_CLI_PATH" --version >/dev/null 2>&1; then
    spinner_failed "Install prebuilt runtime"
    echo "Installed npm CLI did not start correctly: $FASED_CLI_PATH" >&2
    echo "Log: $install_log" >&2
    return 1
  fi

  PREBUILT_RUNTIME_INSTALLED=1
  spinner_done "Prebuilt runtime ready"
}

pass_args_contains() {
  local needle="$1"
  local arg
  for arg in "${pass_args[@]}"; do
    if [[ "$arg" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

pass_args_value_after() {
  local needle="$1"
  local i
  for ((i = 0; i < ${#pass_args[@]}; i++)); do
    if [[ "${pass_args[$i]}" == "$needle" ]]; then
      printf '%s\n' "${pass_args[$((i + 1))]:-}"
      return 0
    fi
  done
  return 1
}

resolved_host_profile() {
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    printf 'hosting\n'
    return 0
  fi

  local profile
  profile="$(pass_args_value_after "--host-profile" || true)"
  printf '%s\n' "$profile"
}

is_app_service_session() {
  local current_user="${USER:-${LOGNAME:-}}"
  local install_user="${FASED_INSTALL_USER:-app}"
  [[ -n "$current_user" && "$current_user" == "$install_user" ]]
}

resolve_repo_root() {
  if is_fased_repo_dir "$FASED_DIR"; then
    (cd "$FASED_DIR" && pwd)
    return 0
  fi
  (cd "$FASED_DIR/../.." && pwd)
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

read_marker_repo_path() {
  if [[ ! -f "$INSTALL_MARKER_PATH" ]]; then
    return 0
  fi
  if need_cmd node; then
    node -e 'const fs=require("fs");try{const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));if(typeof o.repoPath==="string")process.stdout.write(o.repoPath);}catch{}' "$INSTALL_MARKER_PATH"
    return 0
  fi
  sed -n 's/.*"repoPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL_MARKER_PATH" | head -n 1
}

read_marker_onboarding_completed() {
  if [[ ! -f "$INSTALL_MARKER_PATH" ]]; then
    return 0
  fi
  if need_cmd node; then
    node -e 'const fs=require("fs");try{const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));if(o.onboardingCompleted===true)process.stdout.write("true");else if(o.onboardingCompleted===false)process.stdout.write("false");}catch{}' "$INSTALL_MARKER_PATH"
    return 0
  fi
  if grep -q '"onboardingCompleted"[[:space:]]*:[[:space:]]*true' "$INSTALL_MARKER_PATH" 2>/dev/null; then
    printf 'true\n'
  elif grep -q '"onboardingCompleted"[[:space:]]*:[[:space:]]*false' "$INSTALL_MARKER_PATH" 2>/dev/null; then
    printf 'false\n'
  fi
}

assert_marker_matches_repo() {
  local repo_root="$1"
  local marker_repo
  marker_repo="$(read_marker_repo_path || true)"
  if [[ -n "$marker_repo" && "$marker_repo" != "$repo_root" ]]; then
    if [[ "$HOSTING_REQUESTED" -ne 1 ]]; then
      echo "Existing local install marker points at another checkout; continuing with this checkout."
      echo "The Gateway service will be checked and reinstalled if it is stale."
      return 0
    fi
    echo "Install marker mismatch." >&2
    echo "Marker repoPath: $marker_repo" >&2
    echo "Current repoPath: $repo_root" >&2
    echo "Use the canonical repo path from marker, or remove $INSTALL_MARKER_PATH if you are intentionally moving installs." >&2
    exit 1
  fi
}

write_install_marker() {
  local repo_root="$1"
  local onboarding_completed="$2"
  local escaped_repo
  escaped_repo="$(json_escape "$repo_root")"
  mkdir -p "$FASED_CONFIG_DIR"
  chmod 700 "$FASED_CONFIG_DIR" 2>/dev/null || true
  cat >"$INSTALL_MARKER_PATH" <<EOF
{
  "repoPath": "$escaped_repo",
  "fasedDir": "$escaped_repo",
  "onboardingCompleted": $onboarding_completed,
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  chmod 600 "$INSTALL_MARKER_PATH" 2>/dev/null || true
}

repair_tailscale_serve_gateway_config() {
  local config_path="${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
  if [[ ! -f "$config_path" ]] || ! need_cmd node; then
    return 0
  fi

  local output
  output="$(
    CONFIG_PATH="$config_path" node <<'NODE'
const fs = require("fs");

const configPath = process.env.CONFIG_PATH;
if (!configPath || !fs.existsSync(configPath)) {
  process.exit(0);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  process.exit(0);
}

const gateway = cfg && typeof cfg === "object" ? (cfg.gateway ?? {}) : {};
const tailscale = gateway && typeof gateway === "object" ? (gateway.tailscale ?? {}) : {};
if (!tailscale || tailscale.mode !== "serve") {
  process.exit(0);
}

let changed = false;
cfg.gateway = gateway;

const trusted = Array.isArray(gateway.trustedProxies) ? [...gateway.trustedProxies] : [];
for (const proxy of ["127.0.0.1/32", "::1/128"]) {
  if (!trusted.includes(proxy)) {
    trusted.push(proxy);
    changed = true;
  }
}
gateway.trustedProxies = trusted;

const controlUi =
  gateway.controlUi && typeof gateway.controlUi === "object" ? gateway.controlUi : {};
if (controlUi.allowInsecureAuth === true) {
  delete controlUi.allowInsecureAuth;
  changed = true;
}
gateway.controlUi = controlUi;

if (gateway.bind !== "loopback") {
  gateway.bind = "loopback";
  changed = true;
}

if (!changed) {
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
try {
  fs.copyFileSync(configPath, `${configPath}.bak-hosted-serve-${stamp}`);
} catch {
  // best-effort backup; continue with atomic-enough write below
}
fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
try {
  fs.chmodSync(configPath, 0o600);
} catch {}
console.log("changed");
NODE
  )" || return 0

  if [[ "$output" == *changed* ]]; then
    step_done "Hosted dashboard config repaired"
  fi
}

is_tailscale_serve_gateway_config() {
  local config_path="${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
  if [[ ! -f "$config_path" ]] || ! need_cmd node; then
    return 1
  fi
  CONFIG_PATH="$config_path" node <<'NODE'
const fs = require("fs");
try {
  const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
  process.exit(cfg?.gateway?.tailscale?.mode === "serve" ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

has_system_gateway_service() {
  if ! need_cmd systemctl; then
    return 1
  fi
  systemctl list-unit-files fased-gateway.service --no-legend 2>/dev/null | grep -q '^fased-gateway.service' && return 0
  sudo -n systemctl list-unit-files fased-gateway.service --no-legend 2>/dev/null | grep -q '^fased-gateway.service' && return 0
  systemctl status fased-gateway.service >/dev/null 2>&1 && return 0
  sudo -n systemctl status fased-gateway.service >/dev/null 2>&1 && return 0
  return 1
}

has_user_gateway_service() {
  if ! need_cmd systemctl; then
    return 1
  fi
  systemctl --user list-unit-files fased-gateway.service --no-legend 2>/dev/null | grep -q '^fased-gateway.service' && return 0
  systemctl --user status fased-gateway.service >/dev/null 2>&1 && return 0
  return 1
}

restart_existing_gateway_service_after_install() {
  local profile
  profile="$(resolved_host_profile)"

  if [[ "$profile" == "hosting" ]]; then
    echo "Hosted systemd lifecycle is owned by the provider-console root installer coordinator." >&2
    return 1
  fi

  if [[ "$profile" != "hosting" ]] && has_user_gateway_service; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    if systemctl --user restart fased-gateway.service >/dev/null 2>&1; then
      return 0
    fi
    if systemctl --user start fased-gateway.service >/dev/null 2>&1; then
      return 0
    fi
  fi

  if has_system_gateway_service; then
    sudo -n systemctl daemon-reload >/dev/null 2>&1 || true
    if sudo -n systemctl restart --no-block fased-gateway.service >/dev/null 2>&1; then
      return 0
    fi
    if sudo -n systemctl start --no-block fased-gateway.service >/dev/null 2>&1; then
      return 0
    fi
  fi

  return 1
}

refresh_existing_local_gateway_service_after_install() {
  local profile
  profile="$(resolved_host_profile)"

  if [[ "$profile" == "hosting" ]]; then
    return 0
  fi
  if ! has_user_gateway_service && ! has_system_gateway_service; then
    return 0
  fi

  echo "Refreshing the existing Gateway service to the managed runtime..."
  if ! "$FASED_CLI_PATH" gateway install --force; then
    echo "Gateway service refresh failed; the previous service was left in place." >&2
    echo "Persistent state under $FASED_CONFIG_DIR was not removed." >&2
    return 1
  fi
  GATEWAY_SERVICE_REFRESHED=1
}

verify_gateway_runtime_identity_after_install() {
  local expected_version=""
  expected_version="$("$FASED_CLI_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  if [[ -z "$expected_version" ]]; then
    echo "Could not read the installed Fased CLI version." >&2
    return 1
  fi

  node "$FASED_DIR/scripts/verify-gateway-runtime-identity.mjs" \
    --expected-version "$expected_version" \
    --config "${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}"
}

local_signer_transaction_script() {
  local current_root=""
  current_root="$(readlink -f "$FASED_CONFIG_DIR/runtime/current" 2>/dev/null || true)"
  if [[ -n "$current_root" && -x "$current_root/scripts/install-fased-signerd.sh" ]]; then
    printf '%s\n' "$current_root/scripts/install-fased-signerd.sh"
    return 0
  fi
  if [[ -x "$FASED_DIR/scripts/install-fased-signerd.sh" ]]; then
    printf '%s\n' "$FASED_DIR/scripts/install-fased-signerd.sh"
    return 0
  fi
  return 1
}

local_signer_is_installed_or_configured() {
  [[ -f "$FASED_CONFIG_DIR/bin/fased-signerd" ]] && return 0
  [[ -f "$FASED_CONFIG_DIR/wallet/signerd-v2.db" ]] && return 0
  local registry="$FASED_CONFIG_DIR/wallet/provider-registry.v1.json"
  [[ -f "$registry" ]] || return 1
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.exit((value.wallets || []).some((wallet) => wallet?.providerId === "local-socket-signer") ? 0 : 1);
  ' "$registry" >/dev/null 2>&1
}

local_legacy_signer_material_detected() {
  [[ -f "$FASED_CONFIG_DIR/wallet/signerd-v2.db" ]] && return 1
  [[ -f "$FASED_CONFIG_DIR/wallet/wallet-keys.json" ]] && return 0
  local candidate=""
  shopt -s nullglob
  for candidate in \
    "$FASED_CONFIG_DIR/wallet"/keystore-solana*.v1.enc \
    "$FASED_CONFIG_DIR/wallet"/keystore-evm*.v1.enc; do
    if [[ -f "$candidate" && ! -L "$candidate" ]]; then
      shopt -u nullglob
      return 0
    fi
  done
  shopt -u nullglob
  return 1
}

prepare_existing_local_signer_after_runtime_install() {
  local profile=""
  local script=""
  local version=""
  profile="$(resolved_host_profile)"
  if [[ "$profile" == "hosting" || "$PREBUILT_RUNTIME_INSTALLED" -ne 1 ]]; then
    return 0
  fi
  if local_legacy_signer_material_detected; then
    echo "Pre-v2 Local wallet detected. Runtime repair will install the new CLI without touching wallet material."
    echo "After repair, run: fased wallet setup --mode local-signer-import --wallet-id <wallet-id> --role <agent|mining|vault>"
    return 0
  fi
  if ! local_signer_is_installed_or_configured; then
    return 0
  fi
  script="$(local_signer_transaction_script || true)"
  if [[ -z "$script" ]]; then
    echo "The managed runtime is missing its transactional Local signer installer." >&2
    return 1
  fi
  version="$("$FASED_CLI_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
    echo "Could not resolve the exact installed Fased version for signer pairing." >&2
    return 1
  fi
  echo "Preparing the exact matching Local signer and offline rollback snapshot..."
  if ! bash "$script" --version "$version" --defer-commit; then
    echo "The Local signer transaction failed; the new runtime will be rolled back." >&2
    return 1
  fi
  LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=1
}

commit_local_signer_after_runtime_install() {
  [[ "$LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN" -eq 1 ]] || return 0
  local script=""
  script="$(local_signer_transaction_script || true)"
  [[ -n "$script" ]] || return 1
  bash "$script" --commit
  LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=0
}

verify_local_signer_after_runtime_install() {
  [[ "$LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN" -eq 1 ]] || return 0
  local script=""
  local version=""
  script="$(local_signer_transaction_script || true)"
  [[ -n "$script" ]] || return 1
  version="$("$FASED_CLI_PATH" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] || return 1
  bash "$script" --verify --version "$version"
}

rollback_local_signer_after_runtime_install() {
  local script=""
  script="$(local_signer_transaction_script || true)"
  [[ -n "$script" ]] || return 1
  if bash "$script" --status 2>/dev/null | grep -q '"journal":null'; then
    LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=0
    return 0
  fi
  bash "$script" --rollback
  LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN=0
}

rollback_managed_runtime_after_failed_install() {
  local current_root
  local rollback_script
  local paired_updater="$FASED_CONFIG_DIR/updater/fased-managed-updater.mjs"
  if [[ "$(resolved_host_profile)" == "hosting" && \
    -f "$FASED_CONFIG_DIR/hosted-update-transaction.json" && \
    -f "$paired_updater" ]]; then
    echo "Hosted runtime verification failed; restoring the paired app and signer transaction..." >&2
    node "$paired_updater" hosted-transaction rollback
    return $?
  fi
  if [[ "$(resolved_host_profile)" != "hosting" ]]; then
    rollback_local_signer_after_runtime_install || true
  fi
  current_root="$(readlink -f "$FASED_CONFIG_DIR/runtime/current" 2>/dev/null || true)"
  rollback_script="$current_root/scripts/install-managed-runtime.mjs"
  if [[ -z "$current_root" || ! -f "$rollback_script" || ! -e "$FASED_CONFIG_DIR/runtime/previous" ]]; then
    return 1
  fi
  echo "Managed runtime verification failed; restoring the previous release..." >&2
  if ! node "$rollback_script" \
    --rollback \
    --state-dir "$FASED_CONFIG_DIR" \
    --prefix "${FASED_NPM_GLOBAL_PREFIX:-$INSTALL_CACHE_DIR/npm-global}"; then
    return 1
  fi
  FASED_CLI_PATH="$FASED_CONFIG_DIR/bin/fased"
  if [[ "$(resolved_host_profile)" != "hosting" ]]; then
    "$FASED_CLI_PATH" gateway install --force >/dev/null 2>&1 || true
    restart_existing_gateway_service_after_install >/dev/null 2>&1 || true
  fi
  return 0
}

wait_for_gateway_health_after_restart() {
  if [[ -z "${FASED_CLI_PATH:-}" || ! -x "$FASED_CLI_PATH" ]]; then
    return 1
  fi
  local attempt
  for attempt in {1..20}; do
    if "$FASED_CLI_PATH" health --json --timeout 3000 >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

upsert_env_var() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { found = 0 }
      $0 ~ ("^" k "=") { print k "=" v; found = 1; next }
      { print }
      END { if (!found) print k "=" v }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
  chmod 600 "$file" 2>/dev/null || true
}

persist_managed_env_var() {
  local key="$1"
  local value="$2"
  local env_file="$FASED_CONFIG_DIR/.env"
  mkdir -p "$FASED_CONFIG_DIR"
  chmod 700 "$FASED_CONFIG_DIR" 2>/dev/null || true
  upsert_env_var "$env_file" "$key" "$value"
}

install_log_path() {
  local label="$1"
  local slug
  slug="$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
  mkdir -p "$INSTALL_LOG_DIR"
  printf '%s/install-%s-%s.log\n' "$INSTALL_LOG_DIR" "$(date -u +%Y%m%dT%H%M%SZ)" "${slug:-step}"
}

step_start() {
  local label="$1"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    block_line "$(color_yellow "•") ${label}..."
  else
    printf '%s %s\n' "$(color_yellow "•")" "$(color_yellow "${label}...")"
  fi
}

step_done() {
  local label="$1"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    block_line "$(color_green "✓") ${label}"
  else
    printf '%s %s\n' "$(color_green "✓")" "$label"
  fi
}

step_skip() {
  local label="$1"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    block_line "$(color_green "✓") $(color_dim "${label} unchanged")"
  else
    printf '%s %s\n' "$(color_green "✓")" "$(color_dim "${label} unchanged")"
  fi
}

SPINNER_PID=""

spinner_start() {
  local label="$1"
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    step_start "$label"
    return 0
  fi
  if [[ "$INSTALL_VERBOSE" == "1" || ! -t 1 ]]; then
    step_start "$label"
    return 0
  fi
  (
    local frame
    while true; do
      for frame in '-' '\' '|' '/'; do
        printf '\r%s %s %s' "$(color_yellow "•")" "$(color_yellow "$label")" "$(color_dim "$frame")"
        sleep 0.12
      done
    done
  ) &
  SPINNER_PID="$!"
}

spinner_clear() {
  if [[ "$INSTALL_STATUS_FRAME_OPEN" -eq 1 ]]; then
    return 0
  fi
  if [[ -n "${SPINNER_PID:-}" ]]; then
    kill "$SPINNER_PID" >/dev/null 2>&1 || true
    wait "$SPINNER_PID" 2>/dev/null || true
    SPINNER_PID=""
    if [[ -t 1 ]]; then
      printf '\r\033[K'
    fi
  fi
}

spinner_done() {
  local label="$1"
  spinner_clear
  step_done "$label"
}

spinner_failed() {
  local label="$1"
  spinner_clear
  printf '%s %s\n' "$(color_red "✕")" "$(color_red "$label")" >&2
}

run_logged_in() {
  local dir="$1"
  local label="$2"
  shift 2
  local log_path
  log_path="$(install_log_path "$label")"
  spinner_start "$label"
  if [[ "$INSTALL_VERBOSE" == "1" ]]; then
    (cd "$dir" && "$@")
    local verbose_status=$?
    if [[ "$verbose_status" -eq 0 ]]; then
      spinner_done "$label"
    else
      spinner_failed "$label"
    fi
    return "$verbose_status"
  fi
  if (cd "$dir" && "$@") >"$log_path" 2>&1; then
    spinner_done "$label"
    return 0
  fi
  spinner_failed "$label"
  printf '%s %s\n' "$(color_red "Failed:")" "$label" >&2
  printf '%s %s\n' "$(color_dim "Full log:")" "$log_path" >&2
  printf '%s\n' "$(color_dim "Last lines:")" >&2
  tail -n 30 "$log_path" >&2 || true
  return 1
}

fingerprint_targets() {
  local root="$1"
  shift
  local tmp
  tmp="$(mktemp)"
  local rel
  for rel in "$@"; do
    if [[ -d "$root/$rel" ]]; then
      find "$root/$rel" \
        -type f \
        ! -path '*/node_modules/*' \
        ! -path '*/dist/*' \
        ! -path '*/.turbo/*' \
        ! -path '*/.vite/*' \
        -print >>"$tmp"
    elif [[ -f "$root/$rel" ]]; then
      printf '%s\n' "$root/$rel" >>"$tmp"
    fi
  done
  if [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    printf 'empty\n'
    return 0
  fi
  sort -u "$tmp" | while IFS= read -r file; do
    if need_cmd sha256sum; then
      sha256sum "$file"
    elif need_cmd shasum; then
      shasum -a 256 "$file"
    else
      cksum "$file"
    fi
  done | if need_cmd sha256sum; then
    sha256sum
  elif need_cmd shasum; then
    shasum -a 256
  else
    cksum
  fi | awk '{print $1}'
  rm -f "$tmp"
}

cache_file_for() {
  local name="$1"
  mkdir -p "$INSTALL_CACHE_DIR"
  printf '%s/%s.sha256\n' "$INSTALL_CACHE_DIR" "$name"
}

cache_matches() {
  local name="$1"
  local fingerprint="$2"
  local cache_file
  cache_file="$(cache_file_for "$name")"
  [[ -f "$cache_file" && "$(cat "$cache_file" 2>/dev/null)" == "$fingerprint" ]]
}

write_cache() {
  local name="$1"
  local fingerprint="$2"
  local cache_file
  cache_file="$(cache_file_for "$name")"
  printf '%s\n' "$fingerprint" >"$cache_file"
}

upsert_managed_block() {
  local file="$1"
  local start_marker="$2"
  local end_marker="$3"
  local block="$4"
  local tmp
  mkdir -p "$(dirname "$file")"
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v start="$start_marker" -v end="$end_marker" '
      $0 == start { skipping = 1; next }
      $0 == end { skipping = 0; next }
      skipping != 1 { print }
    ' "$file" >"$tmp"
  else
    : >"$tmp"
  fi
  {
    printf '\n%s\n' "$start_marker"
    printf '%s\n' "$block"
    printf '%s\n' "$end_marker"
  } >>"$tmp"
  mv "$tmp" "$file"
}

configure_target_user_fased_shell_dir() {
  local target_user="$1"
  local target_home="$2"
  local target_repo_dir="$3"
  local start_marker="# >>> fased hosted shell directory >>>"
  local end_marker="# <<< fased hosted shell directory <<<"
  local block
  block=$(cat <<EOF
if [ -z "\${FASED_NO_AUTO_CD:-}" ] && [ -d "$target_repo_dir" ]; then
  case "\$-" in
    *i*) cd "$target_repo_dir" ;;
  esac
fi
EOF
)
  upsert_managed_block "$target_home/.bashrc" "$start_marker" "$end_marker" "$block"
  upsert_managed_block "$target_home/.profile" "$start_marker" "$end_marker" "$block"
  chown "$target_user:$target_user" "$target_home/.bashrc" "$target_home/.profile" 2>/dev/null || true
}

copy_bootstrap_ssh_keys_for_target_user() {
  local target_user="$1"
  local target_home="$2"
  local source_keys=""
  local candidate
  for candidate in "$HOME/.ssh/authorized_keys" "/root/.ssh/authorized_keys"; do
    if [[ -s "$candidate" ]]; then
      source_keys="$candidate"
      break
    fi
  done
  if [[ -z "$source_keys" ]]; then
    return 0
  fi

  mkdir -p "$target_home/.ssh"
  touch "$target_home/.ssh/authorized_keys"
  local tmp
  tmp="$(mktemp)"
  {
    cat "$target_home/.ssh/authorized_keys" 2>/dev/null || true
    cat "$source_keys"
  } | awk 'NF { print }' | sort -u >"$tmp"

  if need_cmd install; then
    install -m 600 -o "$target_user" -g "$target_user" "$tmp" "$target_home/.ssh/authorized_keys"
  else
    cp "$tmp" "$target_home/.ssh/authorized_keys"
    chmod 600 "$target_home/.ssh/authorized_keys"
    chown "$target_user:$target_user" "$target_home/.ssh/authorized_keys" 2>/dev/null || true
  fi
  rm -f "$tmp"
  chmod 700 "$target_home/.ssh"
  chown "$target_user:$target_user" "$target_home/.ssh" 2>/dev/null || true
  echo "== Root bootstrap: copied SSH authorized_keys to '$target_user' for tailnet SSH =="
}

REMOVED_BOOTSTRAP_CHECKOUT=""

remove_root_bootstrap_checkout_after_success() {
  local source_dir="$1"
  local target_repo_dir="$2"
  if [[ "${FASED_KEEP_BOOTSTRAP_CHECKOUT:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "$(id -u)" -ne 0 || "$HOSTING_REQUESTED" -ne 1 || "$RUN_ONBOARD" -ne 1 ]]; then
    return 0
  fi
  if [[ -z "$source_dir" || -z "$target_repo_dir" || "$source_dir" == "$target_repo_dir" ]]; then
    return 0
  fi
  if [[ "$source_dir" != "$HOME"/* || "$source_dir" == "$HOME" || "$source_dir" == "/" ]]; then
    return 0
  fi
  if [[ ! -f "$source_dir/install.sh" || ! -f "$source_dir/package.json" || ! -d "$source_dir/src" ]]; then
    return 0
  fi
  REMOVED_BOOTSTRAP_CHECKOUT="$source_dir"
  cd /
  rm -rf "$source_dir"
}

read_target_fased_config_value() {
  local target_user="$1"
  local js_expr="$2"
  local target_home
  target_home="$(getent passwd "$target_user" 2>/dev/null | cut -d: -f6)"
  if [[ -z "$target_home" ]]; then
    target_home="/home/$target_user"
  fi
  local config_path="$target_home/.fased/fased.json"
  if [[ ! -f "$config_path" || ! -r "$config_path" ]]; then
    return 0
  fi
  CONFIG_PATH="$config_path" JS_EXPR="$js_expr" node -e '
const fs = require("node:fs");
const configPath = process.env.CONFIG_PATH;
const expr = process.env.JS_EXPR;
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const value = Function("cfg", `"use strict"; return (${expr});`)(cfg);
  if (typeof value === "string" && value.trim()) {
    process.stdout.write(value.trim());
  }
} catch {}
' 2>/dev/null || true
}

build_hosted_dashboard_url() {
  local web_host="$1"
  local token="$2"
  local base_path="$3"
  WEB_HOST="$web_host" GATEWAY_TOKEN="$token" CONTROL_BASE_PATH="$base_path" node -e '
const host = String(process.env.WEB_HOST || "YOUR_VPS_TAILSCALE_NAME").trim();
const token = String(process.env.GATEWAY_TOKEN || "").trim();
const rawBasePath = String(process.env.CONTROL_BASE_PATH || "").trim();
const url = new URL(`https://${host}/`);
if (rawBasePath && rawBasePath !== "/") {
  const clean = rawBasePath.replace(/^\/+|\/+$/g, "");
  url.pathname = clean ? `/${clean}/` : "/";
}
if (token) {
  const hash = new URLSearchParams();
  hash.set("token", token);
  url.hash = `#${hash.toString()}`;
}
process.stdout.write(url.toString());
' 2>/dev/null || printf 'https://%s/' "$web_host"
}

print_hosted_handoff_block() {
  local target_user="$1"
  local target_repo_dir="$2"
  local tailscale_dns="$3"
  local removed_checkout="$4"
  local ssh_host="${tailscale_dns:-YOUR_VPS_TAILSCALE_NAME}"
  local web_host="${tailscale_dns:-YOUR_VPS_TAILSCALE_NAME}"
  local gateway_token="${5:-}"
  local control_base_path="${6:-}"
  local dashboard_url
  dashboard_url="$(build_hosted_dashboard_url "$web_host" "$gateway_token" "$control_base_path")"

  block_top "HOSTED ACCESS"
  block_line "Setup complete."
  block_line
  block_line "$(color_yellow "${C_BOLD}RUN AS${C_RESET}")"
  block_line "  $target_user"
  block_line
  block_line "$(color_yellow "${C_BOLD}WEB UI${C_RESET}")"
  block_line "  Open this on your own Tailscale-connected computer."
  block_line
  block_line "  $(color_green "$dashboard_url")"
  block_line
  block_line "$(color_yellow "${C_BOLD}TOKEN${C_RESET}")"
  if [[ -n "$gateway_token" ]]; then
    block_line "  Only paste this if the browser asks."
    block_line
    block_line "  $(color_green "$gateway_token")"
  else
    block_line "  $(color_yellow "(token not available in root handoff)")"
    block_line
    block_line "  Run fased dashboard --no-open as ${target_user} to print a fresh tokenized URL."
  fi
  block_line
  block_line "$(color_yellow "${C_BOLD}SSH${C_RESET}")"
  block_line "  Run:"
  block_line
  block_line "  $(color_green "ssh ${target_user}@${ssh_host}")"
  block_line
  block_line "  Starts in ${target_repo_dir}"
  block_line
  block_line "$(color_yellow "${C_BOLD}FALLBACK TUNNEL${C_RESET}")"
  block_line "  Run this locally and leave it open:"
  block_line
  block_line "  $(color_green "ssh -N -L 18789:127.0.0.1:18789 ${target_user}@${ssh_host}")"
  block_line
  block_line "  Then open:"
  block_line
  block_line "  $(color_green "http://localhost:18789/")"
  block_line
  block_line "$(color_yellow "${C_BOLD}LOCAL PORT BUSY${C_RESET}")"
  block_line "  If 18789 is already in use locally, use 18790 instead."
  block_line
  block_line "  $(color_green "ssh -N -L 18790:127.0.0.1:18789 ${target_user}@${ssh_host}")"
  block_line
  block_line "  Then open:"
  block_line
  block_line "  $(color_green "http://localhost:18790/")"
  block_line
  block_line "$(color_yellow "${C_BOLD}APP COMMANDS${C_RESET}")"
  block_line "  $(color_green "cd ${target_repo_dir}")"
  block_line "  $(color_green "fased status")"
  block_line "  $(color_green "fased dashboard --no-open")"
  block_line
  block_line "Use the app checkout for normal operation; root was only for bootstrap."
  if [[ -n "$removed_checkout" ]]; then
    block_line
    block_line "$(color_green "✓ Removed temporary root checkout")"
    block_line "$(color_yellow "Removed:") $(color_green "$removed_checkout")"
  fi
  block_bottom
}

restart_root_managed_hosted_gateway() {
  [[ "$(id -u)" -eq 0 ]] || {
    echo "The hosted Gateway service may only be restarted by the root installer coordinator." >&2
    return 1
  }
  systemctl daemon-reload
  systemctl restart fased-gateway.service

  local attempt=""
  local main_pid=""
  for attempt in {1..30}; do
    main_pid="$(systemctl show fased-gateway.service --property=MainPID --value 2>/dev/null || true)"
    if systemctl is-active --quiet fased-gateway.service && \
      [[ "$main_pid" =~ ^[0-9]+$ && "$main_pid" -gt 1 ]]; then
      return 0
    fi
    sleep 1
  done
  echo "The root-managed fased-gateway.service did not enter an active process state." >&2
  journalctl -u fased-gateway.service -n 40 --no-pager >&2 || true
  return 1
}

verify_root_coordinated_hosted_gateway() {
  local target_user="$1"
  local target_home="$2"
  local app_state_dir="$target_home/.fased"
  local app_cli="$app_state_dir/bin/fased"
  [[ "$(id -u)" -eq 0 && -x "$app_cli" ]] || return 1

  local attempt=""
  for attempt in {1..60}; do
    if systemctl is-active --quiet fased-gateway.service && \
      runuser -u "$target_user" -- env \
        HOME="$target_home" \
        FASED_STATE_DIR="$app_state_dir" \
        FASED_CONFIG_PATH="$app_state_dir/fased.json" \
        FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock \
        "$app_cli" health --json --timeout 3000 >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "The root-managed hosted Gateway did not pass its post-restart health check." >&2
  journalctl -u fased-gateway.service -n 40 --no-pager >&2 || true
  return 1
}

runtime_assets_ready() {
  [[ -f "$FASED_DIR/src/canvas-host/a2ui/a2ui.bundle.js" ]] || return 1
  [[ -f "$FASED_DIR/dist/canvas-host/a2ui/a2ui.bundle.js" ]] || return 1
  [[ -f "$FASED_DIR/dist/export-html/template.html" ]] || return 1
  [[ -f "$FASED_DIR/dist/export-html/vendor/marked.min.js" ]] || return 1
  [[ -f "$FASED_DIR/dist/bundled/boot-md/HOOK.md" ]] || return 1
  [[ -f "$FASED_DIR/dist/build-info.json" ]] || return 1
  [[ -f "$FASED_DIR/dist/cli/daemon-cli.js" ]] || return 1
}

reexec_as_app_user() {
  local target_user="${FASED_INSTALL_USER:-app}"
  local target_home
  if ! id -u "$target_user" >/dev/null 2>&1; then
    echo "== Root bootstrap: creating non-root user '$target_user' =="
    if need_cmd useradd; then
      useradd -m -s /bin/bash "$target_user"
    else
      adduser --disabled-password --gecos "" --shell /bin/bash "$target_user"
    fi
  fi
  usermod -s /bin/bash "$target_user" 2>/dev/null || true

  target_home="$(getent passwd "$target_user" | cut -d: -f6)"
  if [[ -z "$target_home" ]]; then
    target_home="/home/$target_user"
  fi
  local target_install_dir="${FASED_INSTALL_DIR:-$INSTALL_BASE_DIR}"
  if [[ -z "${FASED_INSTALL_DIR:-}" && "$target_install_dir" == "$HOME/fased" && "$target_home" != "$HOME" ]]; then
    target_install_dir="$target_home/fased"
  fi
  local target_repo_dir=""

  echo "== Root bootstrap: preparing repo for '$target_user' at $target_install_dir =="
  bootstrap_repo_for_target_user "$target_user" "$target_install_dir"

  target_repo_dir="$(resolve_fased_dir_from_base "$target_install_dir" || true)"
  if [[ -z "$target_repo_dir" ]]; then
    echo "Install bootstrap failed: could not find Fased repo under $target_install_dir" >&2
    echo "Expected a standalone fased repository checkout." >&2
    exit 1
  fi
  configure_target_user_fased_shell_dir "$target_user" "$target_home" "$target_repo_dir"
  copy_bootstrap_ssh_keys_for_target_user "$target_user" "$target_home"
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    prepare_hosting_root_prerequisites "$target_user" "$target_repo_dir"
    install_fixed_host_gateway_service "$target_repo_dir"
  fi

  local cmd="cd $(shell_quote "$target_repo_dir") && "
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    cmd+="env FASED_HOST_PROFILE=hosting FASED_HOST_ROOT_PREPARED=1 FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock "
    if [[ -n "$HOST_SIGNER_TRANSACTION_ID" ]]; then
      cmd+="FASED_HOST_UPDATE_TRANSACTION_ID=$(shell_quote "$HOST_SIGNER_TRANSACTION_ID") FASED_HOST_UPDATE_TRANSACTION_VERSION=$(shell_quote "$HOST_SIGNER_TRANSACTION_VERSION") "
    fi
  fi
  cmd+="./install.sh"
  cmd+=" --host-security-capable"
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    cmd+=" --release $(shell_quote "$HOSTING_RELEASE")"
  fi
  local pass_index=0
  while ((pass_index < ${#pass_args[@]})); do
    local arg="${pass_args[$pass_index]}"
    if [[ "$arg" == "--ts-authkey" || "$arg" == "--ts-authkey-file" ]]; then
      pass_index=$((pass_index + 2))
      continue
    fi
    cmd+=" $(shell_quote "$arg")"
    pass_index=$((pass_index + 1))
  done
  if [[ "$HOSTING_REPAIR_REQUESTED" -eq 1 ]]; then
    cmd+=" --repair-hosting"
  elif [[ "$LOCAL_REPAIR_REQUESTED" -eq 1 ]]; then
    cmd+=" --repair-local"
  fi

  cleanup_root_transaction() {
    local status=$?
    rollback_pending_host_signer_transaction_on_exit "$status"
  }
  trap cleanup_root_transaction EXIT

  echo "== Root bootstrap: re-executing installer as '$target_user' =="
  local child_status=0
  if need_cmd sudo; then
    if sudo -u "$target_user" -H bash -lc "$cmd"; then
      child_status=0
    else
      child_status=$?
    fi
  else
    if runuser -u "$target_user" -- bash -lc "$cmd"; then
      child_status=0
    else
      child_status=$?
    fi
  fi

  if [[ "$HOSTING_REQUESTED" -eq 1 && "$HOST_SIGNER_TRANSACTION_ACTIVE" -eq 1 ]]; then
    local app_state_dir="$target_home/.fased"
    local app_transaction_updater="$app_state_dir/updater/fased-managed-updater.mjs"
    if [[ "$child_status" -eq 0 && ! -f "$app_transaction_updater" ]]; then
      echo "Hosted transaction cannot verify a managed application runtime; refusing signer commit." >&2
      child_status=1
    fi
    if [[ "$child_status" -eq 0 ]]; then
      echo "Root coordinator: restarting the fixed hosted Gateway service..."
      if ! restart_root_managed_hosted_gateway; then
        child_status=1
      fi
    fi
    if [[ "$child_status" -eq 0 ]]; then
      echo "Verifying and finalizing the paired hosted app/signer transaction..."
      if runuser -u "$target_user" -- env \
        HOME="$target_home" \
        FASED_STATE_DIR="$app_state_dir" \
        FASED_CONFIG_PATH="$app_state_dir/fased.json" \
        FASED_HOST_UPDATER_SOCKET=/run/fased-host-updater/request.sock \
        FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock \
        node "$app_transaction_updater" hosted-transaction finalize --root-restarted; then
        HOST_SIGNER_DURABLE_COMMIT_DECISION=1
      else
        child_status=1
      fi
    fi
    if [[ "$child_status" -eq 0 ]] && \
      ! verify_root_coordinated_hosted_gateway "$target_user" "$target_home"; then
      child_status=1
    fi
    if [[ "$child_status" -ne 0 && -f "$app_state_dir/hosted-update-transaction.json" ]]; then
      local app_transaction_phase
      app_transaction_phase="$(node -e '
        const fs = require("node:fs");
        try {
          const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          process.stdout.write(String(value.phase || ""));
        } catch {}
      ' "$app_state_dir/hosted-update-transaction.json")"
      if [[ "$app_transaction_phase" == "gateway-verified" ]]; then
        HOST_SIGNER_DURABLE_COMMIT_DECISION=1
        echo "A durable hosted health decision is pending commit cleanup; resuming forward..." >&2
        if runuser -u "$target_user" -- env \
          HOME="$target_home" \
          FASED_STATE_DIR="$app_state_dir" \
          FASED_CONFIG_PATH="$app_state_dir/fased.json" \
          FASED_HOST_UPDATER_SOCKET=/run/fased-host-updater/request.sock \
          FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock \
          node "$app_transaction_updater" hosted-transaction finalize --root-restarted; then
          child_status=0
        fi
      fi
    fi
    if [[ "$child_status" -eq 0 ]]; then
      if node /usr/local/libexec/fased-host-updaterctl.mjs \
        "$HOST_SIGNER_TRANSACTION_VERSION" --commit-only >/dev/null; then
        HOST_SIGNER_TRANSACTION_ACTIVE=0
        if ! finalize_legacy_hosted_signer_migration; then
          echo "Hosted release committed, but legacy custody cleanup is incomplete; rerun the exact tagged repair from the provider root console." >&2
          child_status=1
        fi
      else
        echo "Hosted health passed, but the root signer commit is pending; rerun the exact tagged repair from the provider root console." >&2
        child_status=1
      fi
    elif [[ "$HOST_SIGNER_DURABLE_COMMIT_DECISION" -eq 0 ]]; then
      if [[ -f "$app_transaction_updater" ]]; then
        runuser -u "$target_user" -- env \
          HOME="$target_home" \
          FASED_STATE_DIR="$app_state_dir" \
          FASED_CONFIG_PATH="$app_state_dir/fased.json" \
          FASED_HOST_UPDATER_SOCKET=/run/fased-host-updater/request.sock \
          FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock \
          node "$app_transaction_updater" hosted-transaction rollback >/dev/null 2>&1 || true
      fi
      if node /usr/local/libexec/fased-host-updaterctl.mjs \
        "$HOST_SIGNER_TRANSACTION_VERSION" --rollback-only >/dev/null; then
        HOST_SIGNER_TRANSACTION_ACTIVE=0
      fi
    else
      echo "Hosted health passed; leaving the target app and signer active for forward recovery." >&2
    fi
  fi

  if [[ "$child_status" -eq 0 && "$HOSTING_REQUESTED" -eq 1 ]]; then
    systemctl is-active --quiet fased-signerd.service || child_status=1
    systemctl is-active --quiet fased-host-updater.service || child_status=1
    systemctl is-active --quiet fased-gateway.service || child_status=1
    if need_cmd sudo && runuser -u "$target_user" -- sudo -n true >/dev/null 2>&1; then
      echo "Hosted repair left passwordless sudo available to $target_user; refusing completion." >&2
      child_status=1
    fi
  fi

  if [[ "$child_status" -eq 0 && "$HOSTING_REQUESTED" -eq 1 && "$RUN_ONBOARD" -eq 1 ]]; then
    local tailscale_dns=""
    if need_cmd tailscale; then
      tailscale_dns="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(String(o?.Self?.DNSName||"").replace(/\.$/,""));}catch{}})' 2>/dev/null || true)"
    fi
    local gateway_token=""
    local control_base_path=""
    gateway_token="$(read_target_fased_config_value "$target_user" 'cfg?.gateway?.auth?.token')"
    control_base_path="$(read_target_fased_config_value "$target_user" 'cfg?.gateway?.controlUi?.basePath')"
    remove_root_bootstrap_checkout_after_success "$FASED_DIR" "$target_repo_dir"
    print_hosted_handoff_block "$target_user" "$target_repo_dir" "$tailscale_dns" "$REMOVED_BOOTSTRAP_CHECKOUT" "$gateway_token" "$control_base_path"
  fi

  exit "$child_status"
}

go_modern_enough() {
  local gocmd=""
  if [[ -x /usr/local/go/bin/go ]]; then
    gocmd="/usr/local/go/bin/go"
  elif need_cmd go; then
    gocmd="$(command -v go)"
  else
    return 1
  fi
  local v
  v="$("$gocmd" version 2>/dev/null | awk '{print $3}' | sed 's/^go//')"
  local major minor
  major="$(echo "$v" | cut -d. -f1)"
  minor="$(echo "$v" | cut -d. -f2)"
  [[ "${major:-0}" -gt 1 ]] || ([[ "${major:-0}" -eq 1 ]] && [[ "${minor:-0}" -ge 21 ]])
}

detect_total_mem_mb() {
  if [[ -r /proc/meminfo ]]; then
    awk '/^MemTotal:/ { printf "%d\n", $2 / 1024; exit }' /proc/meminfo
    return 0
  fi
  if need_cmd getconf; then
    local pages page_size
    pages="$(getconf _PHYS_PAGES 2>/dev/null || true)"
    page_size="$(getconf PAGE_SIZE 2>/dev/null || true)"
    if [[ -n "$pages" && -n "$page_size" ]]; then
      printf '%d\n' "$((pages * page_size / 1024 / 1024))"
      return 0
    fi
  fi
  printf '0\n'
}

node_options_with_old_space() {
  local base="$1"
  local old_space_mb="$2"
  if [[ "$base" == *"--max-old-space-size="* || -z "$old_space_mb" ]]; then
    printf '%s\n' "$base"
    return 0
  fi
  printf '%s%s--max-old-space-size=%s\n' "$base" "${base:+ }" "$old_space_mb"
}

recommended_onboard_old_space_mb() {
  if [[ -n "${FASED_ONBOARD_MAX_OLD_SPACE_MB:-}" ]]; then
    printf '%s\n' "$FASED_ONBOARD_MAX_OLD_SPACE_MB"
    return 0
  fi

  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb || true)"
  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 && "$total_mem_mb" -le 1536 ]]; then
    printf '1024\n'
    return 0
  fi
  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 && "$total_mem_mb" -le 2304 ]]; then
    printf '1280\n'
    return 0
  fi
  printf '1536\n'
}

resolved_core_build_profile() {
  if [[ -n "${FASED_BUILD_PROFILE:-}" ]]; then
    printf '%s\n' "$FASED_BUILD_PROFILE"
    return 0
  fi

  local profile
  profile="$(resolved_host_profile)"
  if [[ "$profile" == "hosting" ]]; then
    printf 'vps\n'
    return 0
  fi

  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb || true)"
  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 && "$total_mem_mb" -le 1536 ]]; then
    printf 'vps\n'
    return 0
  fi

  printf '\n'
}

has_active_swap() {
  if ! need_cmd swapon; then
    return 1
  fi
  swapon --show 2>/dev/null | tail -n +2 | grep -q .
}

configure_swapfile() {
  local swap_gb="$1"
  shift
  local runner=("$@")
  if [[ ! "$swap_gb" =~ ^[0-9]+$ || "$swap_gb" -le 0 ]]; then
    echo "Invalid swap size: ${swap_gb}G" >&2
    return 1
  fi

  if ! "${runner[@]}" fallocate -l "${swap_gb}G" /swapfile 2>/dev/null; then
    if ! "${runner[@]}" dd if=/dev/zero of=/swapfile bs=1M count=$((swap_gb * 1024)) status=none; then
      echo "Could not allocate /swapfile (${swap_gb}G)." >&2
      return 1
    fi
  fi
  if ! "${runner[@]}" chmod 600 /swapfile; then
    echo "Could not secure /swapfile permissions." >&2
    return 1
  fi
  if ! "${runner[@]}" mkswap /swapfile >/dev/null; then
    echo "Could not initialize /swapfile as swap." >&2
    return 1
  fi
  if ! "${runner[@]}" swapon /swapfile; then
    echo "Could not enable /swapfile swap." >&2
    return 1
  fi
  if [[ "${runner[*]}" == sudo\ -n ]]; then
    if ! sudo -n grep -q '^/swapfile ' /etc/fstab; then
      if ! echo '/swapfile none swap sw 0 0' | sudo -n tee -a /etc/fstab >/dev/null; then
        echo "Could not persist /swapfile in /etc/fstab." >&2
        return 1
      fi
    fi
  else
    if ! grep -q '^/swapfile ' /etc/fstab; then
      if ! echo '/swapfile none swap sw 0 0' >> /etc/fstab; then
        echo "Could not persist /swapfile in /etc/fstab." >&2
        return 1
      fi
    fi
  fi
}

ensure_low_memory_swap_if_possible() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    return 0
  fi

  local profile
  profile="$(resolved_host_profile || true)"
  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb)"
  if [[ -z "$total_mem_mb" || "$total_mem_mb" -eq 0 || "$total_mem_mb" -gt "$LOW_MEMORY_SWAP_THRESHOLD_MB" ]]; then
    return 0
  fi
  if has_active_swap; then
    return 0
  fi
  local swap_gb
  swap_gb="$(resolve_requested_swap_gb)"
  if [[ -z "$swap_gb" || "$swap_gb" == "0" ]]; then
    return 0
  fi

  local runner=()
  if [[ "$(id -u)" -eq 0 ]]; then
    runner=()
  elif need_cmd sudo && sudo -n true >/dev/null 2>&1; then
    runner=(sudo -n)
  else
    echo "== Low-memory host detected (${total_mem_mb} MiB RAM) but no swap is active =="
    if [[ "$profile" == "hosting" ]]; then
      echo "Hosting install cannot continue safely without ${swap_gb}G swap." >&2
      echo "Rerun the first hosted install as root with: ./install.sh --hosting" >&2
      return 1
    fi
    echo "== Continuing without automatic swap because passwordless sudo is unavailable =="
    return 0
  fi

  echo "== Low-memory host detected (${total_mem_mb} MiB RAM); configuring ${swap_gb}G swap for install stability =="
  if ! configure_swapfile "$swap_gb" "${runner[@]}"; then
    if [[ "$profile" == "hosting" ]]; then
      echo "Hosting install cannot continue safely because swap setup failed." >&2
      return 1
    fi
    echo "== Automatic swap setup failed; continuing because this is not the hosting profile =="
    return 0
  fi
}

pnpm_install_with_adaptive_profile() {
  local total_mem_mb
  total_mem_mb="$(detect_total_mem_mb)"
  local child_concurrency=2
  local network_concurrency=8
  local retry_child_concurrency=1
  local retry_network_concurrency=2
  local node_opts="${NODE_OPTIONS:-}"

  if [[ -n "$total_mem_mb" && "$total_mem_mb" -gt 0 ]]; then
    if [[ "$total_mem_mb" -le 1536 ]]; then
      child_concurrency=1
      network_concurrency=2
      retry_network_concurrency=1
      node_opts="${node_opts}${node_opts:+ }--max-old-space-size=512"
    elif [[ "$total_mem_mb" -le 2304 ]]; then
      child_concurrency=1
      network_concurrency=4
      node_opts="${node_opts}${node_opts:+ }--max-old-space-size=768"
    fi
  fi

  spinner_start "Installing dependencies"
  local install_log
  install_log="$(install_log_path "pnpm install")"
  if [[ "$INSTALL_VERBOSE" == "1" ]]; then
    env NODE_OPTIONS="$node_opts" pnpm --dir "$FASED_DIR" install --child-concurrency="$child_concurrency" --network-concurrency="$network_concurrency"
    local verbose_status=$?
    if [[ "$verbose_status" -eq 0 ]]; then
      spinner_done "Dependencies ready"
    else
      spinner_failed "Installing dependencies"
    fi
    return "$verbose_status"
  fi
  if env NODE_OPTIONS="$node_opts" pnpm --dir "$FASED_DIR" install --child-concurrency="$child_concurrency" --network-concurrency="$network_concurrency" >"$install_log" 2>&1; then
    spinner_done "Dependencies ready"
    return 0
  fi

  spinner_clear
  echo "Dependency install needed a slower retry."
  ensure_low_memory_swap_if_possible || true
  local retry_log
  retry_log="$(install_log_path "pnpm install retry")"
  spinner_start "Retrying dependencies"
  env NODE_OPTIONS="${node_opts}${node_opts:+ }--max-old-space-size=512" \
    pnpm --dir "$FASED_DIR" install --child-concurrency="$retry_child_concurrency" --network-concurrency="$retry_network_concurrency" >"$retry_log" 2>&1 || {
      spinner_failed "Retrying dependencies"
      echo "Failed: dependency install" >&2
      echo "Log: $install_log" >&2
      echo "Retry log: $retry_log" >&2
      tail -n 80 "$retry_log" >&2 || true
      return 1
    }
  spinner_done "Dependencies ready"
}

install_modern_go_linux() {
  local arch
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$arch" in
    amd64|x86_64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "Unsupported CPU arch for Go auto-install: $arch" >&2; return 1 ;;
  esac
  local goversion="${FASED_GO_VERSION:-1.23.6}"
  local url="https://go.dev/dl/go${goversion}.linux-${arch}.tar.gz"
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "$url" -o "$tmp"
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf "$tmp"
  rm -f "$tmp"
  sudo ln -sf /usr/local/go/bin/go /usr/local/bin/go
}

ensure_early_swap_for_hosting() {
  if [[ "$HOSTING_REQUESTED" -ne 1 || "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]]; then
    return 0
  fi

  local swap_gb
  swap_gb="$(resolve_requested_swap_gb)"
  if [[ -z "$swap_gb" || "$swap_gb" == "0" ]]; then
    return 0
  fi

  if swapon --show | tail -n +2 | grep -q .; then
    return 0
  fi

  echo "== Root bootstrap: configuring ${swap_gb}G swap before dependency install =="
  if ! configure_swapfile "$swap_gb"; then
    echo "Root hosting bootstrap cannot continue safely because swap setup failed." >&2
    exit 1
  fi
}

install_missing_deps_as_root_if_needed() {
  if [[ "$AUTO_INSTALL" -ne 1 || "$(uname -s)" != "Linux" || "$(id -u)" -ne 0 ]]; then
    return 0
  fi

  local missing=()
  for cmd in git curl jq; do
    need_cmd "$cmd" || missing+=("$cmd")
  done
  if ! need_cmd node; then
    missing+=("node")
  fi

  if [[ ${#missing[@]} -gt 0 ]] || ! node_runtime_ok; then
    echo "== Root bootstrap: installing missing system dependencies =="
    if [[ ${#missing[@]} -gt 0 ]]; then
      echo "Installing missing dependencies: ${missing[*]}"
    fi
    if ! node_runtime_ok; then
      echo "Installing or selecting compatible Node runtime: $(node_runtime_issue)"
    fi
    install_linux_system_dependencies 0
  fi
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    install_github_cli_for_attestations
  fi
}

bootstrap_repo_for_target_user() {
  local target_user="$1"
  local target_install_dir="$2"
  local source_repo=""

  if [[ "$HOSTING_REQUESTED" -eq 1 && "$(id -u)" -eq 0 ]]; then
    local target_parent=""
    local tagged_staging=""
    local prior_checkout=""
    local attested_commit=""
    target_parent="$(dirname "$target_install_dir")"
    tagged_staging="${target_install_dir}.tagged-staging.$$"
    prior_checkout="${target_install_dir}.previous.$(date +%Y%m%d%H%M%S)"
    attested_commit="$(awk -F'"' '/^[[:space:]]*"commit"[[:space:]]*:/ { print $4; exit }' "$FASED_DIR/dist/build-info.json")"
    [[ "$attested_commit" =~ ^[a-f0-9]{40}$ ]] || {
      echo "Attested Hosting bundle does not contain a valid source commit identity." >&2
      exit 1
    }
    install -d -m 0755 -o "$target_user" -g "$target_user" "$target_parent"
    runuser -u "$target_user" -- rm -rf -- "$tagged_staging"
    echo "== Root bootstrap: preparing exact app checkout v${HOSTING_RELEASE} as $target_user =="
    runuser -u "$target_user" -- git clone \
      --branch "v${HOSTING_RELEASE}" \
      --depth 1 \
      --config core.hooksPath=/dev/null \
      https://github.com/fased-ai/fased.git \
      "$tagged_staging"
    local tagged_head=""
    tagged_head="$(runuser -u "$target_user" -- git -C "$tagged_staging" rev-parse HEAD)"
    local tagged_package_version=""
    tagged_package_version="$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "$tagged_staging/package.json")"
    [[ "$tagged_head" == "$attested_commit" && "$tagged_package_version" == "$HOSTING_RELEASE" ]] || {
      runuser -u "$target_user" -- rm -rf -- "$tagged_staging"
      echo "Exact tagged app checkout does not match the attested bundle commit/version." >&2
      exit 1
    }
    if [[ -e "$target_install_dir" || -L "$target_install_dir" ]]; then
      runuser -u "$target_user" -- mv -- "$target_install_dir" "$prior_checkout" || {
        runuser -u "$target_user" -- rm -rf -- "$tagged_staging"
        echo "Could not preserve the prior app checkout as $prior_checkout." >&2
        exit 1
      }
      echo "Preserved the previous unprivileged app checkout at: $prior_checkout"
    fi
    runuser -u "$target_user" -- mv -- "$tagged_staging" "$target_install_dir"
    return 0
  fi

  if is_fased_repo_dir "$FASED_DIR"; then
    source_repo="$(cd "$FASED_DIR" && pwd)"
    refresh_checkout_from_origin "$source_repo" "Root bootstrap"
  fi

  mkdir -p "$(dirname "$target_install_dir")"
  if [[ ! -e "$target_install_dir" ]]; then
    if [[ -n "$source_repo" && -d "$source_repo/.git" ]]; then
      echo "== Root bootstrap: copying current checkout into $target_install_dir =="
      git clone --local --no-hardlinks "$source_repo" "$target_install_dir"
      ensure_checkout_origin_remote "$target_install_dir"
    else
      echo "== Root bootstrap: cloning repository into $target_install_dir =="
      git clone "$INSTALL_REPO_URL" "$target_install_dir"
    fi
  elif [[ -d "$target_install_dir/.git" ]]; then
    if [[ -n "$source_repo" && -d "$source_repo/.git" ]]; then
      local source_head=""
      local target_head=""
      source_head="$(git -C "$source_repo" rev-parse HEAD 2>/dev/null || true)"
      target_head="$(git -C "$target_install_dir" rev-parse HEAD 2>/dev/null || true)"
      if [[ -n "$source_head" && "$source_head" != "$target_head" ]]; then
        local temp_clone="${target_install_dir}.refresh.$$"
        rm -rf "$temp_clone"
        echo "== Root bootstrap: refreshing $target_install_dir from current checkout =="
        git clone --local --no-hardlinks "$source_repo" "$temp_clone"
        ensure_checkout_origin_remote "$temp_clone"
        rm -rf "$target_install_dir"
        mv "$temp_clone" "$target_install_dir"
      else
        echo "== Root bootstrap: existing repository detected, reusing $target_install_dir =="
      fi
    else
      echo "== Root bootstrap: existing repository detected, reusing $target_install_dir =="
    fi
  else
    echo "Refusing to overwrite existing path: $target_install_dir" >&2
    echo "That path exists but is not a recognized fased repository checkout." >&2
    echo "Set FASED_INSTALL_DIR to a new directory or clean the existing one, then rerun." >&2
    exit 1
  fi

  ensure_checkout_origin_remote "$target_install_dir"
  local target_repo_dir=""
  target_repo_dir="$(resolve_fased_dir_from_base "$target_install_dir" || true)"
  if [[ -n "$target_repo_dir" ]]; then
    refresh_checkout_from_origin "$target_repo_dir" "Root bootstrap"
  fi

  chown -R "$target_user:$target_user" "$target_install_dir" 2>/dev/null || true
}

install_host_maintenance_helper() {
  local helper_path="/usr/local/sbin/fased-host-maintenance"
  cat >"$helper_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" != "0" ]]; then
  echo "Fased Hosting prerequisite maintenance must run from a root provider-console session." >&2
  exit 1
fi

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

command_name="${1:-}"

valid_port() {
  [[ "$1" =~ ^[0-9]+$ && "$1" -ge 1 && "$1" -le 65535 ]]
}

read_valid_port() {
  local port=""
  IFS= read -r port || true
  valid_port "$port" || {
    echo "invalid port" >&2
    exit 2
  }
  printf '%s\n' "$port"
}

read_tailscale_authkey_file() {
  local authkey_file=""
  IFS= read -r authkey_file || true
  [[ "$authkey_file" =~ ^/run/fased-tailscale-authkey\.[A-Za-z0-9]+$ ]] || {
    echo "invalid ephemeral Tailscale auth-key file" >&2
    exit 2
  }
  [[ -f "$authkey_file" && ! -L "$authkey_file" ]] || {
    echo "unsafe ephemeral Tailscale auth-key file" >&2
    exit 2
  }
  local owner="" mode="" links="" size=""
  read -r owner mode links size <<<"$(stat -c '%u %a %h %s' "$authkey_file" 2>/dev/null || true)"
  [[ "$owner" == "0" && "$mode" == "600" && "$links" == "1" && \
    "$size" =~ ^[0-9]+$ && "$size" -gt 0 && "$size" -le 4096 ]] || {
    echo "unsafe ephemeral Tailscale auth-key ownership, mode, or size" >&2
    exit 2
  }
  awk 'NR == 1 && $0 ~ /^tskey-auth-[A-Za-z0-9_-]+$/ { valid=1; next } { valid=0 } END { exit valid ? 0 : 1 }' \
    "$authkey_file" || {
    echo "invalid Tailscale auth key" >&2
    exit 2
  }
  printf '%s\n' "$authkey_file"
}

install_tailscale_if_needed() {
  if command -v tailscale >/dev/null 2>&1; then
    return 0
  fi

  tailscale_manual_install_guidance() {
    echo "Install Tailscale from its signed distribution package repository, then rerun Hosting setup:" >&2
    echo "  https://pkgs.tailscale.com/stable/" >&2
  }

  install_tailscale_from_apt_repository() (
    set -euo pipefail

    [[ -r /etc/os-release ]] || {
      echo "Cannot identify this apt host: /etc/os-release is unavailable." >&2
      tailscale_manual_install_guidance
      return 1
    }

    # shellcheck disable=SC1091
    . /etc/os-release
    local distro="${ID:-}"
    local codename="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
    case "$distro" in
      ubuntu|debian) ;;
      *)
        echo "Automatic signed Tailscale apt setup supports Ubuntu and Debian only (found ${distro:-unknown})." >&2
        tailscale_manual_install_guidance
        return 1
        ;;
    esac
    [[ "$codename" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || {
      echo "Cannot determine a safe Ubuntu/Debian codename for the Tailscale repository." >&2
      tailscale_manual_install_guidance
      return 1
    }

    local repository_base="https://pkgs.tailscale.com/stable/${distro}/${codename}"
    local keyring_path="/usr/share/keyrings/tailscale-archive-keyring.gpg"
    local list_path="/etc/apt/sources.list.d/tailscale.list"
    local expected_source="deb [signed-by=${keyring_path}] https://pkgs.tailscale.com/stable/${distro} ${codename} main"
    local temp_dir=""
    temp_dir="$(mktemp -d)"
    trap 'rm -rf -- "$temp_dir"' EXIT

    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --output "$temp_dir/tailscale-archive-keyring.gpg" \
      "${repository_base}.noarmor.gpg"
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --output "$temp_dir/tailscale.list" \
      "${repository_base}.tailscale-keyring.list"

    [[ -s "$temp_dir/tailscale-archive-keyring.gpg" ]] || {
      echo "The Tailscale apt signing key download was empty." >&2
      return 1
    }
    [[ "$(wc -c <"$temp_dir/tailscale-archive-keyring.gpg")" -le 1048576 ]] || {
      echo "The Tailscale apt signing key exceeded the expected size limit." >&2
      return 1
    }
    local actual_source=""
    actual_source="$(sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "$temp_dir/tailscale.list")"
    [[ "$actual_source" == "$expected_source" ]] || {
      echo "Refusing an unexpected Tailscale apt repository definition." >&2
      return 1
    }

    install -d -m 0755 /usr/share/keyrings /etc/apt/sources.list.d
    install -m 0644 "$temp_dir/tailscale-archive-keyring.gpg" "$keyring_path"
    install -m 0644 "$temp_dir/tailscale.list" "$list_path"

    apt-get \
      -o "Dir::Etc::sourcelist=${list_path}" \
      -o 'Dir::Etc::sourceparts=-' \
      -o 'Acquire::AllowInsecureRepositories=false' \
      -o 'Acquire::AllowDowngradeToInsecureRepositories=false' \
      -o 'APT::Get::AllowUnauthenticated=false' \
      update
    env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get \
      -o 'APT::Get::AllowUnauthenticated=false' \
      install -y --no-install-recommends tailscale
    command -v tailscale >/dev/null 2>&1
  )

  install_tailscale_from_rpm_repository() (
    set -euo pipefail

    [[ -r /etc/os-release ]] || {
      echo "Cannot identify this RPM host: /etc/os-release is unavailable." >&2
      tailscale_manual_install_guidance
      return 1
    }

    # shellcheck disable=SC1091
    . /etc/os-release
    local distro="${ID:-}"
    local version_id="${VERSION_ID:-}"
    local major="${version_id%%.*}"
    local repository_path=""
    case "$distro" in
      fedora)
        repository_path="fedora"
        ;;
      centos)
        [[ "$major" =~ ^[0-9]+$ ]] || {
          echo "Cannot determine the CentOS major version for the Tailscale repository." >&2
          tailscale_manual_install_guidance
          return 1
        }
        repository_path="centos/${major}"
        ;;
      rhel|rocky|almalinux|ol|cloudlinux)
        [[ "$major" =~ ^[0-9]+$ ]] || {
          echo "Cannot determine the RHEL-family major version for the Tailscale repository." >&2
          tailscale_manual_install_guidance
          return 1
        }
        repository_path="rhel/${major}"
        ;;
      *)
        echo "Automatic signed Tailscale RPM setup supports Fedora and RHEL-family hosts only (found ${distro:-unknown})." >&2
        tailscale_manual_install_guidance
        return 1
        ;;
    esac

    local repository_url="https://pkgs.tailscale.com/stable/${repository_path}/tailscale.repo"
    local repository_file="/etc/yum.repos.d/tailscale.repo"
    local temp_dir=""
    temp_dir="$(mktemp -d)"
    trap 'rm -rf -- "$temp_dir"' EXIT

    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --output "$temp_dir/tailscale.repo" "$repository_url"
    cat >"$temp_dir/expected.repo" <<RPM_REPOSITORY
[tailscale-stable]
name=Tailscale stable
baseurl=https://pkgs.tailscale.com/stable/${repository_path}/\$basearch
enabled=1
type=rpm
repo_gpgcheck=1
gpgcheck=1
gpgkey=https://pkgs.tailscale.com/stable/${repository_path}/repo.gpg
RPM_REPOSITORY
    cmp -s "$temp_dir/tailscale.repo" "$temp_dir/expected.repo" || {
      echo "Refusing an unexpected or signature-disabled Tailscale RPM repository definition." >&2
      return 1
    }

    install -d -m 0755 /etc/yum.repos.d
    install -m 0644 "$temp_dir/tailscale.repo" "$repository_file"

    local package_manager=""
    if command -v dnf5 >/dev/null 2>&1; then
      package_manager="dnf5"
    elif command -v dnf >/dev/null 2>&1; then
      package_manager="dnf"
    elif command -v yum >/dev/null 2>&1; then
      package_manager="yum"
    else
      echo "No supported RPM package manager is available for Tailscale." >&2
      tailscale_manual_install_guidance
      return 1
    fi
    "$package_manager" install -y \
      --setopt=tailscale-stable.gpgcheck=1 \
      --setopt=tailscale-stable.repo_gpgcheck=1 \
      tailscale
    command -v tailscale >/dev/null 2>&1
  )

  if command -v apt-get >/dev/null 2>&1; then
    install_tailscale_from_apt_repository
  elif command -v dnf5 >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    install_tailscale_from_rpm_repository
  else
    echo "Fased will not execute a remote Tailscale install script as root." >&2
    tailscale_manual_install_guidance
    return 1
  fi
}

enable_tailscaled_if_present() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now tailscaled >/dev/null 2>&1 || true
  fi
}

tailnet_ssh_ingress() {
  if command -v ufw >/dev/null 2>&1; then
    if ufw status | grep -qi '^Status: active'; then
      ufw insert 1 allow in on tailscale0 to any port 22 proto tcp || ufw allow in on tailscale0 to any port 22 proto tcp
    else
      ufw allow in on tailscale0 to any port 22 proto tcp >/dev/null 2>&1 || true
    fi
  elif command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
  fi
}

install_package_for_hosting() {
  local package_name="$1"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y "$package_name"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "$package_name"
  elif command -v dnf5 >/dev/null 2>&1; then
    dnf5 install -y "$package_name"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "$package_name"
  else
    echo "unsupported package manager" >&2
    return 1
  fi
}

firewall_baseline() {
  if command -v ufw >/dev/null 2>&1 || command -v apt-get >/dev/null 2>&1; then
    command -v ufw >/dev/null 2>&1 || install_package_for_hosting ufw
    ufw default deny incoming
    ufw default allow outgoing
    ufw insert 1 allow in on tailscale0 to any port 22 proto tcp || ufw allow in on tailscale0 to any port 22 proto tcp
    ufw insert 2 allow in on tailscale0 to any port 443 proto tcp || ufw allow in on tailscale0 to any port 443 proto tcp
    ufw deny 22/tcp || true
    ufw --force enable
  elif command -v firewall-cmd >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1 || command -v dnf5 >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    command -v firewall-cmd >/dev/null 2>&1 || install_package_for_hosting firewalld
    systemctl enable --now firewalld
    firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 >/dev/null 2>&1 || true
    firewall-cmd --permanent --zone=public --remove-service=ssh >/dev/null 2>&1 || true
    firewall-cmd --permanent --zone=public --remove-port=22/tcp >/dev/null 2>&1 || true
    firewall-cmd --reload
  else
    echo "no supported firewall manager found: need ufw or firewalld" >&2
    exit 1
  fi
}

enable_automatic_updates() {
  if command -v apt-get >/dev/null 2>&1; then
    install_package_for_hosting unattended-upgrades
    systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
    systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
  elif command -v dnf >/dev/null 2>&1 || command -v dnf5 >/dev/null 2>&1; then
    install_package_for_hosting dnf5-plugin-automatic || install_package_for_hosting dnf-automatic
    if [[ -f /etc/dnf/automatic.conf ]]; then
      sed -i 's/^apply_updates[[:space:]]*=.*/apply_updates = yes/' /etc/dnf/automatic.conf
    fi
    systemctl enable --now dnf5-automatic.timer >/dev/null 2>&1 || systemctl enable --now dnf-automatic.timer
  elif command -v yum >/dev/null 2>&1; then
    install_package_for_hosting dnf-automatic || install_package_for_hosting yum-cron
    systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 || systemctl enable --now yum-cron
  else
    echo "unsupported package manager for automatic updates" >&2
    exit 1
  fi
}

case "$command_name" in
  harden-ssh)
    install -d -m 0755 /etc/ssh/sshd_config.d
    if [[ -f /etc/ssh/sshd_config ]] && ! grep -Eiq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf([[:space:]]|$)' /etc/ssh/sshd_config; then
      cp -a /etc/ssh/sshd_config "/etc/ssh/sshd_config.fased-pre-dropin.$(date +%Y%m%d%H%M%S).bak" || true
      tmp_sshd_config="$(mktemp)"
      {
        printf '%s\n' 'Include /etc/ssh/sshd_config.d/*.conf'
        cat /etc/ssh/sshd_config
      } >"$tmp_sshd_config"
      cat "$tmp_sshd_config" >/etc/ssh/sshd_config
      rm -f "$tmp_sshd_config"
    fi
    cat >/etc/ssh/sshd_config.d/01-fased-hardening.conf <<'SSHD_CONF'
PasswordAuthentication no
PermitRootLogin no
SSHD_CONF
    if command -v sshd >/dev/null 2>&1; then
      sshd -t
    fi
    systemctl restart ssh || systemctl restart sshd
    ;;
  enable-dnf-automatic)
    if [[ -f /etc/dnf/automatic.conf ]]; then
      sed -i 's/^apply_updates[[:space:]]*=.*/apply_updates = yes/' /etc/dnf/automatic.conf
    fi
    ;;
  tailscale-status)
    tailscale status
    ;;
  tailscale-status-json)
    tailscale status --json
    ;;
  tailscale-ip4)
    tailscale ip -4
    ;;
  tailscale-logout)
    tailscale logout
    ;;
  tailscale-up-ssh)
    tailscale up --ssh
    ;;
  tailscale-up-reset-ssh)
    tailscale logout >/dev/null 2>&1 || true
    tailscale up --ssh --accept-routes --reset
    ;;
  tailscale-up-authkey-ssh)
    authkey_file="$(read_tailscale_authkey_file)"
    tailscale up --auth-key="file:${authkey_file}" --ssh
    unset authkey_file
    ;;
  tailscale-up-reset-authkey-ssh)
    authkey_file="$(read_tailscale_authkey_file)"
    tailscale logout >/dev/null 2>&1 || true
    tailscale up --ssh --accept-routes --reset --auth-key="file:${authkey_file}"
    unset authkey_file
    ;;
  tailscale-serve)
    serve_port="$(read_valid_port)"
    tailscale serve --bg "http://127.0.0.1:${serve_port}" || tailscale serve https / "http://127.0.0.1:${serve_port}"
    ;;
  tailscale-serve-status)
    tailscale serve status
    ;;
  tailscale-install-start)
    install_tailscale_if_needed
    enable_tailscaled_if_present
    command -v tailscale >/dev/null 2>&1
    ;;
  tailnet-ssh-ingress)
    tailnet_ssh_ingress
    ;;
  firewall-baseline)
    firewall_baseline
    ;;
  fail2ban-enable)
    install_package_for_hosting fail2ban
    systemctl enable --now fail2ban
    ;;
  automatic-updates)
    enable_automatic_updates
    ;;
  *)
    echo "usage: fased-host-maintenance <host-maintenance-command>" >&2
    exit 64
    ;;
esac
EOF
  chmod 755 "$helper_path"
}

install_fixed_host_gateway_service() {
  local target_user="${FASED_INSTALL_USER:-app}"
  local target_home
  target_home="$(getent passwd "$target_user" | cut -d: -f6)"
  [[ -n "$target_home" ]] || target_home="/home/$target_user"
  local target_repo_dir="${1:-$target_home/fased}"
  [[ "$target_user" != "root" && "$target_user" =~ ^[A-Za-z0-9_.@-]+$ ]] || {
    echo "Invalid hosted Gateway app account." >&2
    exit 1
  }
  [[ "$target_repo_dir" == "$target_home/"* && "$target_repo_dir" =~ ^/[A-Za-z0-9_./@-]+$ ]] || {
    echo "Hosted Gateway checkout must remain below the app account home." >&2
    exit 1
  }

  install -d -m 0755 -o root -g root /usr/local/libexec
  cat >/usr/local/libexec/fased-gateway-launch <<EOF
#!/usr/bin/env bash
set -euo pipefail
while [[ ! -s "${target_home}/.fased/fased.json" ]]; do
  sleep 1
done
exec /bin/bash "${target_repo_dir}/scripts/start-managed.sh"
EOF
  chown root:root /usr/local/libexec/fased-gateway-launch
  chmod 0755 /usr/local/libexec/fased-gateway-launch

  # The root-owned unit has fixed inputs. It may execute app-owned application code only as
  # the app account; no app-supplied unit text or privileged lifecycle hook is accepted.
  cat >/etc/systemd/system/fased-gateway.service <<EOF
[Unit]
Description=Fased Gateway (managed)
After=fased-signerd.service network-online.target
Wants=fased-signerd.service network-online.target

[Service]
Type=simple
User=${target_user}
Group=${target_user}
WorkingDirectory=${target_repo_dir}
Environment=HOME=${target_home}
Environment=FASED_GATEWAY_MODE=managed
Environment=FASED_MANAGED_INTERNAL=1
Environment=FASED_GATEWAY_PORT=18789
Environment=FASED_HOST_PROFILE=hosting
Environment=FASED_WALLET_LOCAL_SIGNER_SOCKET=/run/fased-signerd/app.sock
ExecStart=/usr/local/libexec/fased-gateway-launch
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${target_home}/.fased
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF
  chown root:root /etc/systemd/system/fased-gateway.service
  chmod 0644 /etc/systemd/system/fased-gateway.service
  rm -f /usr/local/sbin/fased-install-gateway-service
  sync -f /usr/local/libexec/fased-gateway-launch /usr/local/libexec /etc/systemd/system/fased-gateway.service /etc/systemd/system 2>/dev/null || true
  systemctl daemon-reload
  systemctl enable fased-gateway.service >/dev/null
  systemctl restart fased-gateway.service
}

run_tailscale_auth_from_private_file() (
  set -euo pipefail
  local source_file="$1"
  local helper="$2"
  local helper_command="$3"
  local canonical_source=""
  local source_owner="" source_mode="" source_links="" source_size=""
  local ephemeral_file=""

  [[ -n "$source_file" && -f "$source_file" && ! -L "$source_file" ]] || {
    echo "--ts-authkey-file must name a regular, non-symlink file." >&2
    exit 1
  }
  canonical_source="$(readlink -f -- "$source_file" 2>/dev/null || true)"
  [[ -n "$canonical_source" && -f "$canonical_source" && ! -L "$canonical_source" ]] || {
    echo "Could not resolve a safe --ts-authkey-file." >&2
    exit 1
  }
  read -r source_owner source_mode source_links source_size \
    <<<"$(stat -c '%u %a %h %s' "$canonical_source" 2>/dev/null || true)"
  [[ "$source_mode" =~ ^[0-7]{3,4}$ ]] || {
    echo "--ts-authkey-file has an invalid mode." >&2
    exit 1
  }
  local source_mode_value=$((8#$source_mode))
  [[ "$source_owner" == "0" && \
    $((source_mode_value & 8#077)) -eq 0 && $((source_mode_value & 8#400)) -ne 0 && \
    "$source_links" == "1" && "$source_size" =~ ^[0-9]+$ && \
    "$source_size" -gt 0 && "$source_size" -le 4096 ]] || {
    echo "--ts-authkey-file must be root-owned, owner-readable, mode 0600/0400, one link, and at most 4096 bytes." >&2
    exit 1
  }
  awk 'NR == 1 && $0 ~ /^tskey-auth-[A-Za-z0-9_-]+$/ { valid=1; next } { valid=0 } END { exit valid ? 0 : 1 }' \
    "$canonical_source" || {
    echo "--ts-authkey-file does not contain exactly one valid Tailscale auth key." >&2
    exit 1
  }

  umask 077
  ephemeral_file="$(mktemp /run/fased-tailscale-authkey.XXXXXXXX)"
  trap 'rm -f -- "${ephemeral_file:-}"' EXIT HUP INT TERM
  install -m 0600 -o root -g root "$canonical_source" "$ephemeral_file"
  sync -f "$ephemeral_file" 2>/dev/null || true
  printf '%s\n' "$ephemeral_file" | "$helper" "$helper_command"
)

hosting_tailnet_confirmation_is_explicit() {
  case "${FASED_HOSTING_TAILNET_SSH_CONFIRMED:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_hosting_root_prerequisites() {
  local target_user="$1"
  local target_repo_dir="$2"
  local helper="/usr/local/sbin/fased-host-maintenance"
  local marker="/etc/fased/hosting-prerequisites"
  local tailscale_dns=""
  local tailscale_ip=""
  local previously_confirmed=0

  [[ "$(id -u)" -eq 0 ]] || {
    echo "Hosted prerequisites must run in the provider root console." >&2
    exit 1
  }
  [[ -x "$helper" && -f "$helper" && ! -L "$helper" ]] || {
    echo "Root-owned Hosting prerequisite helper is unavailable." >&2
    exit 1
  }
  local helper_owner="" helper_mode=""
  read -r helper_owner helper_mode <<<"$(stat -c '%u %a' "$helper")"
  [[ "$helper_owner" == "0" && $((8#$helper_mode & 8#22)) -eq 0 ]] || {
    echo "Hosting prerequisite helper ownership or mode is unsafe." >&2
    exit 1
  }

  "$helper" tailscale-install-start
  if ! tailscale ip -4 >/dev/null 2>&1; then
    if [[ -n "$TAILSCALE_AUTHKEY_FILE" ]]; then
      run_tailscale_auth_from_private_file \
        "$TAILSCALE_AUTHKEY_FILE" "$helper" tailscale-up-authkey-ssh
    elif [[ -t 0 || -r /dev/tty ]]; then
      echo "Tailscale needs authentication. Complete the browser URL printed below."
      "$helper" tailscale-up-ssh </dev/tty
    else
      echo "Non-interactive Hosting setup requires --ts-authkey-file with a root-owned mode-0600 key file." >&2
      exit 1
    fi
  fi
  tailscale_ip="$(tailscale ip -4 2>/dev/null | head -n 1 | tr -d '[:space:]')"
  tailscale_dns="$(tailscale status --json 2>/dev/null | node -e '
    let raw="";
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(raw);
        process.stdout.write(String(value?.Self?.DNSName || "").replace(/\.$/, ""));
      } catch {}
    });
  ' 2>/dev/null || true)"
  [[ "$tailscale_ip" =~ ^100\.[0-9]+\.[0-9]+\.[0-9]+$ && -n "$tailscale_dns" ]] || {
    echo "Tailscale did not return a tailnet IPv4 address and DNS identity." >&2
    exit 1
  }

  if [[ -f "$marker" && ! -L "$marker" ]] && \
    grep -Fxq "tailnetSshConfirmed=true" "$marker" 2>/dev/null; then
    previously_confirmed=1
  fi
  if [[ "$previously_confirmed" -ne 1 ]] && ! hosting_tailnet_confirmation_is_explicit; then
    cat <<EOF

Before public SSH is disabled, verify access from your own Tailscale-connected computer:
  tailscale ping ${tailscale_dns}
  tailscale ssh ${target_user}@${tailscale_dns}

The login must open ${target_repo_dir}. Keep this provider root console open.
EOF
    if [[ -r /dev/tty ]]; then
      local confirmation=""
      read -r -p "Type the Tailscale DNS name to confirm the test succeeded: " confirmation </dev/tty
      [[ "$confirmation" == "$tailscale_dns" ]] || {
        echo "Tailnet SSH confirmation did not match; host lock-down was not applied." >&2
        exit 1
      }
    else
      echo "Set FASED_HOSTING_TAILNET_SSH_CONFIRMED=1 only after an out-of-band SSH test." >&2
      exit 1
    fi
  fi

  printf '18789\n' | "$helper" tailscale-serve
  tailscale serve status 2>/dev/null | grep -Fq '127.0.0.1:18789' || {
    echo "Tailscale Serve did not acknowledge the fixed loopback Gateway route." >&2
    exit 1
  }
  "$helper" tailnet-ssh-ingress
  "$helper" firewall-baseline
  "$helper" harden-ssh
  "$helper" fail2ban-enable
  "$helper" automatic-updates

  install -d -m 0755 -o root -g root /etc/fased
  cat >/etc/fased/signerd-webauthn.env <<EOF
FASED_WALLET_WEBAUTHN_RP_ID=${tailscale_dns}
FASED_WALLET_WEBAUTHN_ORIGINS=https://${tailscale_dns}
EOF
  chown root:root /etc/fased/signerd-webauthn.env
  chmod 0644 /etc/fased/signerd-webauthn.env
  systemctl restart fased-signerd.service
  systemctl is-active --quiet fased-signerd.service || {
    echo "Signer did not restart with the root-persisted Tailscale WebAuthn identity." >&2
    exit 1
  }

  cat >"$marker" <<EOF
schemaVersion=2
release=${HOSTING_RELEASE}
gatewayPort=18789
tailscaleDns=${tailscale_dns}
tailnetSshConfirmed=true
tailscaleServeReady=true
firewallReady=true
sshHardened=true
fail2banReady=true
automaticUpdatesReady=true
signerReady=true
appSudoDisabled=true
preparedBy=root
EOF
  chown root:root "$marker"
  chmod 0644 "$marker"
  sync -f "$marker" /etc/fased 2>/dev/null || true
}

ensure_host_boundary_accounts() {
  local target_user="${FASED_INSTALL_USER:-app}"
  local signer_user="${FASED_SIGNER_USER:-fased-signer}"
  local gateway_group="${FASED_GATEWAY_GROUP:-fased-gateway}"
  if ! id -u "$target_user" >/dev/null 2>&1; then
    if need_cmd useradd; then
      useradd -m -s /bin/bash "$target_user"
    else
      adduser --disabled-password --gecos "" --shell /bin/bash "$target_user"
    fi
  fi
  getent group "$gateway_group" >/dev/null 2>&1 || groupadd --system "$gateway_group"
  if ! id -u "$signer_user" >/dev/null 2>&1; then
    if need_cmd useradd; then
      useradd --system --home-dir /var/lib/fased-signerd --shell /usr/sbin/nologin "$signer_user"
    else
      adduser --system --home /var/lib/fased-signerd --shell /usr/sbin/nologin "$signer_user"
    fi
  fi
  passwd -l "$signer_user" >/dev/null 2>&1 || true
  usermod -aG "$gateway_group" "$target_user"
  for admin_group in sudo wheel; do
    if getent group "$admin_group" >/dev/null 2>&1; then
      gpasswd -d "$target_user" "$admin_group" >/dev/null 2>&1 || true
    fi
  done
  rm -f \
    "/etc/sudoers.d/fased-install-${target_user}" \
    "/etc/sudoers.d/fased-host-maintenance-${target_user}" \
    "/etc/sudoers.d/fased-gateway-${target_user}-maintenance"
  if need_cmd sudo && runuser -u "$target_user" -- sudo -n true >/dev/null 2>&1; then
    echo "Hosting security boundary cannot use an app account with passwordless sudo: $target_user" >&2
    echo "Remove custom sudoers access for this dedicated account, then rerun the exact tagged repair from the provider root console." >&2
    exit 1
  fi
}

install_host_signer_and_updater_services() {
  local target_user="${FASED_INSTALL_USER:-app}"
  local signer_user="${FASED_SIGNER_USER:-fased-signer}"
  local gateway_group="${FASED_GATEWAY_GROUP:-fased-gateway}"
  local gateway_gid
  local version
  gateway_gid="$(getent group "$gateway_group" | cut -d: -f3)"
  version="$(node -p "require(process.argv[1]).version" "$FASED_DIR/package.json" 2>/dev/null || true)"
  [[ "$gateway_gid" =~ ^[0-9]+$ && "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
    echo "Could not resolve hosted signer group or release version." >&2
    exit 1
  }
  if [[ -n "${FASED_HOST_SIGNER_BINARY:-}" ]]; then
    echo "FASED_HOST_SIGNER_BINARY is no longer accepted for hosted custody." >&2
    echo "The root updater must fetch and attest the exact tagged signer artifact." >&2
    exit 1
  fi
  local existing_signer_dropins
  existing_signer_dropins="$(systemctl show fased-signerd.service --property=DropInPaths --value 2>/dev/null || true)"
  if [[ -n "$existing_signer_dropins" ]]; then
    echo "Custom fased-signerd systemd drop-ins prevent an exact transactional rollback:" >&2
    echo "  $existing_signer_dropins" >&2
    echo "Consolidate the prior signer launch policy into its main unit, then rerun the exact tagged repair from the provider root console." >&2
    exit 1
  fi

  install -d -m 0755 -o root -g root /usr/local/libexec
  install -d -m 0755 -o root -g root /usr/local/sbin
  install -d -m 0755 -o root -g root /usr/local/share/fased/signer-policies
  install -d -m 0755 -o root -g root /opt/fased/signer
  install -m 0755 -o root -g root "$FASED_DIR/scripts/fased-host-updater.mjs" /usr/local/libexec/fased-host-updater.mjs
  install -m 0755 -o root -g root "$FASED_DIR/scripts/fased-host-updaterctl.mjs" /usr/local/libexec/fased-host-updaterctl.mjs
  rm -f /usr/local/libexec/fased-host-bootstrapd.mjs /usr/local/libexec/fased-host-bootstrapctl.mjs
  rm -rf /run/fased-host-bootstrap
  rm -f /var/log/fased-host-bootstrap.log
  install -m 0755 -o root -g root "$FASED_DIR/scripts/migrate-hosted-signer-v2.mjs" /usr/local/libexec/migrate-hosted-signer-v2.mjs
  install -m 0700 -o root -g root "$FASED_DIR/scripts/fased-signer-owner-policy.mjs" /usr/local/libexec/fased-signer-owner-policy.mjs
  install -m 0755 -o root -g root "$FASED_DIR/scripts/fased-signer-enroll-hosting.sh" /usr/local/sbin/fased-signer-enroll
  install -m 0755 -o root -g root "$FASED_DIR/scripts/fased-signer-policy-hosting.sh" /usr/local/sbin/fased-signer-policy
  install -m 0755 -o root -g root "$FASED_DIR/scripts/fased-signer-network-hosting.sh" /usr/local/sbin/fased-signer-network
  install -m 0644 -o root -g root "$FASED_DIR/config/signer-policies/README.md" /usr/local/share/fased/signer-policies/README.md
  install -m 0644 -o root -g root "$FASED_DIR/config/signer-policies/agent.json.template" /usr/local/share/fased/signer-policies/agent.json.template
  install -m 0644 -o root -g root "$FASED_DIR/config/signer-policies/mining.json.template" /usr/local/share/fased/signer-policies/mining.json.template
  install -m 0644 -o root -g root "$FASED_DIR/config/signer-policies/vault.json.template" /usr/local/share/fased/signer-policies/vault.json.template
  install -m 0644 -o root -g root "$FASED_DIR/config/signer-policies/network.json.template" /usr/local/share/fased/signer-policies/network.json.template
  install -d -m 0700 -o root -g root /var/lib/fased-host-updater
  install -d -m 0755 -o root -g root /var/lib/fased-signer-update-gate
  install -d -m 0700 -o "$signer_user" -g "$signer_user" /var/lib/fased-signerd
  install -d -m 0755 -o root -g root /etc/fased
  if [[ ! -f /etc/fased/signerd-webauthn.env ]]; then
    install -m 0644 -o root -g root /dev/null /etc/fased/signerd-webauthn.env
  fi
  install -d -m 0755 -o root -g root /etc/systemd/system/fased-gateway.service.d
  cat >/etc/systemd/system/fased-gateway.service.d/20-fased-update-gate.conf <<'EOF'
[Unit]
After=fased-host-updater.service
Wants=fased-host-updater.service
ConditionPathExists=!/var/lib/fased-host-updater/gateway-update-gate
EOF
  chmod 0644 /etc/systemd/system/fased-gateway.service.d/20-fased-update-gate.conf
  sync -f /etc/systemd/system/fased-gateway.service.d/20-fased-update-gate.conf
  sync -f /etc/systemd/system/fased-gateway.service.d
  if [[ ! -f /etc/fased/host-updater-channel ]]; then
    printf 'stable\n' >/etc/fased/host-updater-channel
    chmod 0644 /etc/fased/host-updater-channel
  fi

  cat >/etc/systemd/system/fased-host-updater.service <<EOF
[Unit]
Description=Fased verified native signer updater
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
RuntimeDirectory=fased-host-updater
RuntimeDirectoryMode=0755
StateDirectory=fased-host-updater
StateDirectoryMode=0700
UMask=0117
Environment=HOME=/var/lib/fased-host-updater
ExecStart=$(command -v node) /usr/local/libexec/fased-host-updater.mjs --socket-gid ${gateway_gid}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/opt/fased/signer /var/lib/fased-host-updater /var/lib/fased-signer-update-gate /var/lib/fased-signerd /run/fased-host-updater /etc/systemd/system
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 /etc/systemd/system/fased-host-updater.service
  sync -f /usr/local/libexec/fased-host-updater.mjs
  sync -f /usr/local/libexec/fased-host-updaterctl.mjs
  sync -f /usr/local/libexec/fased-signer-owner-policy.mjs
  sync -f /usr/local/sbin/fased-signer-enroll
  sync -f /usr/local/sbin/fased-signer-policy
  sync -f /usr/local/sbin/fased-signer-network
  sync -f /usr/local/share/fased/signer-policies/README.md
  sync -f /usr/local/share/fased/signer-policies/agent.json.template
  sync -f /usr/local/share/fased/signer-policies/mining.json.template
  sync -f /usr/local/share/fased/signer-policies/vault.json.template
  sync -f /usr/local/share/fased/signer-policies/network.json.template
  sync -f /etc/systemd/system/fased-host-updater.service
  sync -f /usr/local/libexec /usr/local/sbin /usr/local/share/fased/signer-policies /etc/systemd/system
  systemctl daemon-reload
  systemctl enable fased-host-updater.service >/dev/null
  systemctl restart fased-host-updater.service

  local prepare_result
  prepare_result="$(node /usr/local/libexec/fased-host-updaterctl.mjs "$version" --prepare-only)"
  HOST_SIGNER_TRANSACTION_ID="$(node -e 'const value=JSON.parse(process.argv[1]);process.stdout.write(String(value.transactionId||""))' "$prepare_result")"
  [[ "$HOST_SIGNER_TRANSACTION_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || {
    echo "Root signer updater did not return a transaction ID." >&2
    exit 1
  }
  HOST_SIGNER_TRANSACTION_VERSION="$version"
  HOST_SIGNER_TRANSACTION_ACTIVE=1
  trap rollback_pending_host_signer_transaction_on_exit EXIT

  cat >/etc/systemd/system/fased-signerd.service <<EOF
[Unit]
Description=Fased native wallet signer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${signer_user}
Group=${signer_user}
SupplementaryGroups=${gateway_group}
RuntimeDirectory=fased-signerd
RuntimeDirectoryMode=0755
StateDirectory=fased-signerd
StateDirectoryMode=0700
UMask=0077
Environment=HOME=/var/lib/fased-signerd
EnvironmentFile=-/etc/fased/signerd-webauthn.env
ExecStart=/opt/fased/signer/fased-signerd -socket /run/fased-signerd/app.sock -control-socket /run/fased-signerd/control.sock -socket-mode 0660 -socket-group ${gateway_group} -state-db /var/lib/fased-signerd/state.db -master-key /var/lib/fased-signerd/master.key -update-gate /var/lib/fased-signer-update-gate/active -pid-file /run/fased-signerd/fased-signerd.pid -audit-log /var/lib/fased-signerd/audit.jsonl
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
LockPersonality=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 /etc/systemd/system/fased-signerd.service
  sync -f /etc/systemd/system/fased-signerd.service
  sync -f /etc/systemd/system
  systemctl daemon-reload
  systemctl enable fased-signerd.service >/dev/null

  if systemctl list-unit-files fased-gateway.service --no-legend 2>/dev/null | grep -q '^fased-gateway.service'; then
    systemctl stop fased-gateway.service
  fi

  node /usr/local/libexec/fased-host-updaterctl.mjs "$version" --activate-only >/dev/null
  systemctl is-active --quiet fased-signerd.service || {
    echo "Root-managed fased-signerd did not become active." >&2
    journalctl -u fased-signerd.service -n 40 --no-pager >&2 || true
    exit 1
  }
  node --input-type=module --eval \
    'const { probeSignerV2 } = await import("file:///usr/local/libexec/fased-host-updater.mjs"); await probeSignerV2();' || {
    echo "Root-managed fased-signerd did not acknowledge protocol v2 and signer-owned custody." >&2
    journalctl -u fased-signerd.service -n 40 --no-pager >&2 || true
    exit 1
  }
  cat <<'EOF'
Hosted signer owner handoff
---------------------------
Fresh signer-owned wallets remain deny-all. Enrollment and policy activation are
separate host-administrator actions; neither the Gateway nor the app account can run them.

After onboarding creates a signer-owned wallet, use a root SSH/provider-console session:
  1. Copy /usr/local/share/fased/signer-policies/network.json.template to a
     root-owned mode-0600 file, set the exact RPC endpoints, then run:
       /usr/local/sbin/fased-signer-network --wallet-id <native-id> --network-file /root/fased-network.json
  2. /usr/local/sbin/fased-signer-enroll [authenticator-label]
  3. cp /usr/local/share/fased/signer-policies/<role>.json.template /root/fased-<role>-policy.json
  4. Set walletId to the canonical native signer ID (lowercase, separators become
     underscores; do not use a different friendly registry ID), replace every
     REPLACE_WITH_ value, review the exact destinations/caps, then run:
       chmod 0600 /root/fased-<role>-policy.json
       /usr/local/sbin/fased-signer-policy --initial-install --policy-file /root/fased-<role>-policy.json

Copying a template or enrolling a passkey does not enable signing.
EOF
}

migrate_legacy_hosted_signer_if_needed() {
  local target_user="${FASED_INSTALL_USER:-app}"
  local signer_user="${FASED_SIGNER_USER:-fased-signer}"
  local target_home
  local signer_home="/home/${signer_user}"
  local policy_file="/etc/fased/signer-migration-policies.json"
  local marker_file="/var/lib/fased-host-updater/signer-v1-migration.pending"
  local -a legacy_keystores=()
  target_home="$(getent passwd "$target_user" | cut -d: -f6)"
  [[ -n "$target_home" ]] || target_home="/home/${target_user}"

  shopt -s nullglob
  legacy_keystores+=("${target_home}/.fased/wallet"/keystore-*.enc)
  legacy_keystores+=("${signer_home}/.fased/wallet"/keystore-*.enc)
  shopt -u nullglob
  if [[ "${#legacy_keystores[@]}" -gt 0 || -f "$marker_file" ]]; then
    if [[ ! -f "$policy_file" ]]; then
      echo "A previous hosted wallet requires a fail-closed signer-v2 migration." >&2
      echo "Create root-owned ${policy_file} (mode 0600) with each expected wallet address and explicit policy, then rerun:" >&2
      echo "Use the verified release-asset repair procedure at:" >&2
      echo "  https://docs.fased.ai/install/vps#advanced-verify-the-bootstrap-first" >&2
      echo "After verifying the tagged install.sh attestation, run the verified file with --repair-hosting --release v${HOSTING_RELEASE}." >&2
      echo "Legacy key files were not changed." >&2
      exit 1
    fi
    /opt/fased/signer/fased-signerd admin migration hosted-v1 \
      --phase prepare \
      --control-socket /run/fased-signerd/control.sock \
      --policy-file "$policy_file" \
      --app-home "$target_home" \
      --legacy-signer-home "$signer_home" \
      --state-dir /var/lib/fased-signerd \
      --marker-file "$marker_file"
  fi
}

finalize_legacy_hosted_signer_migration() {
  local target_user="${FASED_INSTALL_USER:-app}"
  local signer_user="${FASED_SIGNER_USER:-fased-signer}"
  local target_home
  local signer_home="/home/${signer_user}"
  local policy_file="/etc/fased/signer-migration-policies.json"
  local marker_file="/var/lib/fased-host-updater/signer-v1-migration.pending"
  local -a legacy_keystores=()
  target_home="$(getent passwd "$target_user" | cut -d: -f6)"
  [[ -n "$target_home" ]] || target_home="/home/${target_user}"

  shopt -s nullglob
  legacy_keystores+=("${target_home}/.fased/wallet"/keystore-*.enc)
  legacy_keystores+=("${signer_home}/.fased/wallet"/keystore-*.enc)
  shopt -u nullglob
  if [[ "${#legacy_keystores[@]}" -gt 0 || -f "$marker_file" ]]; then
    [[ -f "$policy_file" ]] || {
      echo "Signer migration policy disappeared before commit; refusing cleanup." >&2
      return 1
    }
    /opt/fased/signer/fased-signerd admin migration hosted-v1 \
      --phase commit \
      --control-socket /run/fased-signerd/control.sock \
      --policy-file "$policy_file" \
      --app-home "$target_home" \
      --legacy-signer-home "$signer_home" \
      --state-dir /var/lib/fased-signerd \
      --marker-file "$marker_file"
  fi

  if need_cmd pkill; then
    pkill -u "$signer_user" -f "${signer_home}/.fased/bin/fased-signerd" >/dev/null 2>&1 || true
  fi
  rm -f \
    "${target_home}/.fased/wallet/local-signer.sock" \
    "${signer_home}/.fased/wallet/local-signer.sock" \
    /usr/local/sbin/fased-signer-maintenance \
    /usr/local/sbin/fased-signer-isolation
}

assert_verified_hosting_root_source() {
  [[ "$HOSTING_REQUESTED" -eq 1 && "$(id -u)" -eq 0 ]] || return 0
  if [[ "$SOURCE_INSTALL_REQUESTED" -eq 1 || "${FASED_SOURCE_INSTALL:-0}" == "1" || "${FASED_HOSTING_SOURCE_INSTALL:-0}" == "1" ]]; then
    echo "VPS Hosting root setup cannot install privileged assets from a source checkout." >&2
    echo "Use the exact tagged, attested release bootstrap from the provider root console." >&2
    exit 1
  fi
  [[ "$HOSTING_RELEASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "VPS Hosting root setup requires an exact stable release identity." >&2
    echo "Start again with --release vX.Y.Z or --release latest from the provider root console." >&2
    exit 1
  }
  local canonical_source=""
  local canonical_marker=""
  canonical_source="$(readlink -f "$FASED_DIR" 2>/dev/null || true)"
  canonical_marker="$(readlink -f "$VERIFIED_HOSTING_BUNDLE" 2>/dev/null || true)"
  local expected_prefix="/var/lib/fased-installer/releases/v${HOSTING_RELEASE}/"
  if [[ -z "$canonical_source" || "$canonical_source" != "$canonical_marker" || \
    ! "$canonical_source" =~ ^${expected_prefix}[a-f0-9]{64}/extract/package$ ]]; then
    echo "Refusing privileged Hosting setup from an unverified or caller-owned source tree:" >&2
    echo "  ${canonical_source:-unknown}" >&2
    echo "Start at the provider root console with the exact tagged release bootstrap." >&2
    exit 1
  fi
  [[ ! -e "$canonical_source/.git" ]] || {
    echo "Refusing privileged Hosting setup from a Git checkout, even when it appears clean." >&2
    exit 1
  }
  local marker="$canonical_source/.fased-hosting-bundle-verified"
  [[ -f "$marker" && ! -L "$marker" ]] || {
    echo "Verified Hosting bundle marker is missing or unsafe." >&2
    exit 1
  }
  local marker_owner="" marker_mode="" marker_links=""
  read -r marker_owner marker_mode marker_links <<<"$(stat -c '%u %a %h' "$marker")"
  [[ "$marker_owner" == "0" && "$marker_mode" == "600" && "$marker_links" == "1" ]] || {
    echo "Verified Hosting bundle marker ownership or mode is unsafe." >&2
    exit 1
  }
  grep -Fxq "version=${HOSTING_RELEASE}" "$marker" || {
    echo "Verified Hosting bundle release identity is inconsistent." >&2
    exit 1
  }
  grep -Eq '^sha256=[a-f0-9]{64}$' "$marker" || {
    echo "Verified Hosting bundle digest marker is invalid." >&2
    exit 1
  }
  grep -Eq '^commit=[a-f0-9]{40}$' "$marker" || {
    echo "Verified Hosting bundle commit marker is invalid." >&2
    exit 1
  }
  local marker_digest=""
  marker_digest="$(sed -n 's/^sha256=//p' "$marker")"
  [[ "$canonical_source" == "${expected_prefix}${marker_digest}/extract/package" ]] || {
    echo "Verified Hosting bundle path does not match its attested digest." >&2
    exit 1
  }
  local marker_commit=""
  local build_commit=""
  local build_version=""
  marker_commit="$(sed -n 's/^commit=//p' "$marker")"
  [[ -f "$canonical_source/dist/build-info.json" && ! -L "$canonical_source/dist/build-info.json" ]] || {
    echo "Verified Hosting bundle build identity is missing or unsafe." >&2
    exit 1
  }
  build_commit="$(awk -F'"' '/^[[:space:]]*"commit"[[:space:]]*:/ { print $4; exit }' "$canonical_source/dist/build-info.json")"
  build_version="$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "$canonical_source/dist/build-info.json")"
  [[ "$build_commit" == "$marker_commit" && "$build_commit" =~ ^[a-f0-9]{40}$ && "$build_version" == "$HOSTING_RELEASE" ]] || {
    echo "Verified Hosting bundle build commit/version does not match its root marker." >&2
    exit 1
  }
  local package_version=""
  package_version="$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "$canonical_source/package.json")"
  [[ "$package_version" == "$HOSTING_RELEASE" ]] || {
    echo "Verified Hosting bundle package version does not match v${HOSTING_RELEASE}." >&2
    exit 1
  }
  if find "$canonical_source" -xdev \( ! -user root -o -perm /022 \) -print -quit | grep -q .; then
    echo "Verified Hosting bundle contains files not owned by root or writable by group/other." >&2
    exit 1
  fi
  if find "$canonical_source" -xdev ! -type f ! -type d -print -quit | grep -q . || \
    find "$canonical_source" -xdev -type f -links +1 -print -quit | grep -q .; then
    echo "Verified Hosting bundle contains a symlink, special file, or hardlinked regular file." >&2
    exit 1
  fi
  local privileged_asset=""
  for privileged_asset in \
    install.sh \
    scripts/fased-host-updater.mjs \
    scripts/fased-host-updaterctl.mjs \
    scripts/fased-signer-enroll-hosting.sh \
    scripts/fased-signer-network-hosting.sh \
    scripts/fased-signer-policy-hosting.sh; do
    local asset_path="$canonical_source/$privileged_asset"
    [[ -f "$asset_path" && ! -L "$asset_path" ]] || {
      echo "Verified Hosting bundle is missing a safe privileged asset: $privileged_asset" >&2
      exit 1
    }
  done
}

if [[ "$(id -u)" -eq 0 ]]; then
  assert_verified_hosting_root_source
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    ensure_host_boundary_accounts
    install_host_maintenance_helper
  fi
  ensure_early_swap_for_hosting
  install_missing_deps_as_root_if_needed
  best_effort_enable_root_host_time_sync
  if [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    install_host_signer_and_updater_services
    migrate_legacy_hosted_signer_if_needed
  fi
  reexec_as_app_user
fi

if [[ ! -f "$FASED_DIR/package.json" || ! -d "$FASED_DIR/src" ]]; then
  echo "== Bootstrap repository =="
  if ! need_cmd git; then
    if [[ "$AUTO_INSTALL" -eq 1 ]]; then
      echo "git is missing; installing bootstrap dependencies first."
      install_supported_system_dependencies
      hash -r 2>/dev/null || true
    fi
  fi
  if ! need_cmd git; then
    echo "git is required to bootstrap the repository checkout." >&2
    echo "Install git manually or rerun with --auto-install on a supported OS." >&2
    exit 1
  fi
  if [[ ! -e "$INSTALL_BASE_DIR" ]]; then
    mkdir -p "$(dirname "$INSTALL_BASE_DIR")"
    git clone "$INSTALL_REPO_URL" "$INSTALL_BASE_DIR"
  elif [[ -d "$INSTALL_BASE_DIR/.git" ]]; then
    :
  else
    echo "Refusing to overwrite existing path: $INSTALL_BASE_DIR" >&2
    echo "That path exists but is not a recognized fased repository checkout." >&2
    echo "Set --install-dir to a new directory or clean the existing one, then rerun." >&2
    exit 1
  fi
  BOOTSTRAP_REPO_DIR="$(resolve_fased_dir_from_base "$INSTALL_BASE_DIR" || true)"
  if [[ -z "$BOOTSTRAP_REPO_DIR" ]]; then
    echo "Bootstrap failed: could not find install.sh under $INSTALL_BASE_DIR" >&2
    echo "Expected a standalone fased repository checkout." >&2
    exit 1
  fi
  exec "$BOOTSTRAP_REPO_DIR/install.sh" "${pass_args[@]}"
fi

if [[ "$(id -u)" -ne 0 ]] && ! pass_args_contains "--host-security-capable" && is_app_service_session; then
  pass_args+=(--host-maintenance-session)
fi

refresh_current_checkout_and_reexec_if_needed

handle_existing_local_state

REPO_ROOT="$(resolve_repo_root)"
assert_marker_matches_repo "$REPO_ROOT"
prefer_compatible_user_node_if_available || prefer_compatible_system_node_if_available || true
export COREPACK_HOME="${COREPACK_HOME:-$INSTALL_CACHE_DIR/corepack}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT="${COREPACK_ENABLE_DOWNLOAD_PROMPT:-0}"
export npm_config_cache="${npm_config_cache:-$INSTALL_CACHE_DIR/npm-cache}"
mkdir -p "$COREPACK_HOME" "$npm_config_cache"
if [[ -d "$INSTALL_CACHE_DIR/npm-global/bin" ]]; then
  export PATH="$INSTALL_CACHE_DIR/npm-global/bin:$PATH"
  hash -r 2>/dev/null || true
fi

missing=()
required_tools=(git curl)
if use_prebuilt_release_runtime; then
  required_tools+=(npm)
else
  required_tools+=(pnpm)
fi
for cmd in "${required_tools[@]}"; do
  need_cmd "$cmd" || missing+=("$cmd")
done
if ! need_cmd node; then
  missing+=("node")
fi

if [[ ${#missing[@]} -gt 0 || ! node_runtime_ok ]]; then
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Installing missing dependencies: ${missing[*]}"
  fi
  if ! node_runtime_ok && node_runtime_is_user_managed; then
    print_node_runtime_help
    exit 1
  fi
  if ! node_runtime_ok; then
    echo "Installing or selecting compatible Node runtime: $(node_runtime_issue)"
  fi
  if [[ "$AUTO_INSTALL" -eq 1 ]]; then
    install_supported_system_dependencies
  else
    cat <<'EOF_HELP'
Install missing tools, then rerun install.sh:
  - git
  - curl
  - node (Node 24 recommended, or v22.14+ with node:sqlite)
  - pnpm

Automatic install:
  ./install.sh --auto-install

Supported auto-install package managers:
  - apt-get on Debian/Ubuntu/Kali/WSL Ubuntu
  - dnf/dnf5 on Fedora, CentOS, AlmaLinux, Rocky Linux, CloudLinux, Oracle Linux, Amazon Linux
  - yum on older RHEL-family systems
  - zypper on openSUSE/SLES
  - apk on Alpine
  - pacman on Arch
  - pkg on FreeBSD
  - Homebrew on macOS

Disable auto install:
  ./install.sh --no-auto-install
EOF_HELP
    exit 1
  fi
fi

if ! node_runtime_ok; then
  print_node_runtime_help
  exit 1
fi
if use_prebuilt_release_runtime || [[ "$(uname -s)" == "Darwin" ]]; then
  install_github_cli_for_attestations
fi

FASED_INSTALL_VERSION="$(node -e 'const fs=require("fs");try{const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(o.version||"0.0.0")}catch{process.stdout.write("0.0.0")}' "$FASED_DIR/package.json" 2>/dev/null || printf '0.0.0')"
print_installer_banner "$FASED_INSTALL_VERSION"
status_frame_start

export CI="${CI:-1}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
section "System preparation"
ensure_low_memory_swap_if_possible
build_old_space_mb="$(recommended_onboard_old_space_mb)"
build_node_options="$(node_options_with_old_space "${NODE_OPTIONS:-}" "$build_old_space_mb")"
if use_prebuilt_release_runtime; then
  install_prebuilt_release_runtime
else
  pnpm_install_with_adaptive_profile
fi

if [[ -n "${FASED_SAT_PROGRAM_ID:-}" && -n "${FASED_SAT_BOND_PROGRAM_ID:-}" && -n "${FASED_SAT_MINT_ADDRESS:-}" && -n "${FASED_SAT_MINT_PROGRAM_ID:-}" ]]; then
  persist_managed_env_var "FASED_SAT_PROGRAM_ID" "$FASED_SAT_PROGRAM_ID"
  persist_managed_env_var "FASED_SAT_BOND_PROGRAM_ID" "$FASED_SAT_BOND_PROGRAM_ID"
  persist_managed_env_var "FASED_SAT_MINT_ADDRESS" "$FASED_SAT_MINT_ADDRESS"
  persist_managed_env_var "FASED_SAT_MINT_PROGRAM_ID" "$FASED_SAT_MINT_PROGRAM_ID"
else
  :
fi
export FASED_SAT_BOND_LAYOUT_PATH="${FASED_SAT_BOND_LAYOUT_PATH:-$FASED_DIR/token/sat/bond-api/bond-position-layout.json}"
export FASED_SAT_BOND_POLICY_LAYOUT_PATH="${FASED_SAT_BOND_POLICY_LAYOUT_PATH:-$FASED_DIR/token/sat/bond-api/bond-tier-policy-layout.json}"

if use_prebuilt_release_runtime; then
  section "Runtime"
  step_done "Using prebuilt runtime"
else
  section "Build"
  core_build_profile="$(resolved_core_build_profile)"
  core_cache_name="core-build-${core_build_profile:-default}"
  core_fingerprint="$(fingerprint_targets "$FASED_DIR" package.json pnpm-lock.yaml tsconfig.json tsdown.config.ts src scripts extensions config tools/fased-signerd)"
  if [[ -f "$FASED_DIR/dist/entry.js" && -f "$FASED_DIR/dist/index.js" ]] && cache_matches "$core_cache_name" "$core_fingerprint"; then
    step_skip "Core build"
  else
    rm -rf "$FASED_DIR/dist"
    if [[ -n "$core_build_profile" ]]; then
      run_logged_in "$FASED_DIR" "Build core" env NODE_OPTIONS="$build_node_options" FASED_BUILD_PROFILE="$core_build_profile" pnpm --silent run build:fast
    else
      run_logged_in "$FASED_DIR" "Build core" env NODE_OPTIONS="$build_node_options" pnpm --silent run build:fast
    fi
    write_cache "$core_cache_name" "$core_fingerprint"
  fi

  runtime_assets_fingerprint="$(fingerprint_targets "$FASED_DIR" package.json pnpm-lock.yaml scripts/bundle-a2ui.sh scripts/canvas-a2ui-copy.ts scripts/copy-export-html-templates.ts scripts/copy-hook-metadata.ts scripts/write-build-info.ts scripts/write-cli-compat.ts src/canvas-host/a2ui apps/shared/FasedAgentKit/Tools/CanvasA2UI vendor/a2ui/renderers/lit src/auto-reply/reply/export-html src/hooks/bundled src/cli/daemon-cli-compat.ts)"
  if runtime_assets_ready && cache_matches "runtime-assets" "$runtime_assets_fingerprint"; then
    step_skip "Runtime assets"
  else
    run_logged_in "$FASED_DIR" "Prepare runtime assets" env NODE_OPTIONS="$build_node_options" pnpm --silent run build:runtime-assets
    write_cache "runtime-assets" "$runtime_assets_fingerprint"
  fi

  ui_fingerprint="$(fingerprint_targets "$FASED_DIR" package.json pnpm-lock.yaml ui/package.json ui/vite.config.ts ui/tsconfig.json ui/index.html ui/src)"
  if [[ -f "$FASED_DIR/dist/control-ui/index.html" ]] && cache_matches "control-ui-build" "$ui_fingerprint"; then
    step_skip "Control UI"
  else
    run_logged_in "$FASED_DIR" "Build Control UI" env NODE_OPTIONS="$build_node_options" pnpm --silent run ui:build
    if [[ ! -f "$FASED_DIR/dist/control-ui/index.html" ]]; then
      spinner_failed "Build Control UI"
      echo "Control UI build completed but dist/control-ui/index.html is missing." >&2
      exit 1
    fi
    write_cache "control-ui-build" "$ui_fingerprint"
  fi

  install_fased_cli_launcher
fi

if [[ "$RUN_ONBOARD" -eq 0 ]]; then
  status_frame_end
  if [[ "$HOSTING_REPAIR_REQUESTED" -eq 1 ]]; then
    repair_tailscale_serve_gateway_config
    marker_onboarding_completed="$(read_marker_onboarding_completed || true)"
    if [[ "$marker_onboarding_completed" == "true" || \
      -s "${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}" ]]; then
      write_install_marker "$REPO_ROOT" "true"
    else
      write_install_marker "$REPO_ROOT" "false"
    fi
    echo "Hosted application runtime repair staged. The root installer coordinator will restart and verify the fixed systemd service."
    exit 0
  fi
  if ! prepare_existing_local_signer_after_runtime_install; then
    rollback_managed_runtime_after_failed_install || true
    exit 1
  fi
  if ! refresh_existing_local_gateway_service_after_install; then
    rollback_managed_runtime_after_failed_install || true
    exit 1
  fi
  no_onboard_profile="$(resolved_host_profile)"
  marker_onboarding_completed="$(read_marker_onboarding_completed || true)"
  if [[ "$marker_onboarding_completed" == "true" ]] || has_system_gateway_service || { [[ "$no_onboard_profile" != "hosting" ]] && has_user_gateway_service; }; then
    write_install_marker "$REPO_ROOT" "true"
  else
    write_install_marker "$REPO_ROOT" "false"
  fi
  repair_tailscale_serve_gateway_config
  if restart_existing_gateway_service_after_install; then
    step_done "Gateway restart requested"
    if wait_for_gateway_health_after_restart; then
      if [[ "$GATEWAY_SERVICE_REFRESHED" -eq 1 ]] && ! verify_gateway_runtime_identity_after_install; then
        echo "Gateway restarted, but runtime identity verification failed." >&2
        echo "Persistent state under $FASED_CONFIG_DIR was not removed." >&2
        rollback_managed_runtime_after_failed_install || true
        exit 1
      fi
      GATEWAY_RUNTIME_HEALTH_VERIFIED=1
      step_done "Gateway online"
    else
      if [[ "$GATEWAY_SERVICE_REFRESHED" -eq 1 ]]; then
        echo "Gateway service was refreshed but did not become healthy." >&2
        echo "Check: $FASED_CLI_PATH gateway status" >&2
        rollback_managed_runtime_after_failed_install || true
        exit 1
      fi
      echo "Gateway restart requested; still warming up."
      echo "Check: fased health"
    fi
  else
    if is_tailscale_serve_gateway_config; then
      echo "Hosted Gateway service is not installed yet."
      echo "Finish hosted service setup: ./install.sh --hosting"
    else
      echo "No existing Gateway service was found to restart."
    fi
  fi
  if [[ "$LOCAL_SIGNER_INSTALL_TRANSACTION_OPEN" -eq 1 ]]; then
    if [[ "$GATEWAY_RUNTIME_HEALTH_VERIFIED" -ne 1 ]]; then
      echo "The matching Local signer remains read-only because exact Gateway health was not verified." >&2
      rollback_managed_runtime_after_failed_install || true
      exit 1
    fi
    if ! verify_local_signer_after_runtime_install; then
      echo "The matching Local signer failed its final read-only protocol-v2 health check." >&2
      rollback_managed_runtime_after_failed_install || true
      exit 1
    fi
  fi
  if ! commit_local_signer_after_runtime_install; then
    echo "The Local Gateway passed installation, but signer commit cleanup is pending." >&2
    echo "Run fased update to recover the paired transaction; do not replace the signer manually." >&2
    exit 1
  fi
  if [[ "$LOCAL_REPAIR_REQUESTED" -eq 1 ]]; then
    echo "Local runtime and gateway service repair complete. Onboarding was not rerun."
  else
    echo "Onboarding skipped (--no-onboard)."
  fi
  if has_system_gateway_service || { [[ "$no_onboard_profile" != "hosting" ]] && has_user_gateway_service; }; then
    echo "Open: fased dashboard --no-open"
  elif [[ "$HOSTING_REQUESTED" -eq 1 ]]; then
    echo "Run when ready: ./install.sh --hosting"
  else
    echo "Run when ready: fased onboard --install-daemon"
  fi
  exit 0
fi

section "Interactive setup"
step_start "Start setup"
status_frame_end
onboard_old_space_mb="$(recommended_onboard_old_space_mb)"
onboard_node_options="$(node_options_with_old_space "${NODE_OPTIONS:-}" "$onboard_old_space_mb")"
onboard_color_env=()
if supports_color && [[ -z "${NO_COLOR:-}" && -z "${FORCE_COLOR:-}" ]]; then
  onboard_color_env=(FORCE_COLOR=1)
fi
(cd "$FASED_DIR" && env NODE_OPTIONS="$onboard_node_options" "${onboard_color_env[@]}" FASED_INSTALLER_ONBOARD=1 "$FASED_CLI_PATH" onboard --install-daemon "${pass_args[@]}")
if [[ ! -f "${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}" ]]; then
  write_install_marker "$REPO_ROOT" "false"
  echo "Onboarding did not create ${FASED_CONFIG_PATH:-$FASED_CONFIG_DIR/fased.json}." >&2
  echo "Rerun ./install.sh from an interactive terminal, or pass non-interactive onboarding flags after --." >&2
  exit 1
fi
write_install_marker "$REPO_ROOT" "true"
