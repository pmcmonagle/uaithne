# Uaithne

*Uaithne* (roughly "OO-ah-nyeh") is the Dagda's harp in the Irish Mythological Cycle, the harp that put the seasons in their order. The app was called Yuzu until October 2026; a workspace made then is renamed on open (`yuzu.toml` → `uaithne.toml`, `.yuzu/` → `.uaithne/`).

A live-coding music environment for Strudel and Tidal.

## Install (Linux)

Build the packages (see **Building** below), then install the `.deb` with `sudo apt install ./Uaithne_0.1.0_amd64.deb`, or make the AppImage executable and run it. Tidal additionally needs GHC with the `tidal` library, SuperCollider and SuperDirt (see **Tidal**); Strudel needs nothing else.

## Setup for development (Linux)

```sh
# System libraries for Tauri / WebKitGTK
sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev

# Node 22.12+ (pinned in .nvmrc) and Rust (rustup)
nvm use
npm install
```

## Run

```sh
nvm use
npm run tauri dev
```

The self-tests are dev aids: `UAITHNE_SELFTEST=1` (plus `UAITHNE_SELFTEST_PACK=uzu-drumkit` and `UAITHNE_SELFTEST_TIDAL=1`) runs checks on launch and logs `selftest: …` lines.

On first launch Uaithne asks for a workspace folder (default `~/uaithne`) and creates `tracks/`, `samples/` and `recordings/` inside it, with a couple of example tracks.

## Building

```sh
nvm use
npm run tauri build      # → src-tauri/target/release/bundle/{deb,appimage}/
```

The AppImage step needs `patchelf` (`sudo apt install patchelf`); `npm run tauri build -- --bundles deb` skips it. The AppImage bundles GStreamer, which WebKitGTK uses to play and decode audio, so it's much larger than the `.deb` (which uses the system's). macOS builds aren't set up yet.

## Keys

These are the defaults. To change one, open the shortcut help (`Ctrl+H`), click its keys and press the new ones; ↺ puts it back. Changes are kept per machine.

| Key | Action |
|---|---|
| `Ctrl+Enter` | Evaluate (Strudel: whole buffer; Tidal: block under cursor) |
| `Shift+Enter` | Evaluate current line or selection |
| `Ctrl+.` / `Ctrl+Shift+.` | Hush current engine / all engines |
| `Ctrl+P` | Quick track switcher (type a new name to create it) |
| `Ctrl+Alt+↑/↓`, `Ctrl+Alt+M` | Volume up/down, mute |
| ``Ctrl+` `` | Toggle the log |
| `Ctrl+K` | Toggle the reference panel |
| `Ctrl+J` | Toggle the visuals panel |
| `Ctrl+Shift+R` | Start or stop recording |
| `Ctrl+,` | Settings (theme, MIDI and OSC out) |
| `Ctrl+H` or `F1` | All shortcuts and commands (also `:keys`, or click **Ctrl+H help** in the status bar) |
| `K` (vim normal mode) | Look up the word under the cursor |

Vim ex commands (not rebindable): `:w` (save and evaluate, like `Ctrl+Enter`), `:wa`, `:e name`, `:new name.tidal`, `:ls`, `:bn`, `:bp`, `:bd` (close), `:q` (stop the track if it's playing, otherwise close it), `:ren`, `:hush`, `:packs`, `:tidal`, `:h name` (look up a function; `:h` alone opens the reference), `:keys` (shortcut help), `:viz`, `:rec`, `:settings`.

## Editor and appearance

- **Theme:** Settings (`Ctrl+,`) has Auto (follows the system's light or dark setting), Dark, Light, Bog (peat, gorse and heather) and Vellum (manuscript). To change any colour, put CSS in `~/.config/com.exadyne.uaithne/theme.css`, e.g. `:root { --accent: #e06c75; --keyword: #ff79c6; }`, and press **Reload it** in Settings. The variables are the palette names in `src/lib/themes.ts` (`--bg`, `--panel`, `--fg`, `--accent`, `--string`, `--comment`, …).
- **Layout:** drag the edges of the sidebar, reference, log and visuals panels to resize them (double-click an edge to reset). Their sizes, which panels are open, and the window's size and position come back next time.
- **Vim:** `[editor]` in `uaithne.toml` takes `vim = false` to turn vim mode off, `font_size`, and vimrc-style mappings:

  ```toml
  [editor]
  leader = " "    # what <leader> means; the default is \
  vim_mappings = ["inoremap jk <Esc>", "nnoremap <leader>r :rec<CR>", "nnoremap <leader>v :viz<CR>"]
  ```

  `map`, `nmap`, `vmap`, `imap` and their `noremap` forms work. Unlike vim, CodeMirror's vim doesn't wait to see whether a longer mapping follows, so a leader that's already a command (Space, `,`) loses its own meaning once a mapping uses it. Editor settings apply when the workspace opens.

## Reference

- **Panel:** `Ctrl+K`, `:h` or `K` opens it on the right. It always shows the active track's language: Strudel (from its own docs) or Tidal (your installed version, from GHCi plus the tidalcycles.org docs). Search is fuzzy over names, aliases and descriptions, and the chips filter by category. `↑`/`↓` and `↵` pick a result, and `Esc` goes back. Function names inside an entry are links.
- **Examples:** every example has **Try**, which plays it in that language's engine (a bare Tidal pattern plays on `d1`), and **Insert**, which adds it as a new block below the cursor. While an example plays, its Try button becomes **Stop**. In Strudel that hushes; in Tidal it silences only the example's own patterns (usually `d1`), so your tracks' other channels keep playing.
- **While typing:** function names complete with their signature and a one-line summary, and inside strings the sound names complete. Hovering a function shows its signature. Inside a call, the signature stays up with the current argument underlined; `Esc` hides it.
- **Regenerating:** the data lives in `reference/*.json`. `npm run ref:strudel` rebuilds Strudel's after a Strudel update, and `npm run ref:tidal` rebuilds Tidal's against the Tidal your GHCi has (it fetches the docs and the Tidal source into `tools/.cache`). Hand-written entries and fixes go in `reference/tidal.overrides.json` (or `strudel.overrides.json`).

## Visuals, recording, MIDI and OSC

- **Visuals** (`Ctrl+J`, `:viz`): a panel under the editor, resizable by its top edge. Each visual your Strudel code calls gets its own lane there, side by side and labelled: `.pianoroll()`, `.punchcard()`, `.wordfall()`, `.spiral()`, `.pitchwheel()`, `.scope()`, `.fscope()`, `.spectrum()`. The panel opens by itself when the code uses one. With none, it shows a punchcard of what's playing. Tidal isn't visualised yet.
- **Inline visuals:** as on strudel.cc, put an underscore in front (`._pianoroll()`, `._scope()`, …) and the visual draws right under its line in the editor instead, following the code as you edit. They take the same options, plus `height` (and `width`) in pixels.
- **Recording** (`Ctrl+Shift+R`, `:rec`, or **rec** in the status bar): writes 32-bit float WAV to `recordings/`, named by the time it started. It records whichever engines are running when you start: Strudel if its audio has started, Tidal if SuperCollider is up. With both, each gets its own file (`…_strudel.wav`, `…_tidal.wav`), started together, to line up in a DAW (Strudel's is at the page's 44.1 kHz, SuperCollider's at 48 kHz). Recordings are taken before the volume control, so the slider and mute don't affect them.
- **MIDI out:** Strudel's `.midi()` works as on strudel.cc: `note("c a f e").midi()` plays on the output chosen in Settings (or the first one), and `.midi("name")` or `.midiport("name")` picks one by part of its name. `midichan`, `velocity` (× `gain`), `ccn`/`ccv` and `progNum` are sent too. In Tidal, choose an output in Settings, and `s "midi"` plays on it through SuperDirt: `d1 $ n "0 4 7" # s "midi" # midichan 1` (`n "0"` is middle C; SuperDirt's default `amp` makes velocity 50, so add `# amp 1` for full).
- **OSC out:** Strudel's `.osc()` sends each event as a timestamped `/dirt/play` bundle to the target in Settings, SuperDirt (`127.0.0.1:57120`) by default, so `s("bd*4").osc()` plays through SuperCollider. `.oscport(port)` sends to another local port.
- **Settings** (`Ctrl+,`, `:settings` or ⚙): the theme, the MIDI outputs for Strudel and Tidal, and the OSC target. They're kept per machine (port names belong to the machine, not the workspace).

## Samples

- **Packs:** the ⇩ button in the sidebar's Samples panel (or `:packs`) downloads packs such as Dirt-Samples and Tidal Drum Machines into `samples/packs/`, after which they work offline. The panel also accepts any `github:user/repo` or `strudel.json` URL.
- **Your own sounds:** drop folders of audio files into `samples/local/`. Each folder becomes a sound named after it, and files are indexed in name order (`name:0`, `name:1`, …). They show up immediately.
- **Categories:** sounds are grouped as Drums, Percussion, Bass, Synth, Keys, Mallets, Strings, Winds, Vocal, FX, Breaks & Loops and Other. The built-in packs come pre-tagged, and drum machines get a sub-group per machine. For local sounds, the first folder sets the category: `samples/local/bass/reese/` puts `reese` under Bass, and any folder name works as a custom category. Search with `drums: 909` to filter to one category.
- **Browsing:** click a sound to preview it and see its indices. `↵` inserts it at the cursor: bare inside a pattern string, otherwise as `s("name")`.

## Tidal

Tidal needs GHC with the `tidal` library, SuperCollider, and the SuperDirt quark. Uaithne runs its own copies of GHCi and SuperCollider; you don't start them yourself.

- **Starting:** both processes start the first time a `.tidal` track is opened, which takes about 5 s. The Tidal dot in the status bar turns green when they're ready. Click it, or run `:tidal`, to see each process, restart or stop them, re-link audio, or check what's installed.
- **Evaluating:** `Ctrl+Enter` sends the block under the cursor (the lines between blank lines) to GHCi, so `d1 $ …` works as usual. Errors are marked on the line GHCi reports, and its output goes to the log's Tidal tab.
- **Isolation:** Uaithne's SuperCollider skips your own `startup.scd`. It uses your quark list, its own server port, and SuperDirt on port 57120. Quit any other SuperCollider running SuperDirt first.
- **Highlighting:** while a pattern plays, each mini-notation word outlines as it sounds, as in Strudel. This works across tracks: `d1` from one track and `d2` from another each light up in their own track. Only words inside strings light up; values built in Haskell (`irand 8`) have no place in the code. To do this, Uaithne wraps each string in `deltaContext` before sending the block. If a block doesn't compile that way, Uaithne sends it unchanged, and it plays without highlights. `highlight = false` under `[tidal]` turns this off.
- **Samples:** SuperDirt loads the same library as Strudel, with the same names and indices: local folders first, then packs. It doesn't load SuperDirt's bundled Dirt-Samples. To get those names in both languages, install the Dirt-Samples pack. Pitched note maps (e.g. `piano`) are Strudel-only; in Tidal, pick files with `n`.
- **Audio (PipeWire):** SuperCollider runs under `pw-jack`, and Uaithne links its outputs to the default output, or to `[tidal] output` in `uaithne.toml`. After switching devices, press **Re-link audio**.
- **Volume:** the global slider sets SuperCollider's volume too.
- **Crashes:** if GHCi, sclang or the SuperCollider server dies after starting, Uaithne restarts it (after 1, 3, then 9 s) and plays the patterns that were playing again, so a crash costs a few seconds of silence. More than three crashes in two minutes leave Tidal stopped with the error showing in the Tidal panel. The volume, sample library, audio link and MIDI output are restored with it; the tempo is replayed if a block set it with `setcps`/`setbpm`.
- **Settings:** `[tidal]` in `uaithne.toml` takes `ghci` (e.g. `"stack exec -- ghci"`), `boot_file` (your own BootTidal.hs), `sclang`, `port`, `output` and `highlight`.
- **Your own boot file:** to keep highlighting, copy these lines from Uaithne's `src-tauri/resources/tidal/BootTidal.hs`: the `Stringy` instance for `ID`, the `uaithneEditor` target, and the `startStream` call that sends to it. Keep `oPort = {{highlight_port}}` as written: Uaithne fills in the port when it boots your file.

## License

Copyright (C) 2026 Paul McMonagle

Uaithne is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; see [LICENSE](LICENSE) for details.

It builds on [Strudel](https://strudel.cc) (AGPL-3.0-or-later), which it bundles, and [TidalCycles](https://tidalcycles.org) and [SuperCollider](https://supercollider.github.io), which it runs. The reference data in `reference/` is generated from Strudel's documentation and from Tidal's documentation and source.
