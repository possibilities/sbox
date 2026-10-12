The optional transparent network transport downloads the official tun2socks v2.7.0
Linux executable at runtime. No executable is stored in this repository. Its
release archive and executable digests are pinned in `src/network/assets.ts`.

- tun2socks: Copyright (c) 2019 Jason Lyu. MIT license; see `tun2socks-MIT.txt`.
  Source and release: https://github.com/xjasonlyu/tun2socks/tree/v2.7.0 and
  https://github.com/xjasonlyu/tun2socks/releases/tag/v2.7.0.
- tun2socks incorporates the gVisor network stack, Copyright The gVisor Authors,
  licensed under Apache License 2.0; see `gvisor-Apache-2.0.txt`.
  Source: https://github.com/google/gvisor.

The upstream release executable contains Go module build information listing its
included dependencies. Upstream dependency versions and their source locations
are recorded at https://github.com/xjasonlyu/tun2socks/blob/v2.7.0/go.mod. These
notices apply to that upstream executable; they do not change this project's MIT
license. If redistributing a cached executable, retain upstream licenses and the
notices applicable to all incorporated components.
