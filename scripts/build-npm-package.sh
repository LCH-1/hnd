#!/bin/sh

set -eu

usage() {
  printf '%s\n' 'Usage: sh scripts/build-npm-package.sh [OUTPUT_DIRECTORY]' >&2
  exit 2
}

if [ "$#" -gt 1 ]; then
  usage
fi

for command_name in sh mktemp cp find chmod mv mkdir dirname node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'build-npm-package: required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
done

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd -P)
OUTPUT_INPUT=${1:-"$PROJECT_ROOT/dist/npm/package"}
OUTPUT_NAME=$(basename -- "$OUTPUT_INPUT")
OUTPUT_PARENT_INPUT=$(dirname -- "$OUTPUT_INPUT")

case "$OUTPUT_NAME" in
  ''|'.'|'..')
    printf '%s\n' 'build-npm-package: output directory must have a safe final component' >&2
    exit 1
    ;;
esac

mkdir -p -- "$OUTPUT_PARENT_INPUT"
OUTPUT_PARENT=$(CDPATH= cd -- "$OUTPUT_PARENT_INPUT" && pwd -P)
OUTPUT_DIRECTORY="$OUTPUT_PARENT/$OUTPUT_NAME"

if [ -L "$OUTPUT_DIRECTORY" ]; then
  printf '%s\n' 'build-npm-package: refusing to replace a symlink output directory' >&2
  exit 1
fi
if [ -e "$OUTPUT_DIRECTORY" ] && [ ! -d "$OUTPUT_DIRECTORY" ]; then
  printf '%s\n' 'build-npm-package: output path exists and is not a directory' >&2
  exit 1
fi
if [ -d "$OUTPUT_DIRECTORY" ]; then
  if [ ! -f "$OUTPUT_DIRECTORY/package.json" ] || ! node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (value.name !== "@lch-1/hnd") process.exit(1);
  ' "$OUTPUT_DIRECTORY/package.json"; then
    printf '%s\n' 'build-npm-package: refusing to replace an unrecognized output directory' >&2
    exit 1
  fi
fi

PUBLISH_DIRECTORY=$(mktemp -d "$OUTPUT_PARENT/.hnd-npm-publish.XXXXXX")
cleanup() {
  rm -rf -- "$PUBLISH_DIRECTORY"
}
trap cleanup 0 HUP INT TERM

PACKAGE_STAGE="$PUBLISH_DIRECTORY/package"
mkdir -p -- "$PACKAGE_STAGE"
SOURCE_FILE_LIST="$PROJECT_ROOT/assets/npm-source-files.txt"
if [ ! -f "$SOURCE_FILE_LIST" ] || [ -L "$SOURCE_FILE_LIST" ]; then
  printf '%s\n' 'build-npm-package: source allowlist is missing or unsafe' >&2
  exit 1
fi

# The npm package is built directly from a fixed source allowlist. Reject a
# symlink in any path component before copying so a local tree cannot redirect
# a publish to files outside this project.
node --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  const [root, listPath] = process.argv.slice(1);
  const entries = fs.readFileSync(listPath, "utf8").split(/\r?\n/u).filter(Boolean);
  const seen = new Set();
  for (const relative of entries) {
    if (
      path.isAbsolute(relative)
      || relative.includes("\\")
      || relative.split("/").some((part) => !part || part === "." || part === "..")
      || seen.has(relative)
    ) throw new Error(`unsafe npm source allowlist entry: ${relative}`);
    seen.add(relative);
    let current = root;
    for (const [index, segment] of relative.split("/").entries()) {
      current = path.join(current, segment);
      const metadata = fs.lstatSync(current);
      if (metadata.isSymbolicLink()) throw new Error(`npm source path contains a symlink: ${relative}`);
      const final = index === relative.split("/").length - 1;
      if (final ? !metadata.isFile() : !metadata.isDirectory()) {
        throw new Error(`npm source path has an unexpected type: ${relative}`);
      }
    }
  }
' "$PROJECT_ROOT" "$SOURCE_FILE_LIST"

while IFS= read -r relative_path || [ -n "$relative_path" ]; do
  case "$relative_path" in
    '') continue ;;
    /*|./*|../*|*/../*|*/./*|*//*|*\\*)
      printf 'build-npm-package: unsafe allowlisted path: %s\n' "$relative_path" >&2
      exit 1
      ;;
  esac
  source_path="$PROJECT_ROOT/$relative_path"
  target_path="$PACKAGE_STAGE/$relative_path"
  if [ ! -f "$source_path" ] || [ -L "$source_path" ]; then
    printf 'build-npm-package: allowlisted source file is missing or unsafe: %s\n' \
      "$relative_path" >&2
    exit 1
  fi
  mkdir -p -- "$(dirname -- "$target_path")"
  cp -- "$source_path" "$target_path"
done < "$SOURCE_FILE_LIST"
cp -- "$PROJECT_ROOT/assets/npm-README.md" "$PACKAGE_STAGE/README.md"

node -e '
  const fs = require("node:fs");
  const root = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof root.version !== "string" || !root.version) process.exit(1);
  const value = {
    name: "@lch-1/hnd",
    version: root.version,
    description: "HND connector for local Git repositories and coding agents",
    type: "module",
    bin: { hnd: "bin/hnd.mjs" },
    files: [
      "bin",
      "src",
      "assets/hnd-handoff",
      "assets/release-public-key.pem",
      "README.md",
      "LICENSE"
    ],
    engines: { node: ">=24.12.0" },
    os: ["win32", "darwin", "linux"],
    license: "MIT",
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/"
    }
  };
  fs.writeFileSync(process.argv[2], `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644
  });
' "$PROJECT_ROOT/package.json" "$PACKAGE_STAGE/package.json"

PACKAGE_SYMLINK=$(find "$PACKAGE_STAGE" -type l -print -quit)
if [ -n "$PACKAGE_SYMLINK" ]; then
  printf 'build-npm-package: package must not contain symlinks: %s\n' \
    "$PACKAGE_SYMLINK" >&2
  exit 1
fi
find "$PACKAGE_STAGE" -type d -exec chmod 0755 {} +
find "$PACKAGE_STAGE" -type f -exec chmod 0644 {} +
chmod 0755 "$PACKAGE_STAGE/bin/hnd.mjs"

for forbidden_path in \
  "$PACKAGE_STAGE/src/server" \
  "$PACKAGE_STAGE/src/web" \
  "$PACKAGE_STAGE/src/browser" \
  "$PACKAGE_STAGE/src/sync/server.mjs" \
  "$PACKAGE_STAGE/src/sync/store.mjs" \
  "$PACKAGE_STAGE/assets/connector-launcher.mjs" \
  "$PACKAGE_STAGE/install.sh" \
  "$PACKAGE_STAGE/install.ps1" \
  "$PACKAGE_STAGE/MANIFEST.json"
do
  if [ -e "$forbidden_path" ] || [ -L "$forbidden_path" ]; then
    printf 'build-npm-package: forbidden server or installer file included: %s\n' \
      "$forbidden_path" >&2
    exit 1
  fi
done

PACKAGE_VERSION=$(node -e '
  const fs = require("node:fs");
  process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version);
' "$PACKAGE_STAGE/package.json")
LAUNCHER_VERSION=$(node --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  const { LAUNCHER_VERSION } = await import(pathToFileURL(process.argv[1]));
  process.stdout.write(LAUNCHER_VERSION);
' "$PACKAGE_STAGE/src/launcher-version.mjs")
if [ "$PACKAGE_VERSION" != "$LAUNCHER_VERSION" ]; then
  printf 'build-npm-package: package version %s does not match launcher version %s\n' \
    "$PACKAGE_VERSION" "$LAUNCHER_VERSION" >&2
  exit 1
fi

# The fallback CLI has its own runtime version. Smoke it independently; it is
# intentionally allowed to differ from the immutable npm launcher version.
HND_HOME="$PUBLISH_DIRECTORY/version-state" \
  HND_USER_HOME="$PUBLISH_DIRECTORY/version-user" \
  HND_DISABLE_AUTO_UPDATE=1 \
  node "$PACKAGE_STAGE/bin/hnd.mjs" --version >/dev/null

# Import the remote client explicitly so a server-only dependency cannot hide
# behind the lightweight --version path.
node --input-type=module -e '
  const { pathToFileURL } = await import("node:url");
  await import(pathToFileURL(process.argv[1]));
' "$PACKAGE_STAGE/src/remote-cli.mjs"

# Make the same allowlist decision npm will use and fail before replacing the
# last known-good stage if the package cannot be packed.
(cd -- "$PACKAGE_STAGE" && npm pack --dry-run --json >/dev/null)

if [ -d "$OUTPUT_DIRECTORY" ]; then
  find "$OUTPUT_DIRECTORY" -depth -delete
fi
mv -- "$PACKAGE_STAGE" "$OUTPUT_DIRECTORY"

printf 'npm package directory: %s\n' "$OUTPUT_DIRECTORY"
printf 'package: @lch-1/hnd@%s\n' "$PACKAGE_VERSION"
