#!/usr/bin/env bash

fased_supports_prebuilt_release_runtime() {
  local os_name="$1"
  local architecture="$2"
  [[ "$os_name" == "Linux" ]] || return 1
  case "$architecture" in
    x86_64|amd64|aarch64|arm64) return 0 ;;
    *) return 1 ;;
  esac
}

fased_should_use_prebuilt_release_runtime() {
  local profile="$1"
  local source_requested="$2"
  local source_env="$3"
  local hosting_source_env="$4"
  local os_name="$5"
  local architecture="$6"

  [[ "$source_requested" != "1" ]] || return 1
  [[ "$source_env" != "1" ]] || return 1
  if [[ "$profile" == "hosting" && "$hosting_source_env" == "1" ]]; then
    return 1
  fi
  fased_supports_prebuilt_release_runtime "$os_name" "$architecture"
}
