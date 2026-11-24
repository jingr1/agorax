# shellcheck shell=bash
# Source from other scripts:
#   source "$ROOT/scripts/load-dotenv-file.sh"
#   agorax_load_dotenv_file "$ROOT/.env"
#   agorax_load_dotenv_file "$HOME/.hermes/.env"   # provider keys for Codex/Claude
#
# Loads KEY=value lines into the current shell. Does not overwrite keys that are
# already set in the environment (explicit process env wins). Never prints values.

agorax_load_dotenv_file() {
  local file=$1
  local only_missing=${2:-1}
  [[ -f "$file" ]] || return 0
  local line key val
  set -a
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      '' | '#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in
      *[!A-Za-z0-9_]*) continue ;;
    esac
    if [[ "$only_missing" == "1" ]] && [[ -n "${!key+x}" ]]; then
      continue
    fi
    val=${val%%#*}
    val=$(printf '%s' "$val" | tr -d '\r')
    # Strip matching single/double quotes around the value.
    if [[ "$val" == \"*\" && "$val" == *\" ]]; then
      val=${val:1:${#val}-2}
    elif [[ "$val" == \'*\' && "$val" == *\' ]]; then
      val=${val:1:${#val}-2}
    fi
    eval "export $key=\$val"
  done <"$file"
  set +a
}
