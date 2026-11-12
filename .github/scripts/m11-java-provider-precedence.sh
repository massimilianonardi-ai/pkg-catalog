#!/bin/sh
set -eux
[ -n "${m_ROOT:-}" ] && [ -n "${m_PKG_DIR:-}" ] || exit 1
. "$m_LIB_DIR/sys/sh/core.lib.sh" || exit 2
m="$m_ROOT/m"
java21=
java25=
maven_concrete=

m11_cleanup()
{
  "$m" pkg provider bind -u -- maven java >/dev/null 2>&1 || :
  "$m" pkg provider default -u -- java >/dev/null 2>&1 || :
  "$m" pkg default -u -- maven >/dev/null 2>&1 || :
  if [ -n "$maven_concrete" ]; then "$m" pkg uninstall "$maven_concrete" >/dev/null 2>&1 || :; fi
  if [ -n "$java21" ]; then "$m" pkg uninstall "$java21" >/dev/null 2>&1 || :; fi
  if [ -n "$java25" ]; then "$m" pkg uninstall "$java25" >/dev/null 2>&1 || :; fi
}
trap 'm11_cleanup' 0 HUP INT TERM

if "$m" pkg provider default java >/dev/null 2>&1; then
  echo 'FAIL: expected an isolated installation with no java provider default' >&2
  exit 3
fi
if "$m" pkg provider bind maven java >/dev/null 2>&1; then
  echo 'FAIL: expected an isolated installation with no Maven provider binding' >&2
  exit 4
fi

"$m" pkg install temurin@21+35 temurin@25+36
versions=$("$m" pkg versions temurin) || exit 5
java21=$(printf '%s\n' "$versions" | command -p grep -F 'temurin@21+35!' | command -p sed -n '1p')
java25=$(printf '%s\n' "$versions" | command -p grep -F 'temurin@25+36!' | command -p sed -n '1p')
[ -n "$java21" ] && [ -n "$java25" ] || {
  printf 'FAIL: expected both Temurin feature concretes; got:\n%s\n' "$versions" >&2
  exit 6
}
java21_root="$m_PKG_DIR/$java21/root"
java25_root="$m_PKG_DIR/$java25/root"
[ -d "$java21_root" ] && [ -d "$java25_root" ] || exit 7

"$m" pkg provider default java "$java25"
[ "$("$m" pkg provider default java)" = "$java25" ] || exit 8
"$m" pkg install maven@4.0.0-rc-6
maven_versions=$("$m" pkg versions maven) || exit 9
maven_concrete=$(printf '%s\n' "$maven_versions" | command -p grep -F 'maven@4.0.0-rc-6!' | command -p sed -n '1p')
[ -n "$maven_concrete" ] || {
  printf 'FAIL: Maven exact concrete missing; got:\n%s\n' "$maven_versions" >&2
  exit 10
}
"$m" pkg default "$maven_concrete"
[ "$("$m" pkg default maven)" = "$maven_concrete" ] || exit 11

m11_check_java()
{
  expected_feature=$1
  expected_root=$2
  output=$("$m" java -XshowSettings:properties -version 2>&1) || {
    printf 'FAIL: public java command failed for feature %s\n%s\n' "$expected_feature" "$output" >&2
    return 1
  }
  case "$output" in
    *"java.home = $expected_root"*) :;;
    *) printf 'FAIL: public java root mismatch, expected %s\n%s\n' "$expected_root" "$output" >&2; return 1;;
  esac
  if ! printf '%s\n' "$output" | command -p grep -E -q "version \"${expected_feature}(\\.[0-9]+)*\""; then
    printf 'FAIL: public java feature mismatch, expected %s\n%s\n' "$expected_feature" "$output" >&2
    return 1
  fi
}

m11_check_maven()
{
  expected_feature=$1
  expected_root=$2
  context pkg="$maven_concrete" || return 1
  expected_command="$m_PKG_DIR/$maven_concrete/cmd/mvn"
  actual_command=$(command -v mvn) || actual_command=
  if [ "$actual_command" != "$expected_command" ]; then
    context || :
    printf 'FAIL: context selected mvn=%s; expected %s\n' "$actual_command" "$expected_command" >&2
    return 1
  fi
  status=0
  output=$(mvn --version 2>&1) || status=$?
  context || :
  if [ "$status" -ne 0 ]; then
    printf 'FAIL: contextual Maven command status=%s\n%s\n' "$status" "$output" >&2
    return 1
  fi
  if ! printf '%s\n' "$output" | command -p grep -E -q "Java version: ${expected_feature}(\\.[0-9]+)*[,[:space:]]"; then
    printf 'FAIL: Maven Java feature mismatch, expected %s\n%s\n' "$expected_feature" "$output" >&2
    return 1
  fi
  case "$output" in
    *"$expected_root"*) :;;
    *) printf 'FAIL: Maven runtime root mismatch, expected %s\n%s\n' "$expected_root" "$output" >&2; return 1;;
  esac
}

# With no Maven-specific binding, its launcher follows the system Java default.
m11_check_java 25 "$java25_root"
m11_check_maven 25 "$java25_root"

# A Maven-specific binding overrides the system default, while public java stays global.
"$m" pkg provider bind maven java "$java21"
[ "$("$m" pkg provider bind maven java)" = "$java21" ] || exit 12
m11_check_maven 21 "$java21_root"
m11_check_java 25 "$java25_root"

# A bound provider remains in use when the system default changes.
"$m" pkg provider default java "$java21"
[ "$("$m" pkg provider default java)" = "$java21" ] || exit 13
m11_check_maven 21 "$java21_root"

# Reselect Maven to Java 25, then unbind and verify fallback to Java 21.
"$m" pkg provider bind maven java "$java25"
[ "$("$m" pkg provider bind maven java)" = "$java25" ] || exit 14
m11_check_maven 25 "$java25_root"
m11_check_java 21 "$java21_root"
"$m" pkg provider bind -u -- maven java
if "$m" pkg provider bind maven java >/dev/null 2>&1; then exit 15; fi
m11_check_maven 21 "$java21_root"

# Changing the global default changes the unbound Maven runtime.
"$m" pkg provider default java "$java25"
m11_check_maven 25 "$java25_root"

# An actively bound provider cannot be removed; the selected runtime stays usable.
"$m" pkg provider bind maven java "$java21"
uninstall_status=0
"$m" pkg uninstall "$java21" >/dev/null 2>&1 || uninstall_status=$?
[ "$uninstall_status" -ne 0 ] || {
  echo 'FAIL: uninstall removed a provider still bound to Maven' >&2
  exit 16
}
versions=$("$m" pkg versions temurin) || exit 17
case "$versions" in *"$java21"*) :;; *) echo 'FAIL: referenced Java 21 provider disappeared after rejected uninstall' >&2; exit 18;; esac
m11_check_maven 21 "$java21_root"

# Unbinding restores the current default, and a removed provider cannot be selected again.
"$m" pkg provider bind -u -- maven java
"$m" pkg provider default java "$java21"
m11_check_maven 21 "$java21_root"
"$m" pkg uninstall "$java25"
if "$m" pkg provider default java "$java25" >/dev/null 2>&1; then
  echo 'FAIL: removed Java 25 provider was selectable' >&2
  exit 19
fi
[ "$("$m" pkg provider default java)" = "$java21" ] || exit 20
m11_check_java 21 "$java21_root"
m11_check_maven 21 "$java21_root"

# Clear selections, remove the consumer and final provider, and require clean queries.
"$m" pkg default -u -- maven
"$m" pkg provider default -u -- java
"$m" pkg uninstall "$maven_concrete"
"$m" pkg uninstall "$java21"
if "$m" pkg provider default java >/dev/null 2>&1; then exit 21; fi
if "$m" pkg provider bind maven java >/dev/null 2>&1; then exit 22; fi
versions=$("$m" pkg versions temurin 2>/dev/null) || versions=
[ -z "$versions" ] || { printf 'FAIL: Temurin versions remain after cleanup:\n%s\n' "$versions" >&2; exit 23; }
versions=$("$m" pkg versions maven 2>/dev/null) || versions=
[ -z "$versions" ] || { printf 'FAIL: Maven versions remain after cleanup:\n%s\n' "$versions" >&2; exit 24; }
if context pkg="$maven_concrete" >/dev/null 2>&1; then
  echo 'FAIL: context selected Maven after its concrete was uninstalled' >&2
  exit 25
fi

printf '%s\n' 'PASS: M11 Temurin 21/25, Maven context command, provider binding/default precedence, reselection, unbind and uninstall cleanup'
