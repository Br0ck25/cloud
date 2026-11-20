# Design system

Look: modern, quiet and sleek. Cool light-gray canvas, white rounded cards, one blue accent. Dark mode follows the phone's setting. All colors live in **one place**: the `:root` blocks at the top of `web/src/style.css`.

## Rules (a test enforces the first two)
1. No color literal (`#hex`, `rgb()`, `hsl()`) anywhere except those `:root` blocks. Use `var(--token)` in CSS; no colors in `.tsx`.
2. Every token used in the dark block also exists in the light block.
3. Need a new color? First try an existing token. If none fits, add one token to both blocks, document it here, then use it. Never use a one-off value.
4. Blue (`--brand`) is the only accent. It marks the one primary action on a screen and focus. Everything else is neutral. Red (`--danger`) is for errors only.
5. Check every UI change in light and dark, at phone width (390px).

## Tokens
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f4f6fb` | `#0c111b` | page background |
| `--surface` | `#fff` | `#151c2b` | cards, buttons, sheets |
| `--fg` | `#0f172a` | `#e7ebf4` | text |
| `--mut` | `#64748b` | `#93a0b8` | secondary text, icons |
| `--line` | `#e4e8f1` | `#232d42` | borders |
| `--brand` | `#2563eb` | `#3b82f6` | primary button, focus, progress |
| `--onbrand` | `#fff` | `#fff` | text on `--brand` |
| `--glow` | brand @30% | brand @30% | primary button shadow |
| `--tint` | `#e8f0fe` | `#1b2a4a` | icon tile background |
| `--danger` | `#dc2626` | `#f87171` | errors |
| `--scrim` | `#0009` | same | dimmer behind modals |
| `--shadow` / `--pop` | soft / strong | none / strong | card / floating menu shadow |
| `--r` | `16px` | same | corner radius for cards, buttons, sheets |

## Type and spacing
- System font (`system-ui`); titles 700 with slight negative tracking; names and buttons 600; secondary text `--mut` at .74-.9rem.
- Page gutter 16px; gap between cards 10px; minimum tap target 44px (rows 64px).
- Nested radii: tiles 12px, sheets `--r` + 4px, pills 99px.

## Components (reuse, do not restyle)
- **Card list** `.list li`: surface, 1px `--line` border, `--r`, `--shadow`. One row = tile + name + meta + actions.
- **Tile** `.tile`: 44px rounded square on `--tint`; holds an emoji icon or a thumbnail.
- **Buttons** `.btn`; add `.primary` for the single main action. Never two primaries in one view.
- **Floating menu** `.more` / `.menu` (native `<details>`), closes itself after any action.
- **Sheet** `.modal` + `.sheet`: for asking a short question (replaces `prompt()`). **Viewer** `.modal` + `.view`: full previews.
- **Picture grid** `.grid` > `.cell` > `.thumb` (`App.tsx`, `Photos.tsx`): square tiles, `object-fit: cover`, 4px gaps, 104px minimum width (3 columns on a phone). Files without a picture show their icon and name. Videos get a `.badge` ▶. Each tile in a folder has its ⋮ menu (`.over`); timeline tiles do not. A folder opens as a grid automatically when 60% or more of its files are photos or videos; the `.btn.sq` toggle next to the search box overrides it and is remembered on the device (`localStorage` key `view`).
- **Photos timeline** (`#/photos`, `Photos.tsx`): all photos and videos you can see, newest first by date taken, `.month` headings, 120 per page, loads more when `.end` scrolls into view.
- **Viewer** `.modal` + `.view` + `.stage` (`web/src/Viewer.tsx`): moves through the previewable files of the current list (folder or search results) by swipe (sideways, 50px, ignored on video/audio/PDF), arrow keys, or the `.nav` ‹ › buttons; shows "n / total". Esc closes.
- **Tools row** `.tools` under the search box: **Sort** `select`, the grid/list toggle, **Select**. Sort order is remembered on the device (`localStorage` key `sort`).
- **Selecting** (`useSelection`, `SelectBar`, `.check`, `.tick`, `.picked`): the **Select** button, or a long-press on a photo tile, starts it; the usual buttons and search hide and a sticky `.selbar` shows the count, **All** and the actions (Download, Move and Delete in folders and the timeline; Restore and Delete forever in Trash). Nothing in a selection is deleted for good without a `ConfirmSheet`. The shared Family folder itself cannot be picked.
- **Status rows** `.upload`: card with name and `<progress>` (accent follows `--brand`) or `.error` text.
- Empty states: centered `--mut` text, no card.
