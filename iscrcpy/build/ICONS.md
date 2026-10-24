# iscrcpy application icons

The blue tile follows the desktop UI's blue accent. A desktop display, upright phone
and mouse pointer represent mirroring and control. The exterior is transparent so
the same artwork works on light and dark desktop surfaces.

The master artwork was created with the built-in imagegen tool. Platform exports
are generated locally with Electron's image codecs; no image service is needed to
regenerate them.

## Assets

| File                                      | Purpose                                                   |
| ----------------------------------------- | --------------------------------------------------------- |
| `icon-source.png`                         | Original generated master, 1254 × 1254 with alpha         |
| `icon.png`                                | 1024 × 1024 PNG                                           |
| `icon.icns`                               | macOS, including Retina representations up to 1024 px     |
| `icon.ico`                                | Windows, 16 / 24 / 32 / 48 / 64 / 128 / 256 px            |
| `icons/NxN.png`                           | Linux, 16 / 24 / 32 / 48 / 64 / 128 / 256 / 512 / 1024 px |
| `../resources/icon.png`                   | 512 px window and development Dock icon                   |
| `../src/renderer/src/assets/app-icon.png` | 128 px sidebar, About and favicon asset                   |

After replacing `build/icon-source.png` with a square PNG of at least 1024 px, run
from the desktop project directory:

```sh
pnpm run icons:generate
```

The generated files are committed so normal builds do not require an export step.
Packaging explicitly selects the ICNS, ICO and Linux PNG set in
`electron-builder.yml`. Windows installer and uninstaller use the same ICO.
The renderer uses the same artwork in its sidebar, About view and favicon.
macOS development sets the Dock icon at startup; packaged macOS uses its bundle icon.

See the [electron-builder icon documentation](https://www.electron.build/v26/docs/features/icons-and-images/)
for platform packaging details.

## Original generation prompt

```text
Use case: logo-brand.
Asset type: production desktop application icon for iscrcpy, an iPhone screen mirroring and keyboard/mouse control utility.
Create ONE finished app icon, square canvas, front-facing and axis-aligned. A premium, restrained blue rounded-square tile on a truly transparent exterior, with generous clear margins (tile fills about 82% of canvas). A crisp white geometric symbol combines a large landscape desktop display behind an upright phone toward its left-center, plus a small unmistakable mouse-pointer arrow at the lower right. The display and phone use broad, consistent rounded strokes and clean negative space; avoid tiny details. The phone should feel like a phone through its tall proportions, with at most a simple short earpiece. Give the mouse cursor a blue separation gap where it overlaps the screen symbol so all three silhouettes read at 32px.
Visual style: meticulously crafted macOS app icon, mostly vector-clean geometry, subtly dimensional tile, restrained soft bevel and soft grounding shadow, smooth luminous cobalt-to-azure blue finish. White symbol can have a very subtle soft depth but must remain crisp, simple, high contrast and almost flat. Established UI uses blue #228be6.
Composition: centered optically, harmonious spacing, bold recognizable silhouette. Tile around 840x840 on a 1024x1024 transparent canvas with about 90px empty margins.
Constraints: exactly one icon, no icon grid, no mockup scene, no words or letters, no Apple logo, no watermarks, no decorative particles, no glass transparency in the white symbol, no dark surround, no extra badges. True alpha transparency outside the blue tile and its subtle shadow.
```
