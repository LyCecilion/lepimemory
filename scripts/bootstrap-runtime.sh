#!/usr/bin/env bash
set -euo pipefail
umask 022
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
RUNTIME="$ROOT/.runtime"
case "$(uname -s)" in
Linux) PLATFORM=linux ;;
Darwin) PLATFORM=darwin ;;
*)
	echo LEPI_UNSUPPORTED_PLATFORM >&2
	exit 1
	;;
esac
case "$(uname -m)" in
x86_64) ARCH=x64 ;;
aarch64 | arm64) ARCH=arm64 ;;
*)
	echo LEPI_UNSUPPORTED_PLATFORM >&2
	exit 1
	;;
esac
case "$PLATFORM-$ARCH" in
linux-x64) NODE_HASH=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2 ;;
linux-arm64) NODE_HASH=5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7 ;;
darwin-x64) NODE_HASH=26fc30891004603d094eed11de5efcd03bbd2efbc35c177fc72648d5d7a7701b ;;
darwin-arm64) NODE_HASH=b7bf7707070b950ba1ec5f1af3bb6de0f2b1962c5033973d94068ab021ef3014 ;;
esac
for tool in curl tar openssl shasum find sort diff; do
	command -v "$tool" >/dev/null || {
		echo "LEPI_BOOTSTRAP_UNAVAILABLE: $tool" >&2
		exit 1
	}
done
mkdir -p "$RUNTIME/cache" "$RUNTIME/bin"
if ! mkdir "$RUNTIME/bootstrap.lock" 2>/dev/null; then
	echo LEPI_BOOTSTRAP_BUSY >&2
	exit 1
fi
STAGE=''
trap 'if [ -n "$STAGE" ]; then rm -rf -- "$STAGE"; fi; rmdir "$RUNTIME/bootstrap.lock"' EXIT
quarantine() {
	mv -- "$1" "$1.corrupt-$(date +%s)-$$"
}
sha256() {
	shasum -a 256 "$1" | cut -d ' ' -f 1
}
sha512_base64() {
	openssl dgst -sha512 -binary "$1" | openssl base64 -A
}
# Recompute the installed tree before exposing any executable. A manifest also
# covers symlink targets so replacing an executable link cannot evade validation.
manifest() {
	(
		cd -- "$1"
		find . -type f ! -name .verified-tree -print | LC_ALL=C sort | while IFS= read -r file; do
			printf 'file %s %s\n' "$(sha256 "$file")" "$file"
		done
		find . -type l -print | LC_ALL=C sort | while IFS= read -r file; do
			printf 'link %s %s\n' "$file" "$(readlink "$file")"
		done
	)
}
fetch_archive() {
	local file=$1 url=$2 algorithm=$3 expected=$4 actual
	if [ -f "$file" ]; then
		actual=$("$algorithm" "$file")
		if [ "$actual" = "$expected" ]; then return; fi
		quarantine "$file"
	fi
	curl --fail --show-error --location --retry 2 --connect-timeout 20 --max-time 600 "$url" -o "$file.part-$$"
	actual=$("$algorithm" "$file.part-$$")
	if [ "$actual" != "$expected" ]; then
		quarantine "$file.part-$$"
		echo LEPI_ARTIFACT_INTEGRITY >&2
		exit 1
	fi
	mv -- "$file.part-$$" "$file"
}
publish_tree() {
	local destination=$1 archive=$2
	if [ -d "$destination" ]; then
		STAGE=$(mktemp -d "$RUNTIME/check.XXXXXXXX")
		manifest "$destination" >"$STAGE/tree"
		if [ -f "$destination/.verified-tree" ] && diff -q "$destination/.verified-tree" "$STAGE/tree" >/dev/null; then
			rm -rf -- "$STAGE"
			STAGE=''
			return
		fi
		quarantine "$destination"
		rm -rf -- "$STAGE"
		STAGE=''
	elif [ -e "$destination" ] || [ -L "$destination" ]; then
		quarantine "$destination"
	fi
	STAGE=$(mktemp -d "$RUNTIME/publish.XXXXXXXX")
	mkdir "$STAGE/tree"
	tar -xf "$archive" -C "$STAGE/tree" --strip-components=1
	manifest "$STAGE/tree" >"$STAGE/tree/.verified-tree"
	mv -- "$STAGE/tree" "$destination"
	rm -rf -- "$STAGE"
	STAGE=''
}
NODE_NAME="node-v24.20.0-$PLATFORM-$ARCH"
NODE_ARCHIVE="$RUNTIME/cache/$NODE_NAME.tar.xz"
fetch_archive "$NODE_ARCHIVE" "https://nodejs.org/dist/v24.20.0/$NODE_NAME.tar.xz" sha256 "$NODE_HASH"
publish_tree "$RUNTIME/$NODE_NAME" "$NODE_ARCHIVE"
PNPM_ARCHIVE="$RUNTIME/cache/pnpm-10.28.2.tgz"
fetch_archive "$PNPM_ARCHIVE" 'https://registry.npmjs.org/pnpm/-/pnpm-10.28.2.tgz' sha512_base64 'QYcvA3rSL3NI47Heu69+hnz9RI8nJtnPdMCPGVB8MdLI56EVJbmD/rwt9kC1Q43uYCPrsfhO1DzC1lTSvDJiZA=='
publish_tree "$RUNTIME/pnpm-10.28.2" "$PNPM_ARCHIVE"
ln -sfn "../$NODE_NAME/bin/node" "$RUNTIME/bin/node.next"
mv -f -- "$RUNTIME/bin/node.next" "$RUNTIME/bin/node"
cat >"$RUNTIME/bin/pnpm.next" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
BIN=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
export PATH="$BIN:$PATH"
exec "$BIN/node" "$BIN/../pnpm-10.28.2/bin/pnpm.cjs" "$@"
WRAPPER
chmod 755 "$RUNTIME/bin/pnpm.next"
mv -f -- "$RUNTIME/bin/pnpm.next" "$RUNTIME/bin/pnpm"
export PATH="$RUNTIME/bin:$PATH"
[ "$("$RUNTIME/bin/node" --version)" = v24.20.0 ] || {
	echo LEPI_NODE_INCOMPATIBLE >&2
	exit 1
}
[ "$("$RUNTIME/bin/pnpm" --version)" = 10.28.2 ] || {
	echo LEPI_PNPM_INCOMPATIBLE >&2
	exit 1
}
printf 'Verified runtime: Node 24.20.0 / pnpm 10.28.2 (%s-%s)\n' "$PLATFORM" "$ARCH"
