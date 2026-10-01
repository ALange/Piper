# Third-party code

Piper has no runtime dependencies. The files below are copied into the repository (not installed) and served by the
gateway to the dashboard's Terminal page, which loads them only when it is opened.

| Component | Version | Files | Licence |
|---|---|---|---|
| [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`) | 6.0.0 | `vendor/xterm/xterm.js`, `vendor/xterm/xterm.css` | MIT |
| [xterm.js fit addon](https://github.com/xtermjs/xterm.js) (`@xterm/addon-fit`) | 0.11.0 | `vendor/xterm/addon-fit.js` | MIT |

The licence text, which covers both, is in `vendor/xterm/LICENSE`. The files are the published builds, unchanged except
that the trailing `sourceMappingURL` comment was removed (the source maps are not shipped).

Why vendored: the terminal needs a real terminal emulator (colours, cursor movement, full-screen programs), which is
not worth rewriting; copying the published build keeps the dashboard free of a package manager and of the internet.

To update: `npm pack @xterm/xterm@<version> @xterm/addon-fit@<version>`, copy `lib/xterm.js`, `css/xterm.css` and
`lib/addon-fit.js` over the files above, update the versions here and in `lib/about.mjs`, and run `node test.mjs`.
