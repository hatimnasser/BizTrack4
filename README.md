# BizTrack Pro — App Icons

Place your app icons here. Required sizes for full PWA + Android support:

| File            | Size      | Used For                           |
|-----------------|-----------|------------------------------------|
| icon-72.png     | 72×72     | Android home screen (legacy)       |
| icon-96.png     | 96×96     | Android home screen                |
| icon-128.png    | 128×128   | Chrome Web Store                   |
| icon-144.png    | 144×144   | Windows tile / IE                  |
| icon-152.png    | 152×152   | iOS iPad home screen               |
| icon-192.png    | 192×192   | Android Chrome (required)          |
| icon-384.png    | 384×384   | Android splash                     |
| icon-512.png    | 512×512   | Android/Chrome install (required)  |

## Quick Generation

If you have a 512×512 source PNG, install `sharp-cli` to generate all sizes:

```bash
npm install -g sharp-cli
for size in 72 96 128 144 152 192 384 512; do
  sharp -i source-512.png -o icon-${size}.png resize ${size}
done
```

Or use https://realfavicongenerator.net for a complete icon set.

The manifest.json and SW are already configured to reference these paths.
