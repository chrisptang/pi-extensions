#!/usr/bin/env bash
# Build and install this repo's extensions into the local Pi agent.
#
# Usage:
#   scripts/install.sh                  # install the default set
#   scripts/install.sh pi-goal pi-lsp   # install specific packages
#   scripts/install.sh --all            # every package under packages/
#   scripts/install.sh --list           # show installable packages
#   scripts/install.sh --uninstall ...  # remove instead of install
#   scripts/install.sh --reinstall ...  # remove, then install fresh
#
# Flags:
#   --skip-build   reuse existing dist/ instead of rebuilding
#   --local        install into .pi/settings.json of the current project
#   --reinstall    uninstall the target packages first, then install

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Extensions maintained in this fork. Override by passing package names.
default_packages=(pi-goal pi-history pi-model-alias pi-subagents)

packages=()
skip_build=0
install_local=0
uninstall=0
reinstall=0
select_all=0
list_only=0

while (($# > 0)); do
	case "$1" in
	--skip-build) skip_build=1 ;;
	--local | -l) install_local=1 ;;
	--uninstall | --remove) uninstall=1 ;;
	--reinstall) reinstall=1 ;;
	--all) select_all=1 ;;
	--list) list_only=1 ;;
	-h | --help)
		sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	-*)
		echo "unknown flag: $1" >&2
		exit 2
		;;
	*) packages+=("$1") ;;
	esac
	shift
done

# A package is installable only if its package.json declares a pi.extensions entry.
installable_packages() {
	local dir name
	for dir in "$repo_root"/packages/*/; do
		name="$(basename "$dir")"
		[[ -f "$dir/package.json" ]] || continue
		node -e 'process.exit(require(process.argv[1]).pi?.extensions?.length ? 0 : 1)' \
			"$dir/package.json" 2>/dev/null || continue
		echo "$name"
	done
}

if ((list_only)); then
	installable_packages
	exit 0
fi

if ((select_all)); then
	while IFS= read -r name; do packages+=("$name"); done < <(installable_packages)
elif ((${#packages[@]} == 0)); then
	packages=("${default_packages[@]}")
fi

for name in "${packages[@]}"; do
	[[ -d "$repo_root/packages/$name" ]] || {
		echo "no such package: $name" >&2
		exit 1
	}
done

remove_packages() {
	local name
	for name in "${packages[@]}"; do
		echo "==> removing $name"
		# tolerate not-installed packages so --reinstall works on fresh targets
		if ((install_local)); then
			pi remove "$repo_root/packages/$name" --local || echo "   (not installed)"
		else
			pi remove "$repo_root/packages/$name" || echo "   (not installed)"
		fi
	done
}

if ((uninstall)); then
	remove_packages
	exit 0
fi

if ((skip_build == 0)); then
	echo "==> npm install"
	npm --prefix "$repo_root" install
	for name in "${packages[@]}"; do
		echo "==> building $name"
		npm --prefix "$repo_root" --workspace "packages/$name" run build --if-present
	done
fi

((reinstall)) && remove_packages

for name in "${packages[@]}"; do
	# pi.extensions points at ./dist/index.ts, which is gitignored, so it must exist.
	entry="$(node -e 'console.log(require(process.argv[1]).pi.extensions[0])' \
		"$repo_root/packages/$name/package.json")"
	if [[ ! -f "$repo_root/packages/$name/$entry" ]]; then
		echo "missing build output: packages/$name/$entry (drop --skip-build)" >&2
		exit 1
	fi
	echo "==> installing $name"
	if ((install_local)); then
		pi install "$repo_root/packages/$name" --local
	else
		pi install "$repo_root/packages/$name"
	fi
done

echo
echo "done. installed: ${packages[*]}"
echo "verify with: pi list"
