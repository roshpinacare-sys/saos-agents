#!/usr/bin/env bash
# gitsafety-env — pattern #6 in docs/PATTERNS.md: layered git safety, env layer.
# Every process an agent runs can receive a git environment where **transports
# are refused BY CONSTRUCTION**: even if library code attempts ls-remote /
# fetch / push / clone, git itself refuses before any packet hits the wire.
# Where a content guard checks what leaves, this layer stops unauthorized
# egress from the inside.
#
# Usage:
#   bash tools/gitsafety-env.sh <command...>   # run command with hardened env (exec)
#   source tools/gitsafety-env.sh              # harden the current shell
set -u
gitsafety_env() {
  # 1) sever env chains that could redirect git somewhere else
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES 2>/dev/null || true
  # 2) no transports: the allow-list is a name that does not exist
  export GIT_ALLOW_PROTOCOL="agentcraft-none"
  export GIT_TERMINAL_PROMPT="0"
  # 3) protocol contract via env-config (zero mutation of .git/config)
  export GIT_CONFIG_COUNT="4"
  export GIT_CONFIG_KEY_0="protocol.allow"        GIT_CONFIG_VALUE_0="never"
  export GIT_CONFIG_KEY_1="protocol.https.allow"  GIT_CONFIG_VALUE_1="never"
  export GIT_CONFIG_KEY_2="protocol.http.allow"   GIT_CONFIG_VALUE_2="never"
  export GIT_CONFIG_KEY_3="protocol.file.allow"   GIT_CONFIG_VALUE_3="user"
}
if [[ $# -gt 0 ]]; then
  gitsafety_env
  exec "$@"
else
  gitsafety_env
fi
